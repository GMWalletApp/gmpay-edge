import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	verifyEpaySignature,
	verifyGmpaySignature,
} from "#/features/api-keys/server/gmpay-signature";
import { loadAdminWebhookDelivery } from "#/features/webhooks/server/admin-detail";
import {
	processWebhookMessage,
	redactResponseExcerpt,
	type WebhookQueueMessageLike,
} from "#/features/webhooks/server/consumer";
import { recoverWebhookOutbox } from "#/features/webhooks/server/outbox";
import {
	claimManualWebhookRetry,
	completeManualWebhookRetry,
	releaseManualWebhookRetry,
} from "#/features/webhooks/server/retry";
import type { WebhookQueueMessage } from "#/features/webhooks/types";
import { encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

describe("Webhook queue consumer on D1", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-webhook-consumer" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});
	afterAll(async () => miniflare.dispose());

	it("redacts structured response secrets and never persists opaque response text", () => {
		expect(
			redactResponseExcerpt(
				JSON.stringify({ message: "failed", apiKey: "merchant-secret" }),
			),
		).toBe('{"message":"failed","apiKey":"[REDACTED]"}');
		expect(redactResponseExcerpt("token=merchant-secret")).toBe(
			"[REDACTED_UNPARSEABLE]",
		);
	});

	it("records a failed attempt, schedules backoff, then succeeds", async () => {
		const first = fakeMessage("delivery-retry", 1);
		await processWebhookMessage(
			db,
			first.message,
			vi.fn().mockResolvedValue(
				new Response("no", {
					status: 500,
					headers: { "retry-after": "45" },
				}),
			),
		);
		expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 45 });
		expect(first.ack).not.toHaveBeenCalled();
		await expect(delivery(db, "delivery-retry")).resolves.toMatchObject({
			status: "failed",
			attempt_count: 1,
		});

		const second = fakeMessage("delivery-retry", 2);
		await processWebhookMessage(
			db,
			second.message,
			vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
		);
		expect(second.ack).toHaveBeenCalledOnce();
		expect(second.retry).not.toHaveBeenCalled();
		await expect(delivery(db, "delivery-retry")).resolves.toMatchObject({
			status: "succeeded",
			attempt_count: 2,
			next_attempt_at: null,
		});
		const attempts = await db
			.prepare(
				"SELECT attempt, response_status, request_snapshot FROM webhook_attempts WHERE delivery_id = ? ORDER BY attempt",
			)
			.bind("delivery-retry")
			.all<{
				attempt: number;
				response_status: number;
				request_snapshot: string;
			}>();
		expect(
			attempts.results.map(({ attempt, response_status }) => ({
				attempt,
				response_status,
			})),
		).toEqual([
			{ attempt: 1, response_status: 500 },
			{ attempt: 2, response_status: 200 },
		]);
		for (const attempt of attempts.results) {
			const snapshot = JSON.parse(attempt.request_snapshot) as Record<
				string,
				unknown
			>;
			expect(snapshot).toMatchObject({
				method: "POST",
				body: { signature: "[REDACTED]" },
			});
			expect(JSON.stringify(snapshot)).not.toContain("secret");
		}
	});

	it("loads newest-first delivery diagnostics and rejects malformed snapshots", async () => {
		const now = Date.now();
		const validSnapshot = JSON.stringify({
			method: "POST",
			url: "https://callback.example/hook",
			headers: { "x-gmpay-signature": "[REDACTED]" },
			body: { status: "paid" },
			query: null,
		});
		await db.batch([
			db
				.prepare(
					"INSERT INTO webhook_events (id, order_id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-details', 'order-webhook', 'order.paid', 'event:details', '{\"status\":\"paid\"}', ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES ('delivery-details', 'event-details', 'order-webhook', 'api-key', 'succeeded', 3, ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT INTO webhook_attempts (id, delivery_id, attempt, request_id, response_status, duration_ms, error_code, response_excerpt, request_snapshot, attempted_at) VALUES ('attempt-details-1', 'delivery-details', 1, 'request-1', 500, 10, 'http_error', '{}', NULL, ?), ('attempt-details-2', 'delivery-details', 2, 'request-2', 500, 20, 'http_error', '{}', 'not-json', ?), ('attempt-details-3', 'delivery-details', 3, 'request-3', 204, 30, NULL, NULL, ?, ?)",
				)
				.bind(now, now + 1, validSnapshot, now + 2),
		]);

		const details = await loadAdminWebhookDelivery(db, "delivery-details");
		expect(details).toMatchObject({
			id: "delivery-details",
			protocol: "gmpay",
			order: { id: "order-webhook", externalOrderId: "webhook-order" },
			apiKey: { id: "api-key", name: "Test", pid: "gm_test" },
			event: { id: "event-details", payload: { status: "paid" } },
		});
		expect(details.attempts.map((attempt) => attempt.attempt)).toEqual([
			3, 2, 1,
		]);
		expect(details.attempts[0]?.requestSnapshot).toMatchObject({
			method: "POST",
			body: { status: "paid" },
		});
		expect(details.attempts[1]?.requestSnapshot).toBeNull();
		expect(details.attempts[2]?.requestSnapshot).toBeNull();
	});

	it("resolves GMPay order context and delivers a signed readable-status callback", async () => {
		const queued = fakeMessage("delivery-gmpay", 1);
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("ok", { status: 200 }));
		await processWebhookMessage(db, queued.message, fetcher);
		expect(queued.ack).toHaveBeenCalledOnce();
		const [, init] = fetcher.mock.calls[0] ?? [];
		const body = JSON.parse(String(init?.body)) as Record<
			string,
			string | number
		>;
		expect(body).toMatchObject({
			pid: "gm_test",
			trade_id: "order-gmpay",
			order_id: "gmpay-order",
			amount: "12.5",
			actual_amount: "0",
			status: "paid",
		});
		expect(Object.keys(body).sort()).toEqual(
			[
				"pid",
				"trade_id",
				"order_id",
				"amount",
				"actual_amount",
				"receive_address",
				"token",
				"block_transaction_id",
				"status",
				"signature",
			].sort(),
		);
		expect(verifyGmpaySignature(body, "secret", String(body.signature))).toBe(
			true,
		);
	});

	it("resolves EPay order context into a signed compatibility callback", async () => {
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					`INSERT INTO orders
					 (id, external_order_id, api_key_id, api_protocol, status, amount_minor,
					  currency, currency_decimals, received_amount_units, description, notify_url, metadata,
					  expires_at, version, created_at, updated_at)
					 VALUES ('order-epay', 'epay-order', 'api-key', 'epay', 'paid', '1250',
					  'CNY', 2, '0', 'Invoice', 'https://callback.example/epay',
					  '{"integration":"epay","epayType":"usdt.tron","epayParam":"merchant-context"}', ?, 0, ?, ?)`,
				)
				.bind(now + 60_000, now, now),
			db
				.prepare(
					"INSERT INTO webhook_events (id, order_id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-epay', 'order-epay', 'order.paid', 'event:epay', '{}', ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES ('delivery-epay', 'event-epay', 'order-epay', 'api-key', 'queued', 0, ?, ?)",
				)
				.bind(now, now),
		]);
		const queued = fakeMessage("delivery-epay", 1);
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("ok", { status: 200 }));
		await processWebhookMessage(db, queued.message, fetcher);
		expect(queued.ack).toHaveBeenCalledOnce();
		const [target, init] = fetcher.mock.calls[0] ?? [];
		const url = new URL(String(target));
		expect(init?.method).toBe("GET");
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			pid: "gm_test",
			trade_no: "order-epay",
			out_trade_no: "epay-order",
			type: "usdt.tron",
			name: "Invoice",
			money: "12.5",
			trade_status: "TRADE_SUCCESS",
			param: "merchant-context",
			sign_type: "MD5",
		});
		const signed = Object.fromEntries(url.searchParams);
		expect(Object.keys(signed).sort()).toEqual(
			[
				"pid",
				"trade_no",
				"out_trade_no",
				"type",
				"name",
				"money",
				"trade_status",
				"param",
				"sign",
				"sign_type",
			].sort(),
		);
		expect(
			verifyEpaySignature(
				signed,
				"secret",
				String(signed.sign),
				new Set(["sign", "sign_type"]),
			),
		).toBe(true);
	});

	it("uses D1 application attempts beyond a single Cloudflare message retry", async () => {
		const first = fakeMessage("delivery-app-retry", 1);
		const send = vi.fn().mockResolvedValue(undefined);
		await processWebhookMessage(
			db,
			first.message,
			vi.fn().mockResolvedValue(new Response("no", { status: 500 })),
			{ send } as unknown as Pick<Queue<WebhookQueueMessage>, "send">,
		);
		expect(first.ack).toHaveBeenCalledOnce();
		expect(first.retry).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledWith(
			{
				kind: "webhook.delivery",
				version: 1,
				deliveryId: "delivery-app-retry",
				eventId: "event-app-retry",
				attempt: 2,
			},
			{ delaySeconds: 15 },
		);
		await expect(delivery(db, "delivery-app-retry")).resolves.toMatchObject({
			status: "failed",
			attempt_count: 1,
		});

		const second = fakeMessage("delivery-app-retry", 1);
		second.message.body.attempt = 2;
		await processWebhookMessage(
			db,
			second.message,
			vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
			{ send } as unknown as Pick<Queue<WebhookQueueMessage>, "send">,
		);
		expect(second.ack).toHaveBeenCalledOnce();
		await expect(delivery(db, "delivery-app-retry")).resolves.toMatchObject({
			status: "succeeded",
			attempt_count: 2,
		});
	});

	it("keeps a failed delivery due in D1 when the follow-up Queue send fails", async () => {
		const queued = fakeMessage("delivery-queue-send-failure", 1);
		const send = vi.fn().mockRejectedValue(new Error("Queue unavailable"));
		const startedAt = Date.now();
		await processWebhookMessage(
			db,
			queued.message,
			vi.fn().mockResolvedValue(new Response("failure", { status: 500 })),
			{ send } as unknown as Pick<Queue<WebhookQueueMessage>, "send">,
		);

		expect(send).toHaveBeenCalledOnce();
		expect(queued.ack).toHaveBeenCalledOnce();
		expect(queued.retry).not.toHaveBeenCalled();
		const current = await delivery(db, "delivery-queue-send-failure");
		expect(current).toMatchObject({ status: "failed", attempt_count: 1 });
		expect(Number(current?.next_attempt_at)).toBeGreaterThanOrEqual(
			startedAt + 15_000,
		);
		expect(Number(current?.next_attempt_at)).toBeLessThan(
			startedAt + 5 * 60_000,
		);
	});

	it("moves the eighth failed attempt to dead letter state", async () => {
		const last = fakeMessage("delivery-dead", 8);
		await processWebhookMessage(
			db,
			last.message,
			vi.fn().mockResolvedValue(new Response("still failing", { status: 503 })),
		);
		expect(last.ack).toHaveBeenCalledOnce();
		expect(last.retry).not.toHaveBeenCalled();
		await expect(delivery(db, "delivery-dead")).resolves.toMatchObject({
			status: "dead",
			attempt_count: 8,
			next_attempt_at: null,
		});
	});

	it("uses the configured maximum attempt count", async () => {
		await db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('webhooks.max_attempts', '2', 0, 0, 0)",
			)
			.run();
		const last = fakeMessage("delivery-configured-dead", 2);
		await processWebhookMessage(
			db,
			last.message,
			vi.fn().mockResolvedValue(new Response("failure", { status: 500 })),
		);
		expect(last.ack).toHaveBeenCalledOnce();
		expect(last.retry).not.toHaveBeenCalled();
		await expect(
			delivery(db, "delivery-configured-dead"),
		).resolves.toMatchObject({ status: "dead", attempt_count: 2 });
	});

	it("can continue application retries beyond the Cloudflare retry limit", async () => {
		await db
			.prepare(
				"UPDATE system_settings SET value = '12' WHERE key = 'webhooks.max_attempts'",
			)
			.run();
		const ninth = fakeMessage("delivery-high-attempt", 1);
		ninth.message.body.attempt = 9;
		const send = vi.fn().mockResolvedValue(undefined);
		await processWebhookMessage(
			db,
			ninth.message,
			vi.fn().mockResolvedValue(new Response("failure", { status: 500 })),
			{ send } as unknown as Pick<Queue<WebhookQueueMessage>, "send">,
		);
		expect(ninth.ack).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledWith(
			{
				kind: "webhook.delivery",
				version: 1,
				deliveryId: "delivery-high-attempt",
				eventId: "event-high-attempt",
				attempt: 10,
			},
			{ delaySeconds: 3600 },
		);
		await expect(delivery(db, "delivery-high-attempt")).resolves.toMatchObject({
			status: "failed",
			attempt_count: 9,
		});
	});

	it("allows only one concurrent worker to deliver the same attempt", async () => {
		const first = fakeMessage("delivery-concurrent", 1);
		const duplicate = fakeMessage("delivery-concurrent", 1);
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response("ok", { status: 200 }));
		await Promise.all([
			processWebhookMessage(db, first.message, fetcher),
			processWebhookMessage(db, duplicate.message, fetcher),
		]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		await expect(delivery(db, "delivery-concurrent")).resolves.toMatchObject({
			status: "succeeded",
			attempt_count: 1,
		});
	});

	it("atomically claims and can recover a manual retry", async () => {
		const claims = await Promise.all([
			claimManualWebhookRetry(db, "delivery-manual", -101),
			claimManualWebhookRetry(db, "delivery-manual", -202),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		const token = claims[0] ? -101 : -202;
		await releaseManualWebhookRetry(db, "delivery-manual", token, {
			status: "failed",
			attemptCount: 3,
		});
		await expect(delivery(db, "delivery-manual")).resolves.toMatchObject({
			status: "failed",
			attempt_count: 3,
		});
		await expect(
			claimManualWebhookRetry(db, "delivery-manual", -303),
		).resolves.toBe(true);
		await completeManualWebhookRetry(db, "delivery-manual", -303);
		await expect(delivery(db, "delivery-manual")).resolves.toMatchObject({
			status: "queued",
			attempt_count: 0,
		});
	});

	it("recovers persisted queued deliveries without putting secrets in Queue", async () => {
		await db
			.prepare(
				"UPDATE webhook_deliveries SET status = 'dead' WHERE id = 'delivery-manual'",
			)
			.run();
		const send = vi.fn().mockResolvedValue(undefined);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		let recoveryRecord: Record<string, unknown> | undefined;
		try {
			await expect(
				recoverWebhookOutbox(
					{ DB: db, WEBHOOK_QUEUE: { send } } as unknown as Pick<
						Env,
						"DB" | "WEBHOOK_QUEUE"
					>,
					Date.now(),
				),
			).resolves.toMatchObject({ queued: 2, failed: 0 });
			recoveryRecord = JSON.parse(String(info.mock.calls[0]?.[0]));
		} finally {
			info.mockRestore();
		}
		expect(recoveryRecord).toMatchObject({
			event: "webhook_outbox_recovered",
			selectedDeliveries: 2,
			queuedDeliveries: 2,
			queueFailedDeliveries: 0,
			maxApplicationAttempt: 3,
			oldestDeliveryAgeMs: expect.any(Number),
			outcome: "ok",
		});
		expect(send.mock.calls.map((call) => call[0])).toEqual(
			expect.arrayContaining([
				{
					kind: "webhook.delivery",
					version: 1,
					deliveryId: "delivery-outbox",
					eventId: "event-outbox",
					attempt: 1,
				},
				{
					kind: "webhook.delivery",
					version: 1,
					deliveryId: "delivery-outbox-failed",
					eventId: "event-outbox-failed",
					attempt: 4,
				},
			]),
		);
		const serialized = JSON.stringify(send.mock.calls);
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("merchant.example");
		await expect(delivery(db, "delivery-outbox")).resolves.toMatchObject({
			status: "queued",
			attempt_count: 0,
		});
	});

	it("leases an outbox row before sending so concurrent recovery queues once", async () => {
		await db
			.prepare(
				"UPDATE webhook_deliveries SET status = 'queued', next_attempt_at = NULL WHERE id = 'delivery-outbox'",
			)
			.run();
		const send = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		const env = {
			DB: db,
			WEBHOOK_QUEUE: { send },
		} as unknown as Pick<Env, "DB" | "WEBHOOK_QUEUE">;
		const [first, second] = await Promise.all([
			recoverWebhookOutbox(env, Date.now()),
			recoverWebhookOutbox(env, Date.now()),
		]);
		expect(first.queued + second.queued).toBe(1);
		expect(send).toHaveBeenCalledOnce();
	});

	it("refuses unsafe stored endpoint URLs before calling fetch", async () => {
		await db
			.prepare(
				"UPDATE webhook_deliveries SET status = 'queued' WHERE id = 'delivery-unsafe'",
			)
			.run();
		const queued = fakeMessage("delivery-unsafe", 1);
		const fetcher = vi.fn();
		await processWebhookMessage(db, queued.message, fetcher);
		expect(fetcher).not.toHaveBeenCalled();
		expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
		await expect(delivery(db, "delivery-unsafe")).resolves.toMatchObject({
			status: "failed",
			attempt_count: 1,
		});
		const attempt = await db
			.prepare(
				"SELECT request_snapshot FROM webhook_attempts WHERE delivery_id = ?",
			)
			.bind("delivery-unsafe")
			.first<{ request_snapshot: string | null }>();
		expect(attempt?.request_snapshot).toBeNull();
	});
});

