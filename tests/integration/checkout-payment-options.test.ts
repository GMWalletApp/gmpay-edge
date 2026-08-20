import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	listCheckoutPaymentOptions,
	selectCheckoutPaymentOption,
} from "#/features/checkout/server/payment-options";
import { selectCheckoutPaymentOptionForRequest } from "#/features/checkout/server/request-actions";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

const orderId = "26071306234512345678";
const methodId = "4dc360b6-1d7a-4a69-a103-5cafce84e531";

describe("checkout receiving method selection", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let env: Env;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "checkout-payment-options-v2" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		env = { DB: db } as Env;
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it("lists only ready receiving methods and atomically creates the snapshot and lock", async () => {
		const counters = createDatastoreCounters();
		await expect(
			listCheckoutPaymentOptions(instrumentD1(db, counters), orderId),
		).resolves.toMatchObject({
			selectable: true,
			options: expect.arrayContaining([
				{
					receivingMethodId: methodId,
					receivingMethodName: "Primary USDT",
					paymentMethodId: "asset-usdt-tron",
					asset: "USDT",
					network: "tron",
					networkName: "TRON",
					railKind: "chain",
					amount: "12.5",
					current: false,
				},
				{
					receivingMethodId: methodId,
					receivingMethodName: "Primary USDT",
					paymentMethodId: "asset-usdc-tron",
					asset: "USDC",
					network: "tron",
					networkName: "TRON",
					railKind: "chain",
					amount: "12.5",
					current: false,
				},
			]),
		});
		expect(counters).toMatchObject({
			d1Prepare: 2,
			d1StatementFirst: 1,
			d1StatementAll: 1,
			d1StatementRun: 0,
			d1Batch: 0,
		});
		const selectCounters = createDatastoreCounters();
		await expect(
			selectCheckoutPaymentOptionForRequest(
				{ ...env, DB: instrumentD1(db, selectCounters) },
				{
					orderId,
					receivingMethodId: methodId,
					paymentMethodId: "asset-usdt-tron",
				},
				"203.0.113.10",
			),
		).resolves.toMatchObject({
			asset: "USDT",
			network: "tron",
			paymentAmount: "12.5",
		});
		expect(selectCounters).toMatchObject({
			d1Prepare: 19,
			d1StatementFirst: 6,
			d1StatementAll: 5,
			d1StatementRun: 2,
			d1Batch: 2,
		});
		const warmCounters = createDatastoreCounters();
		await expect(
			selectCheckoutPaymentOptionForRequest(
				{ ...env, DB: instrumentD1(db, warmCounters) },
				{
					orderId,
					receivingMethodId: methodId,
					paymentMethodId: "asset-usdt-tron",
				},
				"203.0.113.10",
			),
		).resolves.toMatchObject({
			asset: "USDT",
			network: "tron",
			paymentAmount: "12.5",
		});
		expect(warmCounters).toMatchObject({
			d1Prepare: 2,
			d1StatementFirst: 2,
			d1StatementAll: 0,
			d1StatementRun: 0,
			d1Batch: 0,
		});
		const state = await db
			.prepare(
				`SELECT o.payment_asset_id, o.version,
				 ops.receiving_method_id, ops.target_value,
				 (SELECT COUNT(*) FROM receiving_method_locks l
				  WHERE l.order_id = o.id AND l.released_at IS NULL) AS locks
				 FROM orders o JOIN order_payment_snapshots ops ON ops.order_id = o.id
				 WHERE o.id = ?`,
			)
			.bind(orderId)
			.first<Record<string, string | number | null>>();
		expect(state).toEqual({
			payment_asset_id: "asset-usdt-tron",
			version: 1,
			receiving_method_id: methodId,
			target_value: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj",
			locks: 1,
		});
	});

	it("stops a rejected option request at the D1 rate limiter", async () => {
		const input = {
			orderId: "26071306234512349998",
			receivingMethodId: methodId,
			paymentMethodId: "asset-usdt-tron",
		};
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await expect(
				selectCheckoutPaymentOptionForRequest(env, input, "203.0.113.11"),
			).rejects.toMatchObject({ code: "order_not_found", status: 404 });
		}
		const counters = createDatastoreCounters();
		await expect(
			selectCheckoutPaymentOptionForRequest(
				{ ...env, DB: instrumentD1(db, counters) },
				input,
				"203.0.113.11",
			),
		).rejects.toMatchObject({
			code: "payment_option_rate_limited",
			status: 429,
		});
		expect(counters).toMatchObject({
			d1Prepare: 1,
			d1StatementFirst: 1,
			d1StatementAll: 0,
			d1StatementRun: 0,
			d1Batch: 0,
		});
	});

	it("stops checkout option loading after one order miss", async () => {
		const counters = createDatastoreCounters();
		await expect(
			listCheckoutPaymentOptions(
				instrumentD1(db, counters),
				"26071306234512349999",
			),
		).resolves.toBeNull();
		expect(counters).toMatchObject({
			d1Prepare: 1,
			d1StatementFirst: 1,
			d1StatementAll: 0,
			d1StatementRun: 0,
			d1Batch: 0,
		});
	});

	it("keeps an existing order payment snapshot immutable", async () => {
		await expect(
			listCheckoutPaymentOptions(db, orderId),
		).resolves.toMatchObject({
			selectable: false,
			options: [
				{
					receivingMethodId: methodId,
					receivingMethodName: "Primary USDT",
					current: true,
				},
			],
		});
		await expect(
			selectCheckoutPaymentOption(env.DB, {
				orderId,
				receivingMethodId: methodId,
				paymentMethodId: "asset-usdt-tron",
			}),
		).resolves.toMatchObject({ asset: "USDT", network: "tron" });
		await expect(
			selectCheckoutPaymentOption(env.DB, {
				orderId,
				receivingMethodId: "11111111-1111-4111-8111-111111111111",
				paymentMethodId: "asset-usdt-tron",
			}),
		).rejects.toMatchObject({
			code: "payment_snapshot_immutable",
			status: 409,
		});
	});
});

