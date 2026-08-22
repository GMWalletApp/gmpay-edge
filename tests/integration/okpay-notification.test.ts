import { md5 } from "@noble/hashes/legacy.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkReceivingMethodReadiness } from "#/features/payment-settings/server/check-method-readiness";
import { allocateReceivingMethodAndSnapshot } from "#/features/payment-settings/server/receiving-method-locks";
import { handleOkPayNotification } from "#/features/payments/server/okpay-notification";
import { encryptSecret } from "#/lib/secrets";
import statusFixture from "../fixtures/providers/okpay-payment-status.json";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

const orderId = "4c64fbd1-3299-4c45-b104-57d255a7c1fe";
const paymentConfigSecret = "okpay-integration-payment-config-secret";
const apiKeyPepper = "okpay-integration-api-key-pepper";

describe("OKPay notification flow", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let env: Env;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "okpay-notification" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		env = {
			DB: db,
			WEBHOOK_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
		} as unknown as Env;
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it("rejects an oversized notification body", async () => {
		const response = await handleOkPayNotification(
			new Request("https://pay.example/api/webhooks/payments/okpay", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": String(64 * 1024 + 1),
				},
				body: "{}",
			}),
			env,
		);

		expect(response.status).toBe(413);
	});

	it("verifies, actively queries, settles, and deduplicates a repeated callback", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(async () => Response.json(statusFixture));
		vi.stubGlobal("fetch", fetchMock);
		const send = vi.fn().mockResolvedValue(undefined);
		const firstCounters = createDatastoreCounters();
		const countedEnv = {
			...env,
			DB: instrumentD1(db, firstCounters),
			WEBHOOK_QUEUE: { send },
		} as unknown as Env;
		const first = await handleOkPayNotification(
			notification("request-1"),
			countedEnv,
		);
		const repeatedCounters = createDatastoreCounters();
		const repeated = await handleOkPayNotification(notification("request-2"), {
			...countedEnv,
			DB: instrumentD1(db, repeatedCounters),
		});
		expect(first.status).toBe(200);
		expect(repeated.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledWith({
			kind: "webhook.delivery",
			version: 1,
			deliveryId: expect.any(String),
			eventId: expect.any(String),
			attempt: 1,
		});
		expect(firstCounters).toEqual({
			d1Prepare: 15,
			d1Batch: 1,
			d1Exec: 0,
			d1StatementBind: 13,
			d1StatementRun: 1,
			d1StatementFirst: 4,
			d1StatementAll: 3,
			d1StatementRaw: 0,
			kvGet: 0,
			kvPut: 0,
			kvDelete: 0,
			kvList: 0,
			r2Get: 0,
		});
		expect(repeatedCounters).toEqual({
			d1Prepare: 5,
			d1Batch: 0,
			d1Exec: 0,
			d1StatementBind: 5,
			d1StatementRun: 1,
			d1StatementFirst: 3,
			d1StatementAll: 1,
			d1StatementRaw: 0,
			kvGet: 0,
			kvPut: 0,
			kvDelete: 0,
			kvList: 0,
			r2Get: 0,
		});
		const state = await db
			.prepare(`SELECT o.status,
			 (SELECT COUNT(*) FROM order_payments WHERE order_id = o.id) AS payments,
			 (SELECT COUNT(*) FROM blockchain_transactions WHERE network = 'okpay' AND tx_hash = 'ok-order') AS transactions,
			 (SELECT COUNT(*) FROM inbound_webhook_receipts
			  WHERE endpoint_code = 'okpay.notify' AND external_request_id IN ('request-1', 'request-2')) AS receipts,
			 (SELECT COUNT(*) FROM webhook_events WHERE order_id = o.id AND type = 'order.paid') AS events,
			 (SELECT COUNT(*) FROM webhook_deliveries WHERE order_id = o.id AND status = 'queued' AND attempt_count = 0) AS deliveries
			 FROM orders o WHERE o.id = ?`)
			.bind(orderId)
			.first<{
				status: string;
				payments: number;
				transactions: number;
				receipts: number;
				events: number;
				deliveries: number;
			}>();
		expect(state).toEqual({
			status: "paid",
			payments: 1,
			transactions: 1,
			receipts: 2,
			events: 1,
			deliveries: 1,
		});
	});

	it("does not require a health probe for provider connections", async () => {
		await expect(
			checkReceivingMethodReadiness(db, "receiving-okpay"),
		).resolves.toMatchObject({ ready: true, status: "ready", reasons: [] });
		await expect(
			allocateReceivingMethodAndSnapshot(db, {
				orderId: "okpay-allocation-order",
				receivingMethodId: "receiving-okpay",
				paymentMethodId: "okpay-usdt",
				expectedAmountUnits: "350000000",
				expiresAt: Date.now() + 900_000,
				now: Date.now(),
			}),
		).resolves.toMatchObject({ receivingMethodId: "receiving-okpay" });
		await expect(
			db
				.prepare(
					"SELECT connection_id FROM order_payment_snapshots WHERE order_id = 'okpay-allocation-order'",
				)
				.first<{ connection_id: string }>(),
		).resolves.toEqual({ connection_id: "connection-okpay" });
	});

	it("rejects a modified callback before querying the provider", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const counters = createDatastoreCounters();
		const body: Record<string, string> = callback();
		body.amount = "999";
		const response = await handleOkPayNotification(
			new Request("https://edge.example/api/providers/okpay/notify", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-request-id": "request-invalid",
				},
				body: JSON.stringify(body),
			}),
			{ ...env, DB: instrumentD1(db, counters) },
		);
		expect(response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(counters).toMatchObject({
			d1Prepare: 3,
			d1StatementFirst: 1,
			d1StatementAll: 1,
			d1StatementRun: 1,
			d1Batch: 0,
		});
	});

	it.each([
		{
			name: "malformed JSON",
			request: () =>
				new Request("https://edge.example/api/providers/okpay/notify", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-request-id": "request-malformed-json",
					},
					body: "{",
				}),
			requestId: "request-malformed-json",
		},
		{
			name: "non-object JSON",
			request: () =>
				new Request("https://edge.example/api/providers/okpay/notify", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-request-id": "request-non-object-json",
					},
					body: "[]",
				}),
			requestId: "request-non-object-json",
		},
		{
			name: "malformed nested notification JSON",
			request: () =>
				new Request("https://edge.example/api/providers/okpay/notify", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-request-id": "request-malformed-nested-json",
					},
					body: JSON.stringify({ data: "{" }),
				}),
			requestId: "request-malformed-nested-json",
		},
		{
			name: "malformed multipart form data",
			request: () =>
				new Request("https://edge.example/api/providers/okpay/notify", {
					method: "POST",
					headers: {
						"content-type": "multipart/form-data; boundary=missing",
						"x-request-id": "request-malformed-form",
					},
					body: "not-a-multipart-body",
				}),
			requestId: "request-malformed-form",
		},
	])("rejects $name with an audited structured response", async ({
		request,
		requestId,
	}) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const response = await handleOkPayNotification(request(), env);

		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toBe(
			"application/json; charset=utf-8",
		);
		expect(response.headers.get("x-request-id")).toBe(requestId);
		await expect(response.json()).resolves.toEqual({
			error: "invalid_notification",
		});
		expect(fetchMock).not.toHaveBeenCalled();
		await expect(
			db
				.prepare(
					`SELECT signature_status, processing_status, response_status, error_code
					 FROM inbound_webhook_receipts WHERE external_request_id = ?`,
				)
				.bind(requestId)
				.first(),
		).resolves.toEqual({
			signature_status: "unknown",
			processing_status: "rejected",
			response_status: 400,
			error_code: "invalid_notification",
		});
	});

	it("records every attempt even when the provider reuses its request ID", async () => {
		const repeatedExternalId = "provider-reused-request-id";
		for (let attempt = 0; attempt < 2; attempt++)
			await handleOkPayNotification(
				new Request("https://edge.example/api/providers/okpay/notify", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-request-id": repeatedExternalId,
					},
					body: "{}",
				}),
				env,
			);
		const receipts = await db
			.prepare(
				`SELECT COUNT(*) AS count, COUNT(DISTINCT request_id) AS request_ids
				 FROM inbound_webhook_receipts WHERE external_request_id = ?`,
			)
			.bind(repeatedExternalId)
			.first<{ count: number; request_ids: number }>();
		expect(receipts).toEqual({ count: 2, request_ids: 2 });
	});
});

