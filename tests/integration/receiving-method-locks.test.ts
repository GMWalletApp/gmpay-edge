import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrderSchema } from "#/features/orders/schema";
import { createOrder } from "#/features/orders/server/create";
import {
	assertReceivingMethodReadyForEnable,
	checkReceivingMethodReadiness,
} from "#/features/payment-settings/server/check-method-readiness";
import {
	applyBasisPoints,
	quoteWithExchangeRate,
} from "#/features/payment-settings/server/rates";
import {
	allocateReceivingMethodAndSnapshot,
	allocateUniqueReceivingMethodAndSnapshot,
	ReceivingMethodUnavailableError,
	releaseReceivingMethodLock,
} from "#/features/payment-settings/server/receiving-method-locks";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("receiving method allocation and immutable snapshots", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-receiving-method-locks" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it("reports deterministic readiness without mutating enabled state", async () => {
		await expect(
			checkReceivingMethodReadiness(db, "asset-trx", { now: 10 }),
		).resolves.toMatchObject({ ready: true, status: "ready", reasons: [] });
		await db
			.prepare(
				"UPDATE payment_ingresses SET health_status = 'unhealthy' WHERE id = 'connection-tron'",
			)
			.run();
		await expect(
			checkReceivingMethodReadiness(db, "asset-trx", { now: 11 }),
		).resolves.toMatchObject({
			ready: false,
			status: "unhealthy",
			reasons: [{ code: "UNHEALTHY_CONNECTION" }],
		});
		await db.batch([
			db.prepare(
				"UPDATE payment_ingresses SET health_status = 'healthy' WHERE id = 'connection-tron'",
			),
			db.prepare(
				"UPDATE receiving_methods SET target_value = '', normalized_target_value = ''",
			),
		]);
		await expect(
			assertReceivingMethodReadyForEnable(db, "asset-trx"),
		).rejects.toMatchObject({
			code: "RECEIVING_METHOD_NOT_READY",
			readiness: {
				status: "missing_target",
				reasons: [{ code: "MISSING_TARGET" }],
			},
		});
		await db.batch([
			db.prepare(
				"UPDATE receiving_methods SET target_value = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', normalized_target_value = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', enabled = 0 WHERE id = 'asset-trx'",
			),
		]);
		await expect(
			checkReceivingMethodReadiness(db, "asset-trx", { now: 12 }),
		).resolves.toMatchObject({
			ready: false,
			status: "disabled",
			reasons: [{ code: "METHOD_DISABLED" }],
		});
		await expect(
			assertReceivingMethodReadyForEnable(db, "asset-trx"),
		).resolves.toMatchObject({ ready: true, status: "ready" });
		await db
			.prepare(
				"UPDATE receiving_methods SET enabled = 1 WHERE id = 'asset-trx'",
			)
			.run();
	});

	it("quotes a persisted adjusted exchange rate with exact decimal arithmetic", async () => {
		expect(applyBasisPoints("1", 50)).toBe("1.005");
		await expect(
			quoteWithExchangeRate(db, {
				amount: "100",
				currency: "USDT",
				paymentAsset: "BTC",
				assetDecimals: 6,
				now: 1_000,
			}),
		).resolves.toEqual({
			paymentAmount: "99.502488",
			source: "manual",
			rawRate: "1",
			adjustmentBps: 50,
			finalRate: "1.005",
			observedAt: 900,
		});
	});

	it("enforces receiving limits against the order value in USD minor units", async () => {
		await expect(
			allocateReceivingMethodAndSnapshot(db, {
				orderId: "below-limit",
				receivingMethodId: "asset-trx",
				paymentMethodId: "asset-trx",
				expectedAmountUnits: "2000000",
				orderAmountUsdMinor: "0",
				expiresAt: 2_000,
				now: 1_000,
			}),
		).rejects.toMatchObject({ reason: "below_minimum" });
		await expect(
			allocateReceivingMethodAndSnapshot(db, {
				orderId: "above-limit",
				receivingMethodId: "asset-trx",
				paymentMethodId: "asset-trx",
				expectedAmountUnits: "2000000",
				orderAmountUsdMinor: "1000000000000",
				expiresAt: 2_000,
				now: 1_000,
			}),
		).rejects.toMatchObject({ reason: "above_maximum" });
	});

	it("rejects colliding active amounts for one receiving method", async () => {
		await expect(allocate(db, "order-a", 2_000)).resolves.toEqual({
			lockId: expect.any(String),
			receivingMethodId: "asset-trx",
		});
		await expect(allocate(db, "order-b", 2_000)).rejects.toBeInstanceOf(
			ReceivingMethodUnavailableError,
		);
	});

	it("allocates the next visibly distinct amount for a concurrent order", async () => {
		await expect(
			allocateUniqueReceivingMethodAndSnapshot(db, {
				orderId: "order-b",
				receivingMethodId: "asset-trx",
				paymentMethodId: "asset-trx",
				expectedAmountUnits: "1000000",
				orderAmountUsdMinor: "100",
				decimals: 6,
				expiresAt: 2_000,
				reusableAt: 2_000,
				now: 1_000,
				existingOrder: { expectedVersion: 0 },
			}),
		).resolves.toMatchObject({
			expectedAmountUnits: "1000100",
			paymentAmount: "1.0001",
		});
		const order = await db
			.prepare("SELECT version FROM orders WHERE id = 'order-b'")
			.first<{ version: number }>();
		expect(order?.version).toBe(1);
	});

	it("reports an order version conflict without retrying other amounts", async () => {
		await db
			.prepare(
				`INSERT INTO orders (id, external_order_id, status, amount_minor, currency,
				 currency_decimals, payment_asset_id, received_amount_units, expires_at,
				 version, created_at, updated_at)
				 VALUES ('order-conflict', 'merchant-conflict', 'pending', '100', 'USD',
				 2, 'asset-trx', '0', 2000, 3, 1, 1)`,
			)
			.run();
		const counters = createDatastoreCounters();
		await expect(
			allocateUniqueReceivingMethodAndSnapshot(instrumentD1(db, counters), {
				orderId: "order-conflict",
				receivingMethodId: "asset-trx",
				paymentMethodId: "asset-trx",
				expectedAmountUnits: "5000000",
				orderAmountUsdMinor: "100",
				decimals: 6,
				expiresAt: 2_000,
				reusableAt: 2_000,
				now: 1_000,
				existingOrder: { expectedVersion: 2 },
			}),
		).rejects.toMatchObject({ reason: "order_conflict" });
		// One lock sweep plus one allocation attempt: no amount-collision retries.
		expect(counters.d1Batch).toBe(2);
		await expect(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM receiving_method_locks WHERE order_id = 'order-conflict'",
				)
				.first(),
		).resolves.toEqual({ count: 0 });
		await expect(
			allocateUniqueReceivingMethodAndSnapshot(db, {
				orderId: "order-conflict",
				receivingMethodId: "asset-trx",
				paymentMethodId: "asset-trx",
				expectedAmountUnits: "5000000",
				orderAmountUsdMinor: "100",
				decimals: 6,
				expiresAt: 2_000,
				reusableAt: 2_000,
				now: 1_000,
				existingOrder: { expectedVersion: 3 },
			}),
		).resolves.toMatchObject({ expectedAmountUnits: "5000000" });
	});

	it("rolls back a newly created order when its amount lock collides", async () => {
		await expect(
			allocateReceivingMethodAndSnapshot(db, {
				orderId: "collision-order",
				receivingMethodId: "asset-trx",
				paymentMethodId: "asset-trx",
				expectedAmountUnits: "1000000",
				orderAmountUsdMinor: "100",
				expiresAt: 2_000,
				reusableAt: 2_000,
				now: 1_000,
				order: {
					externalOrderId: "collision-merchant-order",
					amountMinor: "1",
					currency: "TRX",
					currencyDecimals: 0,
				},
			}),
		).rejects.toBeInstanceOf(ReceivingMethodUnavailableError);
		const orphan = await db
			.prepare("SELECT 1 AS value FROM orders WHERE id = 'collision-order'")
			.first();
		expect(orphan).toBeNull();
	});

	it("keeps a released amount quarantined until its reusable time", async () => {
		await expect(
			releaseReceivingMethodLock(db, "order-a", 1_500),
		).resolves.toBe(1);
		await expect(allocate(db, "order-c", 3_000, 1_500)).rejects.toBeInstanceOf(
			ReceivingMethodUnavailableError,
		);
		await expect(allocate(db, "order-c", 3_000, 2_001)).resolves.toEqual({
			lockId: expect.any(String),
			receivingMethodId: "asset-trx",
		});
	});

	it("creates the order, method lock, and payment snapshot in one workflow", async () => {
		await releaseReceivingMethodLock(db, "order-c", 1_600);
		const input = createOrderSchema.parse({
			externalOrderId: "method-order",
			amount: "1",
			currency: "USD",
			receivingMethodId: "asset-trx",
		});
		const created = await createOrder(
			db,
			input,
			"https://pay.example.test/payments/gmpay/v1/order/create-transaction",
		);
		expect(created).toMatchObject({
			externalOrderId: "method-order",
			receivingMethodId: "asset-trx",
			paymentAsset: "TRX",
			paymentNetwork: "tron",
			paymentAmount: "1",
		});
		const persisted = await db
			.prepare(
				`SELECT ops.receiving_method_id, ops.target_value,
				 ptl.released_at FROM orders o
				 JOIN order_payment_snapshots ops ON ops.order_id = o.id
				 JOIN receiving_method_locks ptl ON ptl.order_id = o.id
				 WHERE o.id = ?`,
			)
			.bind(created.orderId)
			.first<{
				receiving_method_id: string;
				target_value: string;
				released_at: number | null;
			}>();
		expect(persisted).toMatchObject({
			receiving_method_id: "asset-trx",
			target_value: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj",
			released_at: null,
		});
		await expect(
			createOrder(db, input, "https://pay.example.test"),
		).rejects.toMatchObject({
			code: "external_order_exists",
			status: 409,
		});
	});

	it("deletes a terminal lock in immediate release mode", async () => {
		await db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('orders.immediate_release_mode', 'true', 0, 0, 0)",
			)
			.run();
		const order = await db
			.prepare(
				"SELECT id FROM orders WHERE external_order_id = 'method-order' LIMIT 1",
			)
			.first<{ id: string }>();
		await expect(
			releaseReceivingMethodLock(db, order?.id ?? "missing"),
		).resolves.toBe(1);
		const lock = await db
			.prepare(
				"SELECT 1 AS value FROM receiving_method_locks WHERE order_id = ?",
			)
			.bind(order?.id ?? "missing")
			.first();
		expect(lock).toBeNull();
		await db
			.prepare(
				"DELETE FROM system_settings WHERE key = 'orders.immediate_release_mode'",
			)
			.run();
	});

	it("keeps the order snapshot immutable after receiving method edits", async () => {
		await db.batch([
			db.prepare(
				"UPDATE payment_assets SET code = 'RENAMED', default_confirmations = 99 WHERE id = 'asset-trx'",
			),
			db.prepare(
				"UPDATE receiving_methods SET name = 'Renamed', target_value = 'TChanged', normalized_target_value = 'TChanged', enabled = 0 WHERE id = 'asset-trx'",
			),
		]);
		const snapshot = await db
			.prepare(
				`SELECT receiving_method_name, asset_code, target_value, required_confirmations,
				 expected_amount_units, rate_source, raw_rate, final_rate
				 FROM order_payment_snapshots WHERE order_id = 'order-a'`,
			)
			.first<{
				receiving_method_name: string;
				asset_code: string;
				target_value: string;
				required_confirmations: number;
				expected_amount_units: string;
				rate_source: string;
				raw_rate: string;
				final_rate: string;
			}>();
		expect(snapshot).toEqual({
			receiving_method_name: "Primary TRX",
			asset_code: "TRX",
			target_value: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj",
			required_confirmations: 20,
			expected_amount_units: "1000000",
			rate_source: "binance",
			raw_rate: "7.1",
			final_rate: "7.1355",
		});
	});
});

