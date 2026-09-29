import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentScanMessage } from "#/features/payments/types";
import type { WebhookQueueMessage } from "#/features/webhooks/types";

const queueMocks = vi.hoisted(() => ({
	loadOperationalSettings: vi.fn(),
	loadRuntimeConfig: vi.fn(),
	processPayment: vi.fn(),
	processWebhook: vi.fn(),
}));

vi.mock("#/server/operational-settings", () => ({
	loadOperationalSettings: queueMocks.loadOperationalSettings,
}));
vi.mock("#/server/runtime-config", () => ({
	loadRuntimeConfig: queueMocks.loadRuntimeConfig,
}));
vi.mock("#/server/queue/payment-scan", () => ({
	handlePaymentScan: queueMocks.processPayment,
}));
vi.mock("#/features/webhooks/server/consumer", () => ({
	processWebhookMessage: queueMocks.processWebhook,
}));

import { handleQueue } from "#/server/queue/routing";

const execution = {
	active: 0,
	delayMs: 0,
	failId: "",
	maximum: 0,
	adapterCaches: new Set<unknown>(),
};

describe("Queue invocation backpressure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		execution.active = 0;
		execution.delayMs = 0;
		execution.failId = "";
		execution.maximum = 0;
		execution.adapterCaches.clear();
		queueMocks.loadOperationalSettings.mockResolvedValue({});
		queueMocks.loadRuntimeConfig.mockResolvedValue({});
		queueMocks.processPayment.mockImplementation(
			async (
				message: Message<PaymentScanMessage>,
				_env: Env,
				_runtime: unknown,
				adapterCache: Map<string, unknown>,
			) => {
				execution.adapterCaches.add(adapterCache);
				await simulateWork(message.id);
				message.ack();
			},
		);
		queueMocks.processWebhook.mockImplementation(
			async (_db: D1Database, message: Message<WebhookQueueMessage>) => {
				await simulateWork(message.id);
				message.ack();
			},
		);
	});

	it.each([
		["gmpay-edge-payments", "payment", 1, 1],
		["gmpay-edge-payments", "payment", 10, 2],
		["gmpay-edge-webhooks", "webhook", 1, 1],
		["gmpay-edge-webhooks", "webhook", 10, 5],
	] as const)("bounds %s %s traffic with %i messages at %i active consumers", async (queue, kind, count, expectedPeak) => {
		execution.delayMs = 5;
		const messages = Array.from({ length: count }, (_, index) =>
			kind === "payment" ? paymentMessage(index) : webhookMessage(index),
		);

		await handleQueue(
			{ queue, messages } as unknown as Parameters<typeof handleQueue>[0],
			{ DB: {} as D1Database } as Env,
		);

		expect(execution.maximum).toBe(expectedPeak);
		expect(messages.every(({ ack }) => ack.mock.calls.length === 1)).toBe(true);
		expect(queueMocks.loadRuntimeConfig).toHaveBeenCalledOnce();
		expect(queueMocks.loadOperationalSettings).toHaveBeenCalledTimes(
			kind === "webhook" ? 1 : 0,
		);
		if (kind === "payment") expect(execution.adapterCaches.size).toBe(1);
	});

	it("merges a duplicate payment burst and propagates one retry to every original message", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const messages = Array.from({ length: 10 }, (_, index) =>
			paymentMessage(index, "same-order", "same-method"),
		);
		queueMocks.processPayment.mockImplementation(
			async (message: Message<PaymentScanMessage>) => message.retry(),
		);

		try {
			await handleQueue(
				{
					queue: "gmpay-edge-payments",
					messages,
				} as unknown as Parameters<typeof handleQueue>[0],
				{ DB: {} as D1Database } as Env,
			);

			expect(queueMocks.processPayment).toHaveBeenCalledOnce();
			expect(messages.every(({ retry }) => retry.mock.calls.length === 1)).toBe(
				true,
			);
			const record = JSON.parse(String(info.mock.calls[0]?.[0]));
			expect(record).toMatchObject({
				batchSize: 10,
				processedMessages: 1,
				dedupeCount: 9,
				ackedMessages: 0,
				retriedMessages: 1,
				failedMessages: 0,
				outcome: "ok",
			});
		} finally {
			info.mockRestore();
		}
	});

	it("isolates a slow consumer failure and continues later Webhook slices", async () => {
		execution.delayMs = 8;
		execution.failId = "webhook-1";
		const messages = Array.from({ length: 10 }, (_, index) =>
			webhookMessage(index, Date.now() - 200),
		);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		try {
			await handleQueue(
				{
					queue: "gmpay-edge-webhooks",
					messages,
				} as unknown as Parameters<typeof handleQueue>[0],
				{ DB: {} as D1Database } as Env,
			);

			expect(queueMocks.processWebhook).toHaveBeenCalledTimes(10);
			expect(execution.maximum).toBe(5);
			expect(messages[1]?.retry).toHaveBeenCalledOnce();
			expect(messages[1]?.ack).not.toHaveBeenCalled();
			expect(messages[9]?.ack).toHaveBeenCalledOnce();
			const record = JSON.parse(String(info.mock.calls[0]?.[0]));
			expect(record).toMatchObject({
				batchSize: 10,
				ackedMessages: 9,
				retriedMessages: 1,
				failedMessages: 1,
				retryReason: "consumer_error",
				outcome: "partial_failure",
			});
			expect(record.oldestMessageAgeMs).toBeGreaterThanOrEqual(190);
			expect(record.durationMs).toBeGreaterThanOrEqual(8);
			// The failure is identifiable without the body or the error text.
			expect(error).toHaveBeenCalledOnce();
			const failure = JSON.parse(String(error.mock.calls[0]?.[0]));
			expect(failure).toEqual({
				event: "queue_message_failed",
				invocationId: record.invocationId,
				queue: "gmpay-edge-webhooks",
				messageId: "webhook-1",
				kind: "webhook",
				errorName: "Error",
			});
			expect(String(error.mock.calls[0]?.[0])).not.toContain("delivery-1");
			expect(String(error.mock.calls[0]?.[0])).not.toContain(
				"deterministic consumer failure",
			);
		} finally {
			info.mockRestore();
			error.mockRestore();
		}
	});

	it("shares one slow failed D1 configuration read while retrying each affected payment", async () => {
		queueMocks.loadRuntimeConfig.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 8));
			throw new Error("D1 unavailable");
		});
		const messages = Array.from({ length: 6 }, (_, index) =>
			paymentMessage(index),
		);

		await handleQueue(
			{
				queue: "gmpay-edge-payments",
				messages,
			} as unknown as Parameters<typeof handleQueue>[0],
			{ DB: {} as D1Database } as Env,
		);

		expect(queueMocks.loadRuntimeConfig).toHaveBeenCalledOnce();
		expect(queueMocks.processPayment).not.toHaveBeenCalled();
		expect(messages.every(({ retry }) => retry.mock.calls.length === 1)).toBe(
			true,
		);
	});
});

