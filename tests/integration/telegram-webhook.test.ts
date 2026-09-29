import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { reconcileTelegramDefaults } from "#/features/telegram/defaults";
import { handleTelegramWebhookRequest } from "#/features/telegram/server/webhook";
import { sha256Hex } from "#/lib/crypto";
import { encryptSecret } from "#/lib/secrets";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

const botId = "11111111-1111-4111-8111-111111111111";
const unknownBotId = "22222222-2222-4222-8222-222222222222";
const configSecret = "telegram-webhook-config-secret-with-enough-entropy";
const webhookSecret = "telegram-webhook-secret";
const boundUserId = 777;

describe("Telegram webhook request budget", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-telegram-webhook-budget" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await reconcileTelegramDefaults(db, 1);
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.integration_config_secret', ?, 1, ?, ?)",
				)
				.bind(JSON.stringify(configSecret), now, now),
			db
				.prepare(
					"INSERT INTO telegram_bots (id, name, token_encrypted, webhook_secret_encrypted, enabled, created_at, updated_at) VALUES (?, 'Budget Bot', ?, ?, 1, ?, ?)",
				)
				.bind(
					botId,
					await encryptSecret("100:telegram-token", configSecret),
					await encryptSecret(webhookSecret, configSecret),
					now,
					now,
				),
			db
				.prepare(
					"INSERT INTO telegram_notification_bindings (id, bot_id, template_translations, name, target_type, target_id, locale, events, enabled, created_at, updated_at) VALUES ('binding-777', ?, '{}', 'Operator', 'private', ?, 'en-US', '[]', 1, ?, ?)",
				)
				.bind(botId, String(boundUserId), now, now),
		]);
	});

	afterAll(async () => miniflare.dispose());
	afterEach(() => vi.unstubAllGlobals());

	it("processes a valid no-op update with one bot/runtime/receipt pass", async () => {
		const counters = createDatastoreCounters();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const response = await handleTelegramWebhookRequest(
			request("telegram-valid", webhookSecret, {
				update_id: 1,
				message: { chat: { id: 1, type: "private" } },
			}),
			botId,
			{ DB: instrumentD1(db, counters) } as Env,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(fetchMock).not.toHaveBeenCalled();
		// Two rate-limit claims, one bot lookup, one runtime read, one receipt.
		expect(counters).toMatchObject({
			d1Prepare: 5,
			d1StatementFirst: 3,
			d1StatementAll: 1,
			d1StatementRun: 1,
			d1Batch: 0,
		});
		expect(await receipt("telegram-valid")).toEqual({
			response_status: 200,
			signature_status: "valid",
			error_code: null,
		});
	});

	it("records an invalid secret without reading or processing the update", async () => {
		const counters = createDatastoreCounters();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const response = await handleTelegramWebhookRequest(
			request("telegram-invalid", "wrong-secret", { invalid: true }),
			botId,
			{ DB: instrumentD1(db, counters) } as Env,
		);

		expect(response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(counters).toMatchObject({
			d1Prepare: 5,
			d1StatementFirst: 3,
			d1StatementAll: 1,
			d1StatementRun: 1,
			d1Batch: 0,
		});
		expect(await receipt("telegram-invalid")).toMatchObject({
			response_status: 401,
			signature_status: "invalid",
			error_code: "invalid_secret",
		});
	});

	it("answers malformed and unknown Bot ids identically without persisting anything", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const malformedCounters = createDatastoreCounters();
		const malformed = await handleTelegramWebhookRequest(
			request("telegram-malformed", webhookSecret, { update_id: 2 }),
			"not-a-uuid",
			{ DB: instrumentD1(db, malformedCounters) } as Env,
		);
		expect(malformed.status).toBe(404);
		expect(await malformed.json()).toEqual({ error: "not_found" });
		expect(malformedCounters.d1Prepare).toBe(0);

		const unknownCounters = createDatastoreCounters();
		const unknown = await handleTelegramWebhookRequest(
			request("telegram-unknown", webhookSecret, { update_id: 2 }),
			unknownBotId,
			{ DB: instrumentD1(db, unknownCounters) } as Env,
		);
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toEqual({ error: "not_found" });
		expect(unknownCounters).toMatchObject({
			d1Prepare: 2,
			d1StatementFirst: 2,
			d1StatementRun: 0,
			d1Batch: 0,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await receipt("telegram-malformed")).toBeNull();
		expect(await receipt("telegram-unknown")).toBeNull();
	});

	it("rejects over-limit Bots and addresses before verifying the secret or writing a receipt", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const address = "198.51.100.9";
		const buckets = [
			{ key: `telegram:bot:${botId}`, count: 600 },
			{ key: `telegram:address:${await sha256Hex(address)}`, count: 1_800 },
		];
		try {
			for (const bucket of buckets) {
				await exhaustBucket(bucket.key, bucket.count);
				const response = await handleTelegramWebhookRequest(
					request(`telegram-limited-${bucket.count}`, "wrong-secret", {
						update_id: 3,
					}),
					botId,
					{ DB: db } as Env,
				);
				expect(response.status).toBe(429);
				expect(await response.json()).toEqual({ error: "rate_limited" });
				expect(await receipt(`telegram-limited-${bucket.count}`)).toBeNull();
				await db
					.prepare("DELETE FROM rate_limit_counters WHERE bucket_key = ?")
					.bind(bucket.key)
					.run();
			}
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			await db
				.prepare("DELETE FROM rate_limit_counters WHERE bucket_key IN (?, ?)")
				.bind(buckets[0]?.key, buckets[1]?.key)
				.run();
		}

		async function exhaustBucket(key: string, count: number) {
			const now = Date.now();
			const windowStart = Math.floor(now / 60_000) * 60_000;
			await db
				.prepare(
					`INSERT INTO rate_limit_counters (id, bucket_key, window_start, count, expires_at, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(bucket_key, window_start) DO UPDATE SET count = excluded.count`,
				)
				.bind(
					crypto.randomUUID(),
					key,
					windowStart,
					count,
					windowStart + 120_000,
					now,
					now,
				)
				.run();
		}

		function request(requestId: string, secret: string, body: unknown) {
			return new Request(`https://pay.example/api/telegram/${botId}/webhook`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-connecting-ip": address,
					"x-request-id": requestId,
					"x-telegram-bot-api-secret-token": secret,
				},
				body: JSON.stringify(body),
			});
		}
	});

	it("rejects an oversized update only after the secret matches", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const response = await handleTelegramWebhookRequest(
			request("telegram-oversized", webhookSecret, {
				update_id: 4,
				message: {
					chat: { id: boundUserId, type: "private" },
					text: "x".repeat(300_000),
				},
			}),
			botId,
			{ DB: db } as Env,
		);

		expect(response.status).toBe(413);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await receipt("telegram-oversized")).toMatchObject({
			response_status: 413,
			signature_status: "valid",
			error_code: "payload_too_large",
		});
	});

	it("acknowledges a permanent Telegram rejection and records its error code", async () => {
		const fetchMock = vi.fn().mockImplementation(() =>
			Promise.resolve(
				Response.json(
					{
						ok: false,
						error_code: 400,
						description:
							"Bad Request: query is too old and response timeout expired or query ID is invalid",
					},
					{ status: 400 },
				),
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const response = await handleTelegramWebhookRequest(
			request("telegram-permanent", webhookSecret, {
				update_id: 5,
				callback_query: {
					id: "stale-callback",
					from: { id: boundUserId },
					data: "inline:pending",
				},
			}),
			botId,
			{ DB: db } as Env,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await receipt("telegram-permanent")).toMatchObject({
			response_status: 200,
			signature_status: "valid",
			error_code: "telegram_api_rejected_400",
		});
	});

	it("keeps transport failures retryable for Telegram", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("fetch failed")),
		);
		const response = await handleTelegramWebhookRequest(
			request("telegram-transport", webhookSecret, {
				update_id: 6,
				callback_query: {
					id: "transport-callback",
					from: { id: boundUserId },
					data: "inline:pending",
				},
			}),
			botId,
			{ DB: db } as Env,
		);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "telegram_processing_failed",
		});
		expect(await receipt("telegram-transport")).toMatchObject({
			response_status: 502,
			error_code: "telegram_transport_error",
		});
	});

	it("disables a private subscription once when the user has blocked the bot", async () => {
		const fetchMock = vi.fn().mockImplementation(() =>
			Promise.resolve(
				Response.json(
					{
						ok: false,
						error_code: 403,
						description: "Forbidden: bot was blocked by the user",
					},
					{ status: 403 },
				),
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const statusRequest = (requestId: string, updateId: number) =>
			request(requestId, webhookSecret, {
				update_id: updateId,
				message: {
					chat: { id: boundUserId, type: "private" },
					from: { id: boundUserId },
					text: "/status nothing-here",
				},
			});
		try {
			const first = await handleTelegramWebhookRequest(
				statusRequest("telegram-blocked-1", 7),
				botId,
				{ DB: db } as Env,
			);
			expect(first.status).toBe(200);
			expect(await receipt("telegram-blocked-1")).toMatchObject({
				response_status: 200,
				error_code: "telegram_api_rejected_403",
			});
			const second = await handleTelegramWebhookRequest(
				statusRequest("telegram-blocked-2", 8),
				botId,
				{ DB: db } as Env,
			);
			expect(second.status).toBe(200);

			const binding = await db
				.prepare(
					"SELECT enabled FROM telegram_notification_bindings WHERE id = 'binding-777'",
				)
				.first<{ enabled: number }>();
			expect(binding).toEqual({ enabled: 0 });
			const audits = await db
				.prepare(
					"SELECT after FROM audit_logs WHERE action = 'telegram_target.auto_disabled' AND target_id = 'binding-777'",
				)
				.all<{ after: string }>();
			expect(audits.results).toHaveLength(1);
			expect(JSON.parse(audits.results[0]?.after ?? "null")).toEqual({
				targetType: "private",
				reason: "blocked_by_user",
			});
		} finally {
			await db
				.prepare(
					"UPDATE telegram_notification_bindings SET enabled = 1 WHERE id = 'binding-777'",
				)
				.run();
		}
	});

	function receipt(requestId: string) {
		return db
			.prepare(
				"SELECT response_status, signature_status, error_code FROM inbound_webhook_receipts WHERE external_request_id = ?",
			)
			.bind(requestId)
			.first<{
				response_status: number;
				signature_status: string;
				error_code: string | null;
			}>();
	}
});

function request(requestId: string, secret: string, body: unknown) {
	return new Request(`https://pay.example/api/telegram/${botId}/webhook`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-request-id": requestId,
			"x-telegram-bot-api-secret-token": secret,
		},
		body: JSON.stringify(body),
	});
}