function fakeMessage(deliveryId: string, attempts: number) {
	const ack = vi.fn();
	const retry = vi.fn();
	const body: WebhookQueueMessage = {
		kind: "webhook.delivery",
		version: 1,
		deliveryId,
		eventId:
			{
				"delivery-dead": "event-dead",
				"delivery-configured-dead": "event-configured-dead",
				"delivery-concurrent": "event-concurrent",
				"delivery-app-retry": "event-app-retry",
				"delivery-queue-send-failure": "event-queue-send-failure",
				"delivery-high-attempt": "event-high-attempt",
				"delivery-manual": "event-manual",
				"delivery-unsafe": "event-unsafe",
				"delivery-gmpay": "event-gmpay",
				"delivery-epay": "event-epay",
			}[deliveryId] ?? "event",
		attempt: attempts,
	};
	return {
		ack,
		retry,
		message: {
			body,
			attempts,
			id: `request-${deliveryId}-${attempts}`,
			ack,
			retry,
		} satisfies WebhookQueueMessageLike,
	};
}

async function delivery(db: D1Database, id: string) {
	return db
		.prepare(
			"SELECT status, attempt_count, next_attempt_at, completed_at FROM webhook_deliveries WHERE id = ?",
		)
		.bind(id)
		.first<Record<string, string | number | null>>();
}