async function simulateWork(id: string) {
	execution.active += 1;
	execution.maximum = Math.max(execution.maximum, execution.active);
	try {
		if (execution.delayMs)
			await new Promise((resolve) => setTimeout(resolve, execution.delayMs));
		if (id === execution.failId)
			throw new Error("deterministic consumer failure");
	} finally {
		execution.active -= 1;
	}
}

function paymentMessage(
	index: number,
	orderId?: string,
	receivingMethodId?: string,
) {
	const ack = vi.fn();
	const retry = vi.fn();
	return {
		id: `payment-${index}`,
		timestamp: new Date(),
		attempts: 1,
		body: {
			kind: "payment.scan" as const,
			version: 1 as const,
			orderId: orderId ?? `order-${index}`,
			receivingMethodId: receivingMethodId ?? `method-${index % 2}`,
		},
		ack,
		retry,
	};
}

function webhookMessage(index: number, timestamp = Date.now()) {
	const ack = vi.fn();
	const retry = vi.fn();
	return {
		id: `webhook-${index}`,
		timestamp: new Date(timestamp),
		attempts: 1,
		body: {
			kind: "webhook.delivery" as const,
			version: 1 as const,
			deliveryId: `delivery-${index}`,
			eventId: `event-${index}`,
			attempt: 1,
		},
		ack,
		retry,
	};
}