function allocate(
	db: D1Database,
	orderId: string,
	expiresAt: number,
	now = 1_000,
) {
	return allocateReceivingMethodAndSnapshot(db, {
		orderId,
		receivingMethodId: "asset-trx",
		paymentMethodId: "asset-trx",
		expectedAmountUnits: "1000000",
		orderAmountUsdMinor: "100",
		expiresAt,
		reusableAt: expiresAt,
		now,
		rate: {
			source: "binance",
			raw: "7.1",
			adjustment: "0.005",
			final: "7.1355",
			observedAt: 900,
		},
	});
}

async function seed(db: D1Database) {
	await db.batch([
		db.prepare(
			"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', 1, 1)",
		),
		db.prepare(
			"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('asset-trx', 'tron', 'TRX', 'TRX', 'native', 6, 1, 1)",
		),
		db.prepare(
			"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, priority, enabled, health_status, created_at, updated_at) VALUES ('connection-tron', 'tron', 'TronGrid', 'rpc', 'https://api.trongrid.io', 1, 1, 'healthy', 1, 1)",
		),
		db.prepare(
			"UPDATE payment_assets SET default_confirmations = 20, created_at = 1, updated_at = 1 WHERE id = 'asset-trx'",
		),
		db.prepare(
			"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, min_amount_minor, max_amount_minor, sort_order, enabled, created_at, updated_at) VALUES ('asset-trx', 'Primary TRX', 'tron', 'address', 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', '1', '999999999999', 1, 1, 1, 1)",
		),
		db.prepare(
			"INSERT OR IGNORE INTO receiving_method_assets (id, receiving_method_id, payment_asset_id, created_at, updated_at) VALUES ('link-trx', 'asset-trx', 'asset-trx', 1, 1)",
		),
		db.prepare(
			"INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source, adjustment_bps, observed_at, expires_at, created_at, updated_at) VALUES ('rate-btc-usdt', 'crypto', 'BTC', 'USDT', '1', '1.005', 'manual', 50, 900, 999999, 1, 1)",
		),
		db.prepare(
			"INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source, adjustment_bps, observed_at, expires_at, created_at, updated_at) VALUES ('rate-usd-trx', 'fiat', 'USD', 'TRX', '1', '1', 'manual', 0, 900, 9999999999999, 1, 1)",
		),
		...(["a", "b", "c"] as const).map((suffix) =>
			db.prepare(
				`INSERT INTO orders (id, external_order_id, status, amount_minor, currency,
				 currency_decimals, payment_asset_id, received_amount_units, expires_at,
				 version, created_at, updated_at)
				 VALUES ('order-${suffix}', 'merchant-${suffix}', 'pending', '100', 'USD',
				 2, 'asset-trx', '0', 2000, 0, 1, 1)`,
			),
		),
	]);
}