function notification(requestId: string) {
	return new Request("https://edge.example/api/providers/okpay/notify", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-request-id": requestId,
		},
		body: JSON.stringify(callback()),
	});
}

function callback() {
	const input: Record<string, string> = {
		amount: "3.5",
		coin: "USDT",
		id: "12345",
		order_id: "ok-order",
		unique_id: orderId,
	};
	const query = new URLSearchParams();
	for (const key of Object.keys(input).sort()) {
		const value = input[key];
		if (value !== undefined) query.set(key, value);
	}
	const message = `${decodeURIComponent(query.toString().replace(/\+/g, " "))}&token=secret`;
	return {
		...input,
		sign: bytesToHex(md5(utf8ToBytes(message))).toUpperCase(),
	};
}

async function seed(db: D1Database) {
	const now = Date.now();
	const encrypted = await encryptSecret(
		JSON.stringify({
			shopId: "12345",
			apiKey: "secret",
			apiUrl: "https://api.okaypay.me/shop",
		}),
		paymentConfigSecret,
	);
	const encryptedApiSecret = await encryptSecret(
		"merchant-callback-secret",
		apiKeyPepper,
	);
	await db.batch([
		db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.integration_config_secret', ?, 1, ?, ?)",
			)
			.bind(JSON.stringify(paymentConfigSecret), now, now),
		db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.api_key_pepper', ?, 1, ?, ?)",
			)
			.bind(JSON.stringify(apiKeyPepper), now, now),
		db
			.prepare(
				"INSERT INTO api_keys (id, name, pid, secret_encrypted, scopes, created_at, updated_at) VALUES ('api-key-okpay', 'OKPay merchant', 'gm_okpay', ?, '[\"orders:create\",\"orders:read\"]', ?, ?)",
			)
			.bind(encryptedApiSecret, now, now),
		db
			.prepare(
				"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('okpay', 'OKPay', 'wallet', 'okpay', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('okpay-usdt', 'okpay', 'USDT', 'USDT', 'external', 8, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 1, created_at = ?, updated_at = ? WHERE id = 'okpay-usdt'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, enabled, health_status, created_at, updated_at) VALUES ('connection-okpay', 'okpay', 'OKPay', 'provider', 'https://api.okaypay.me/shop', 1, 'unknown', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, config_encrypted, enabled, created_at, updated_at) VALUES ('receiving-okpay', 'OKPay shop', 'okpay', 'provider', '12345', '12345', ?, 1, ?, ?)",
			)
			.bind(encrypted, now, now),
		db
			.prepare(
				"INSERT OR IGNORE INTO receiving_method_assets (id, receiving_method_id, payment_asset_id, created_at, updated_at) VALUES ('link-okpay', 'receiving-okpay', 'okpay-usdt', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at) VALUES ('okpay-allocation-order', 'merchant-okpay-allocation', 'pending', '350', 'USD', 2, NULL, '0', ?, 0, ?, ?)",
			)
			.bind(now + 900_000, now, now),
		db
			.prepare(
				"INSERT INTO orders (id, external_order_id, api_key_id, api_protocol, status, amount_minor, currency, currency_decimals, payment_asset_id, provider_order_id, received_amount_units, notify_url, expires_at, version, created_at, updated_at) VALUES (?, 'merchant-okpay-1', 'api-key-okpay', 'gmpay', 'pending', '350', 'USD', 2, 'okpay-usdt', 'ok-order', '0', 'https://merchant.example/callback', ?, 0, ?, ?)",
			)
			.bind(orderId, now + 900_000, now, now),
		db
			.prepare(
				"INSERT INTO order_payment_snapshots (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind, asset_id, asset_code, decimals, target_value, connection_id, adapter, required_confirmations, expected_amount_units, created_at) VALUES (?, 'receiving-okpay', 'OKPay shop', 'okpay', 'wallet', 'okpay-usdt', 'USDT', 8, '12345', 'connection-okpay', 'okpay', 1, '350000000', ?)",
			)
			.bind(orderId, now),
	]);
}