async function seed(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, contract_address, created_at, updated_at) VALUES ('asset-usdt-tron', 'tron', 'USDT', 'USDT', 'token', 6, 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, priority, enabled, health_status, created_at, updated_at) VALUES ('connection-tron', 'tron', 'TronGrid', 'rpc', 'https://api.trongrid.io', 10, 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 20, created_at = ?, updated_at = ? WHERE id = 'asset-usdt-tron'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, contract_address, created_at, updated_at) VALUES ('asset-usdc-tron', 'tron', 'USDC', 'USDC', 'token', 6, 'TUSDCContract1111111111111111111111', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 20, created_at = ?, updated_at = ? WHERE id = 'asset-usdc-tron'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, sort_order, enabled, created_at, updated_at) VALUES (?, 'Primary USDT', 'tron', 'address', 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', 10, 1, ?, ?)",
			)
			.bind(methodId, now, now),
		db
			.prepare(
				"INSERT OR IGNORE INTO receiving_method_assets (id, receiving_method_id, payment_asset_id, created_at, updated_at) VALUES ('link-usdt-tron', ?, 'asset-usdt-tron', ?, ?)",
			)
			.bind(methodId, now, now),
		db
			.prepare(
				"INSERT OR IGNORE INTO receiving_method_assets (id, receiving_method_id, payment_asset_id, created_at, updated_at) VALUES ('link-usdc-tron', ?, 'asset-usdc-tron', ?, ?)",
			)
			.bind(methodId, now, now),
		db
			.prepare(
				"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at) VALUES (?, 'option-order', 'pending', '1250', 'USD', 2, NULL, '0', ?, 0, ?, ?)",
			)
			.bind(orderId, now + 900_000, now, now),
	]);
}
