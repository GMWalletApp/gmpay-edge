import { createHmac } from "node:crypto";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleAlchemyAddressActivity } from "#/features/payments/server/alchemy-webhook";
import { encryptSecret } from "#/lib/secrets";
import fixture from "../fixtures/providers/alchemy-address-activity.json";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

const sourceId = "11111111-1111-4111-8111-111111111111";
const signingKey = "alchemy-signing-key-for-integration-tests";
const configSecret = "integration-config-secret";

describe("Alchemy address activity ingress", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-alchemy-webhook" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.integration_config_secret', ?, 1, ?, ?)",
				)
				.bind(JSON.stringify(configSecret), now, now),
			db
				.prepare(
					`INSERT INTO payment_ingresses
					 (id, name, type, transport, provider, network, external_network, external_source_id,
					  config_encrypted, mode, enabled, created_at, updated_at)
					 VALUES (?, 'Payment event push', 'provider_webhook', 'webhook', 'alchemy', 'ethereum', 'ETH_MAINNET', ?, ?, 'shadow', 1, ?, ?)`,
				)
				.bind(
					sourceId,
					fixture.webhookId,
					await encryptSecret(JSON.stringify({ signingKey }), configSecret),
					now,
					now,
				),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it("rejects an oversized provider payload", async () => {
		const response = await handleAlchemyAddressActivity(
			new Request("https://pay.example/api/webhooks/payments/alchemy", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": String(2 * 1024 * 1024 + 1),
				},
				body: "{}",
			}),
			sourceId,
			{ DB: db },
		);

		expect(response.status).toBe(413);
	});

	it("durably deduplicates an event before enqueueing its identifier", async () => {
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const first = await handleAlchemyAddressActivity(
			request(fixture, "request-alchemy-1"),
			sourceId,
			{ DB: db, PAYMENT_QUEUE: { sendBatch } as unknown as Queue },
		);
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ accepted: 1, queued: 1 });
		expect(sendBatch).toHaveBeenCalledWith([
			{
				body: {
					kind: "payment.provider_event",
					version: 1,
					eventId: expect.any(String),
				},
			},
		]);

		const duplicate = await handleAlchemyAddressActivity(
			request(fixture, "request-alchemy-2"),
			sourceId,
			{ DB: db, PAYMENT_QUEUE: { sendBatch } as unknown as Queue },
		);
		expect(await duplicate.json()).toEqual({ accepted: 1, queued: 0 });
		expect(sendBatch).toHaveBeenCalledTimes(1);

		const state = await db
			.prepare(`SELECT
			 (SELECT COUNT(*) FROM inbound_provider_events) AS events,
			 (SELECT status FROM inbound_provider_events LIMIT 1) AS status,
			 (SELECT ingest_mode FROM inbound_provider_events LIMIT 1) AS ingest_mode,
			 (SELECT COUNT(*) FROM inbound_webhook_receipts
			  WHERE endpoint_code = 'alchemy.address_activity' AND signature_status = 'valid') AS receipts`)
			.first<{
				events: number;
				status: string;
				ingest_mode: string;
				receipts: number;
			}>();
		expect(state).toEqual({
			events: 1,
			status: "queued",
			ingest_mode: "shadow",
			receipts: 2,
		});
	});

	it("returns success after D1 persistence when Queue is unavailable", async () => {
		const payload = structuredClone(fixture);
		payload.id = "whevt_queue_unavailable";
		const [activity] = payload.event.activity;
		if (!activity) throw new Error("Expected Alchemy activity fixture");
		activity.hash =
			"0x8a4a39da2a3fa1fc2ef88fd1eaea070286ed2aba21e0419dcfb6d5c5d9f02a72";
		const response = await handleAlchemyAddressActivity(
			request(payload, "request-alchemy-queue-down"),
			sourceId,
			{ DB: db },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: 1, queued: 0 });
		const event = await db
			.prepare(
				"SELECT status FROM inbound_provider_events WHERE provider_event_id = ?",
			)
			.bind(payload.id)
			.first<{ status: string }>();
		expect(event?.status).toBe("received");
	});

	it("accepts out-of-order provider timestamps and records delivery delay", async () => {
		const baseline = Date.now();
		const newer = structuredClone(fixture);
		newer.id = "whevt_out_of_order_newer";
		newer.createdAt = new Date(baseline - 5_000).toISOString();
		const [newerActivity] = newer.event.activity;
		if (!newerActivity) throw new Error("Expected Alchemy activity fixture");
		newerActivity.hash = `0x${"11".repeat(32)}`;
		const older = structuredClone(fixture);
		older.id = "whevt_out_of_order_older";
		older.createdAt = new Date(baseline - 120_000).toISOString();
		const [olderActivity] = older.event.activity;
		if (!olderActivity) throw new Error("Expected Alchemy activity fixture");
		olderActivity.hash = `0x${"22".repeat(32)}`;
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		let records: Array<Record<string, unknown>> = [];
		try {
			await handleAlchemyAddressActivity(
				request(newer, "request-alchemy-out-of-order-newer"),
				sourceId,
				{ DB: db, PAYMENT_QUEUE: { sendBatch } as unknown as Queue },
			);
			await handleAlchemyAddressActivity(
				request(older, "request-alchemy-out-of-order-older"),
				sourceId,
				{ DB: db, PAYMENT_QUEUE: { sendBatch } as unknown as Queue },
			);
			records = info.mock.calls.map(([value]) => JSON.parse(String(value)));
		} finally {
			info.mockRestore();
		}

		const deliveries = await db
			.prepare(
				`SELECT provider_event_id, provider_created_at
				 FROM inbound_provider_deliveries
				 WHERE provider_event_id IN (?, ?)
				 ORDER BY provider_created_at`,
			)
			.bind(older.id, newer.id)
			.all<{ provider_event_id: string; provider_created_at: number }>();
		expect(deliveries.results).toEqual([
			{
				provider_event_id: older.id,
				provider_created_at: Date.parse(older.createdAt),
			},
			{
				provider_event_id: newer.id,
				provider_created_at: Date.parse(newer.createdAt),
			},
		]);
		expect(sendBatch).toHaveBeenCalledTimes(2);
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			event: "payment_provider_webhook_ingested",
			queuedEvents: 1,
			queueFailedEvents: 0,
			outcome: "accepted",
		});
		expect(Number(records[1]?.deliveryDelayMs)).toBeGreaterThan(
			Number(records[0]?.deliveryDelayMs) + 100_000,
		);
	});

	it("persists a large delivery in bounded batches", async () => {
		const payload = structuredClone(fixture);
		payload.id = "whevt_full_activity_batch";
		const [baseActivity] = payload.event.activity;
		if (!baseActivity) throw new Error("Expected Alchemy activity fixture");
		payload.event.activity = Array.from({ length: 250 }, (_, index) => {
			const activity = structuredClone(baseActivity);
			activity.hash = `0x${(index + 1).toString(16).padStart(64, "0")}`;
			if (!activity.log) throw new Error("Expected token activity log");
			activity.log.logIndex = `0x${index.toString(16)}`;
			return activity;
		});
		const counters = createDatastoreCounters();
		const sendBatch = vi.fn().mockResolvedValue(undefined);

		const response = await handleAlchemyAddressActivity(
			request(payload, "request-alchemy-full-batch"),
			sourceId,
			{
				DB: instrumentD1(db, counters),
				PAYMENT_QUEUE: { sendBatch } as unknown as Queue,
			},
		);
		expect(await response.json()).toEqual({ accepted: 250, queued: 100 });
		expect(sendBatch.mock.calls[0]?.[0]).toHaveLength(100);
		expect(counters.d1Prepare).toBeLessThanOrEqual(12);
		expect(counters.d1Batch).toBe(1);
		const count = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM inbound_provider_events WHERE provider_event_id = ?",
			)
			.bind(payload.id)
			.first<{ count: number }>();
		expect(count?.count).toBe(250);
	});

	it("isolates malformed activities without letting a later event clear the degraded state", async () => {
		await db
			.prepare(
				"UPDATE payment_ingresses SET health_status = 'healthy', last_error_code = NULL WHERE id = ?",
			)
			.bind(sourceId)
			.run();
		const payload = {
			...structuredClone(fixture),
			id: "whevt_mixed_activity",
			event: {
				...structuredClone(fixture.event),
				activity: [
					{ hash: "provider-shape-changed" },
					...structuredClone(fixture.event.activity),
				],
			},
		};
		const sendBatch = vi.fn().mockResolvedValue(undefined);

		const response = await handleAlchemyAddressActivity(
			request(payload, "request-alchemy-mixed-activity"),
			sourceId,
			{ DB: db, PAYMENT_QUEUE: { sendBatch } as unknown as Queue },
		);
		expect(await response.json()).toEqual({ accepted: 1, queued: 1 });
		const validPayload = structuredClone(fixture);
		validPayload.id = "whevt_after_mixed_activity";
		await handleAlchemyAddressActivity(
			request(validPayload, "request-alchemy-after-mixed-activity"),
			sourceId,
			{ DB: db, PAYMENT_QUEUE: { sendBatch } as unknown as Queue },
		);
		const source = await db
			.prepare(
				"SELECT health_status, last_error_code FROM payment_ingresses WHERE id = ?",
			)
			.bind(sourceId)
			.first<{ health_status: string; last_error_code: string }>();
		expect(source).toEqual({
			health_status: "degraded",
			last_error_code: "provider_activity_invalid",
		});
	});

	it("quarantines a provider event ID that is replayed with changed content", async () => {
		const payload = structuredClone(fixture);
		const [activity] = payload.event.activity;
		if (!activity) throw new Error("Expected Alchemy activity fixture");
		activity.hash =
			"0x9a4a39da2a3fa1fc2ef88fd1eaea070286ed2aba21e0419dcfb6d5c5d9f02a72";
		const addedActivity = structuredClone(activity);
		addedActivity.hash =
			"0xaa4a39da2a3fa1fc2ef88fd1eaea070286ed2aba21e0419dcfb6d5c5d9f02a72";
		if (!addedActivity.log) throw new Error("Expected token activity log");
		addedActivity.log.logIndex = "0x6f";
		payload.event.activity.push(addedActivity);
		const sendBatch = vi.fn().mockResolvedValue(undefined);

		const response = await handleAlchemyAddressActivity(
			request(payload, "request-alchemy-changed-event"),
			sourceId,
			{ DB: db, PAYMENT_QUEUE: { sendBatch } as unknown as Queue },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: 0, queued: 0 });
		expect(sendBatch).not.toHaveBeenCalled();
		const delivery = await db
			.prepare(
				`SELECT delivery.changed_at,
				 (SELECT COUNT(*) FROM inbound_provider_events event
				  WHERE event.source_id = delivery.source_id
				  AND event.provider_event_id = delivery.provider_event_id) AS event_count
				 FROM inbound_provider_deliveries delivery
				 WHERE delivery.source_id = ? AND delivery.provider_event_id = ?`,
			)
			.bind(sourceId, fixture.id)
			.first<{ changed_at: number | null; event_count: number }>();
		expect(delivery?.changed_at).not.toBeNull();
		expect(delivery?.event_count).toBe(1);
		const source = await db
			.prepare(
				"SELECT health_status, last_error_code FROM payment_ingresses WHERE id = ?",
			)
			.bind(sourceId)
			.first<{ health_status: string; last_error_code: string }>();
		expect(source).toEqual({
			health_status: "degraded",
			last_error_code: "provider_event_changed",
		});
	});

	it("acknowledges a signed provider error and exposes degraded health", async () => {
		const payload = {
			...structuredClone(fixture),
			id: "whevt_provider_error",
			event: { error: "Monthly capacity limit exceeded" },
		};
		const response = await handleAlchemyAddressActivity(
			request(payload, "request-alchemy-provider-error"),
			sourceId,
			{ DB: db },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: 0, queued: 0 });
		const source = await db
			.prepare(
				"SELECT health_status, last_error_code FROM payment_ingresses WHERE id = ?",
			)
			.bind(sourceId)
			.first<{ health_status: string; last_error_code: string }>();
		expect(source).toEqual({
			health_status: "degraded",
			last_error_code: "provider_error",
		});
	});

	it("verifies but does not retain events while the source is disabled", async () => {
		await db
			.prepare("UPDATE payment_ingresses SET enabled = 0 WHERE id = ?")
			.bind(sourceId)
			.run();
		const payload = structuredClone(fixture);
		payload.id = "whevt_disabled_source";
		const response = await handleAlchemyAddressActivity(
			request(payload, "request-alchemy-disabled"),
			sourceId,
			{ DB: db },
		);
		await db
			.prepare("UPDATE payment_ingresses SET enabled = 1 WHERE id = ?")
			.bind(sourceId)
			.run();

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: 0, queued: 0 });
		const event = await db
			.prepare(
				"SELECT id FROM inbound_provider_events WHERE provider_event_id = ?",
			)
			.bind(payload.id)
			.first();
		expect(event).toBeNull();
	});

	it("rejects an invalid signature without persisting provider data", async () => {
		const payload = structuredClone(fixture);
		payload.id = "whevt_invalid_signature";
		const response = await handleAlchemyAddressActivity(
			new Request(`https://pay.example/api/providers/alchemy/${sourceId}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-alchemy-signature": "0".repeat(64),
					"x-request-id": "request-alchemy-invalid-signature",
				},
				body: JSON.stringify(payload),
			}),
			sourceId,
			{ DB: db },
		);
		expect(response.status).toBe(401);
		const count = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM inbound_provider_events WHERE provider_event_id = ?",
			)
			.bind(payload.id)
			.first<{ count: number }>();
		expect(count?.count).toBe(0);
	});

	it("fails closed at the authoritative D1 delivery rate limit", async () => {
		const now = Date.now();
		const windowStart = Math.floor(now / 60_000) * 60_000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		await db
			.prepare(
				`INSERT INTO rate_limit_counters
				 (id, bucket_key, window_start, count, expires_at, created_at, updated_at)
				 VALUES ('alchemy-rate-limit', ?, ?, 600, ?, ?, ?)
				 ON CONFLICT(bucket_key, window_start) DO UPDATE SET count = 600`,
			)
			.bind(
				`provider:alchemy:${sourceId}`,
				windowStart,
				windowStart + 120_000,
				now,
				now,
			)
			.run();
		const payload = structuredClone(fixture);
		payload.id = "whevt_rate_limited";
		try {
			const response = await handleAlchemyAddressActivity(
				request(payload, "request-alchemy-rate-limited"),
				sourceId,
				{ DB: db },
			);

			expect(response.status).toBe(429);
			expect(await response.json()).toEqual({ error: "rate_limited" });
		} finally {
			clock.mockRestore();
		}
		const event = await db
			.prepare(
				"SELECT id FROM inbound_provider_events WHERE provider_event_id = ?",
			)
			.bind(payload.id)
			.first();
		expect(event).toBeNull();
	});
});

function request(payload: unknown, requestId: string) {
	const body = JSON.stringify(payload);
	return new Request(`https://pay.example/api/providers/alchemy/${sourceId}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-alchemy-signature": createHmac("sha256", signingKey)
				.update(body)
				.digest("hex"),
			"x-request-id": requestId,
		},
		body,
	});
}
