import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidOrderTransitionError } from "#/features/orders/state-machine";
import {
	expireOrder,
	expireOrders,
} from "#/features/payments/server/expiration";
import { applyMigrations } from "./migrations";

describe("order expiration with live payments", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let env: Env;
	const now = 1_800_000_000_000;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-expiration-confirming" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db, now);
		env = {
			DB: db,
			WEBHOOK_QUEUE: { send: async () => undefined },
		} as unknown as Env;
	});

	afterAll(async () => miniflare.dispose());

	it("expires due pending and partially paid orders but never a confirming one", async () => {
		await expect(expireOrders(env, now)).resolves.toBe(2);
		const statuses = await db
			.prepare("SELECT id, status FROM orders ORDER BY id")
			.all<{ id: string; status: string }>();
		expect(statuses.results).toEqual([
			{ id: "order-confirming", status: "confirming" },
			{ id: "order-partial", status: "expired" },
			{ id: "order-pending", status: "expired" },
		]);
		const events = await db
			.prepare(
				"SELECT order_id FROM webhook_events WHERE type = 'order.expired' ORDER BY order_id",
			)
			.all<{ order_id: string }>();
		expect(events.results.map((event) => event.order_id)).toEqual([
			"order-partial",
			"order-pending",
		]);
		// The confirming order stays scannable and its payment stays attributed.
		await expect(
			db
				.prepare(
					"SELECT status FROM order_payments WHERE order_id = 'order-confirming'",
				)
				.first(),
		).resolves.toEqual({ status: "confirming" });
		await expect(expireOrders(env, now)).resolves.toBe(0);
	});

	it("rejects a direct expiration of a confirming order at the state machine", async () => {
		await expect(
			expireOrder(
				env,
				{
					id: "order-confirming",
					external_order_id: "confirming",
					amount: "10.00",
					currency: "USD",
					paymentAmount: "10",
					received_amount_units: "10000000",
					code: "USDT",
					network: "tron",
					version: 0,
					status: "confirming" as never,
				},
				now,
			),
		).rejects.toBeInstanceOf(InvalidOrderTransitionError);
	});
});

async function seed(db: D1Database, now: number) {
	const order = (id: string, status: string, received: string) =>
		db
			.prepare(
				`INSERT INTO orders (id, external_order_id, status, amount_minor, currency,
				 currency_decimals, payment_asset_id, received_amount_units, expires_at,
				 version, created_at, updated_at)
				 VALUES (?, ?, ?, '1000', 'USD', 2, 'asset-usdt', ?, ?, 0, ?, ?)`,
			)
			.bind(id, id.replace("order-", ""), status, received, now - 1, now, now);
	const snapshot = (id: string) =>
		db
			.prepare(
				`INSERT INTO order_payment_snapshots (order_id, receiving_method_id,
				 receiving_method_name, rail_code, rail_kind, asset_id, asset_code, decimals,
				 target_value, connection_id, adapter, required_confirmations,
				 expected_amount_units, created_at)
				 VALUES (?, 'method-usdt', 'Primary', 'tron', 'chain', 'asset-usdt', 'USDT', 6,
				 'TTarget11111111111111111111111111', 'connection-tron', 'tron', 2, '10000000', ?)`,
			)
			.bind(id, now);
	const payment = (id: string, amount: string, status: string) =>
		db
			.prepare(
				`INSERT INTO order_payments (id, order_id, transaction_id, amount_units,
				 confirmations, status, detected_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
			)
			.bind(
				`payment-${id}`,
				id,
				`tron:tx-${id}:0`,
				amount,
				status,
				now,
				now,
				now,
			);
	await db.batch([
		db
			.prepare(
				"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, default_confirmations, created_at, updated_at) VALUES ('asset-usdt', 'tron', 'USDT', 'USDT', 'token', 6, 2, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, enabled, health_status, created_at, updated_at) VALUES ('connection-tron', 'tron', 'TRON', 'rpc', 'https://api.trongrid.io', 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('method-usdt', 'Primary', 'tron', 'address', 'TTarget11111111111111111111111111', 'TTarget11111111111111111111111111', 1, ?, ?)",
			)
			.bind(now, now),
		order("order-pending", "pending", "0"),
		order("order-partial", "partially_paid", "4000000"),
		order("order-confirming", "confirming", "10000000"),
		snapshot("order-pending"),
		snapshot("order-partial"),
		snapshot("order-confirming"),
		payment("order-partial", "4000000", "confirmed"),
		payment("order-confirming", "10000000", "confirming"),
	]);
}