async function seed(db: D1Database) {
	const now = Date.now();
	const encryptedSecret = await encryptSecret("secret", "test-api-pepper");
	await db.batch([
		db
			.prepare(
				"INSERT INTO api_keys (id, name, pid, secret_encrypted, scopes, created_at, updated_at) VALUES ('api-key', 'Test', 'gm_test', ?, '[\"orders:create\"]', ?, ?)",
			)
			.bind(encryptedSecret, now, now),
		db
			.prepare(
				"INSERT INTO orders (id, external_order_id, api_key_id, api_protocol, status, amount_minor, currency, currency_decimals, received_amount_units, notify_url, expires_at, version, created_at, updated_at) VALUES ('order-webhook', 'webhook-order', 'api-key', 'gmpay', 'paid', '100', 'USD', 2, '0', 'https://callback.example/hook', ?, 0, ?, ?), ('order-unsafe', 'unsafe-order', 'api-key', 'gmpay', 'paid', '100', 'USD', 2, '0', 'https://169.254.169.254/latest/meta-data', ?, 0, ?, ?), ('order-gmpay', 'gmpay-order', 'api-key', 'gmpay', 'paid', '1250', 'USD', 2, '0', 'https://callback.example/gmpay', ?, 0, ?, ?)",
			)
			.bind(
				now + 60_000,
				now,
				now,
				now + 60_000,
				now,
				now,
				now + 60_000,
				now,
				now,
			),
		db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.api_key_pepper', ?, 1, ?, ?)",
			)
			.bind(JSON.stringify("test-api-pepper"), now, now),
		db
			.prepare(
				"INSERT INTO webhook_events (id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event', 'order.paid', 'event:paid', '{}', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_events (id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-dead', 'order.failed', 'event:failed', '{}', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_events (id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-configured-dead', 'order.failed', 'event:configured-failed', '{}', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_events (id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-concurrent', 'order.paid', 'event:concurrent', '{}', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_events (id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-app-retry', 'order.paid', 'event:app-retry', '{}', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_events (id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-queue-send-failure', 'order.paid', 'event:queue-send-failure', '{}', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_events (id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-high-attempt', 'order.failed', 'event:high-attempt', '{}', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_events (id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-manual', 'order.paid', 'event:manual', '{}', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_events (id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-outbox', 'order.paid', 'event:outbox', '{}', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_events (id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-outbox-failed', 'order.paid', 'event:outbox-failed', '{}', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_events (id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-unsafe', 'order.paid', 'event:unsafe', '{}', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_events (id, order_id, type, deduplication_key, payload, created_at, updated_at) VALUES ('event-gmpay', 'order-gmpay', 'order.paid', 'event:gmpay', '{\"transaction\":{\"hash\":\"tx-gmpay\"}}', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES ('delivery-retry', 'event', 'order-webhook', 'api-key', 'queued', 0, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES ('delivery-dead', 'event-dead', 'order-webhook', 'api-key', 'queued', 0, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES ('delivery-configured-dead', 'event-configured-dead', 'order-webhook', 'api-key', 'queued', 0, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES ('delivery-concurrent', 'event-concurrent', 'order-webhook', 'api-key', 'queued', 0, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES ('delivery-app-retry', 'event-app-retry', 'order-webhook', 'api-key', 'queued', 0, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES ('delivery-queue-send-failure', 'event-queue-send-failure', 'order-webhook', 'api-key', 'queued', 0, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, next_attempt_at, created_at, updated_at) VALUES ('delivery-high-attempt', 'event-high-attempt', 'order-webhook', 'api-key', 'failed', 8, 0, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES ('delivery-manual', 'event-manual', 'order-webhook', 'api-key', 'failed', 3, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES ('delivery-outbox', 'event-outbox', 'order-webhook', 'api-key', 'queued', 0, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, next_attempt_at, created_at, updated_at) VALUES ('delivery-outbox-failed', 'event-outbox-failed', 'order-webhook', 'api-key', 'failed', 3, 0, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES ('delivery-unsafe', 'event-unsafe', 'order-unsafe', 'api-key', 'dead', 0, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES ('delivery-gmpay', 'event-gmpay', 'order-gmpay', 'api-key', 'queued', 0, ?, ?)",
			)
			.bind(now, now),
	]);
}
