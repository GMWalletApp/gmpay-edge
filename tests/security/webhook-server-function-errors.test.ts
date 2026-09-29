import { readFile } from "node:fs/promises";
import { toCrossJSONAsync } from "seroval";
import { describe, expect, it } from "vitest";

import { webhookOperationErrorMessage } from "#/features/webhooks/error-message";
import { requireRetryableWebhookDelivery } from "#/features/webhooks/server/retry";
import { DomainError } from "#/lib/domain-error";
import { m } from "#/paraglide/messages";
import {
	normalizeServerFunctionError,
	ServerFunctionError,
} from "#/server/server-function-errors";

const request = new Request("https://example.com/_serverFn/webhook-retry");

const now = 1_000;

describe("Webhook Server Function error contract", () => {
	it.each([
		[null, "webhook_delivery_not_found", 404],
		[
			{ status: "queued", next_attempt_at: null },
			"webhook_delivery_not_retryable",
			409,
		],
		[
			{ status: "succeeded", next_attempt_at: null },
			"webhook_delivery_not_retryable",
			409,
		],
		// A scheduled automatic attempt or an active consumer lease is in progress.
		[
			{ status: "failed", next_attempt_at: now + 1 },
			"webhook_delivery_retry_in_progress",
			409,
		],
		[
			{ status: "delivering", next_attempt_at: now + 1 },
			"webhook_delivery_retry_in_progress",
			409,
		],
	] as const)("maps retry state to %s without exposing persistence errors", (delivery, code, status) => {
		let error: unknown;
		try {
			requireRetryableWebhookDelivery(delivery, now);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(DomainError);
		expect(normalizeServerFunctionError(error, request)).toMatchObject({
			code,
			status,
		});
	});

	it.each([
		{ status: "failed", next_attempt_at: null },
		{ status: "failed", next_attempt_at: now },
		{ status: "dead", next_attempt_at: null },
		// A stranded delivery whose consumer lease expired.
		{ status: "delivering", next_attempt_at: now - 1 },
	])("accepts the retryable state %j", (delivery) => {
		expect(() =>
			requireRetryableWebhookDelivery({ id: "delivery", ...delivery }, now),
		).not.toThrow();
	});

	it.each([
		[
			"webhook_inbound_receipt_not_found",
			m.webhooks_error_inbound_receipt_not_found(),
		],
		["webhook_inbound_unavailable", m.webhooks_error_inbound_unavailable()],
		["webhook_queue_unavailable", m.webhooks_error_queue_unavailable()],
		["webhook_delivery_not_found", m.webhooks_error_delivery_not_found()],
		[
			"webhook_delivery_not_retryable",
			m.webhooks_error_delivery_not_retryable(),
		],
		[
			"webhook_delivery_retry_in_progress",
			m.webhooks_error_delivery_retry_in_progress(),
		],
	] as const)("maps reviewed code %s to localized copy", (code, message) => {
		expect(
			webhookOperationErrorMessage(new ServerFunctionError(code, 409, code)),
		).toBe(message);
	});

	it("hides unknown error messages from the toast", () => {
		expect(
			webhookOperationErrorMessage(
				new Error("D1_ERROR: SELECT secret FROM webhook_deliveries"),
			),
		).toBe(m.webhooks_operation_failed());
	});

	it("preserves the reviewed code without serializing a stack", async () => {
		const normalized = normalizeServerFunctionError(
			new DomainError(
				"webhook_delivery_retry_in_progress",
				409,
				"Webhook delivery retry is already in progress",
			),
			request,
		);
		const serialized = JSON.stringify(
			await toCrossJSONAsync(normalized, { refs: new Map(), plugins: [] }),
		);

		expect(serialized).toContain("webhook_delivery_retry_in_progress");
		expect(serialized).not.toMatch(/stack|SELECT|secret/);
	});

	it("uses stable inbound and queue failure codes in the admin boundary", async () => {
		const source = (
			await Promise.all([
				readFile(
					new URL(
						"../../src/features/webhooks/server/admin.ts",
						import.meta.url,
					),
					"utf8",
				),
				readFile(
					new URL(
						"../../src/features/webhooks/server/inbound-admin.ts",
						import.meta.url,
					),
					"utf8",
				),
			])
		).join("\n");

		for (const code of [
			"webhook_inbound_receipt_not_found",
			"webhook_inbound_unavailable",
			"webhook_queue_unavailable",
		])
			expect(source).toContain(`"${code}"`);
		expect(source).not.toContain(
			'throw new Error("Webhook queue binding is unavailable")',
		);
	});
});
