import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getCheckoutOrderWithDatabase } from "#/features/checkout/server/checkout-order";
import { submitCheckoutTransactionForRequest } from "#/features/checkout/server/request-actions";
import { submitCheckoutTransaction } from "#/features/checkout/server/submit-transaction";
import type {
	NormalizedTransaction,
	PaymentAdapter,
} from "#/integrations/chains/types";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

const orderId = "26071306234512345678";
const receivingAddress = "TCheckoutTarget111111111111111111111";

describe("checkout transaction submission", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let env: Env;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "checkout-transaction-submission" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		env = {
			DB: db,
			WEBHOOK_QUEUE: { send: async () => undefined },
		} as unknown as Env;
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it("accepts a matching transaction through the idempotent payment path", async () => {
		const adapter = fakeAdapter(transaction());
		const loadCounters = createDatastoreCounters();
		await expect(
			getCheckoutOrderWithDatabase(instrumentD1(db, loadCounters), orderId),
		).resolves.toMatchObject({
			trade_id: orderId,
			status: 1,
			status_detail: "pending",
		});
		expect(loadCounters).toMatchObject({
			d1Prepare: 1,
			d1StatementFirst: 1,
			d1StatementAll: 0,
			d1StatementRun: 0,
			d1Batch: 0,
		});
		const counters = createDatastoreCounters();
		const send = vi.fn().mockResolvedValue(undefined);
		await expect(
			submitCheckoutTransactionForRequest(
				{
					...env,
					DB: instrumentD1(db, counters),
					WEBHOOK_QUEUE: { send },
				} as unknown as Env,
				{
					orderId,
					transactionHash: "checkout-transaction-1",
				},
				"203.0.113.20",
				async () => [{ adapter }],
			),
		).resolves.toEqual({
			status: "accepted",
			orderStatus: "paid",
			transactionId: "tron:checkout-transaction-1:0",
		});
		expect(counters).toMatchObject({
			d1Prepare: 16,
			d1StatementFirst: 6,
			d1StatementAll: 4,
			d1StatementRun: 0,
			d1Batch: 1,
		});
		expect(send).not.toHaveBeenCalled();
		const warmCounters = createDatastoreCounters();
		await expect(
			submitCheckoutTransactionForRequest(
				{
					...env,
					DB: instrumentD1(db, warmCounters),
				} as unknown as Env,
				{
					orderId,
					transactionHash: "checkout-transaction-1",
				},
				"203.0.113.20",
				async () => [{ adapter }],
			),
		).resolves.toEqual({ status: "unavailable" });
		expect(warmCounters).toMatchObject({
			d1Prepare: 2,
			d1StatementFirst: 2,
			d1StatementAll: 0,
			d1StatementRun: 0,
			d1Batch: 0,
		});

		await expect(
			submitCheckoutTransaction(
				env,
				{
					orderId,
					transactionHash: "checkout-transaction-1",
				},
				async () => [{ adapter }],
			),
		).resolves.toEqual({ status: "unavailable" });

		const state = await db
			.prepare(
				`SELECT o.status, o.received_amount_units,
				 (SELECT COUNT(*) FROM order_payments WHERE order_id = o.id) AS payments
				 FROM orders o WHERE o.id = ?`,
			)
			.bind(orderId)
			.first<{
				status: string;
				received_amount_units: string;
				payments: number;
			}>();
		expect(state).toEqual({
			status: "paid",
			received_amount_units: "10000000",
			payments: 1,
		});
	});

	it("stops a rejected transaction submission at the D1 rate limiter", async () => {
		const input = {
			orderId: "26071306234512349997",
			transactionHash: "missing-transaction",
		};
		for (let attempt = 0; attempt < 5; attempt += 1) {
			await expect(
				submitCheckoutTransactionForRequest(env, input, "203.0.113.21"),
			).resolves.toEqual({ status: "unavailable" });
		}
		const counters = createDatastoreCounters();
		await expect(
			submitCheckoutTransactionForRequest(
				{
					...env,
					DB: instrumentD1(db, counters),
				} as unknown as Env,
				input,
				"203.0.113.21",
			),
		).rejects.toMatchObject({
			code: "transaction_rate_limited",
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

	it("does not persist a transaction sent to another address", async () => {
		await resetOrder(db);
		const adapter = fakeAdapter(
			transaction({ to: "TAnotherRecipient111111111111111111111" }),
		);
		await expect(
			submitCheckoutTransaction(
				env,
				{
					orderId,
					transactionHash: "checkout-transaction-2",
				},
				async () => [{ adapter }],
			),
		).resolves.toEqual({ status: "mismatch" });
		const paymentCount = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM order_payments WHERE order_id = ?",
			)
			.bind(orderId)
			.first<{ count: number }>();
		expect(paymentCount?.count).toBe(0);
	});

	it("stops a mismatched submission after one order read and one provider lookup", async () => {
		await resetOrder(db);
		const getTransaction = vi
			.fn()
			.mockResolvedValue(
				transaction({ to: "TAnotherRecipient111111111111111111111" }),
			);
		const createPaymentTarget = vi.fn(async () => ({
			address: receivingAddress,
			expiresAt: new Date(),
		}));
		const adapter = {
			...fakeAdapter(null),
			getTransaction,
			createPaymentTarget,
		};
		const counters = createDatastoreCounters();
		const send = vi.fn();
		await expect(
			submitCheckoutTransaction(
				{
					DB: instrumentD1(db, counters),
					WEBHOOK_QUEUE: { send },
				} as unknown as Env,
				{ orderId, transactionHash: "checkout-transaction-counted" },
				async () => [{ adapter }],
			),
		).resolves.toEqual({ status: "mismatch" });
		expect(getTransaction).toHaveBeenCalledOnce();
		expect(createPaymentTarget).toHaveBeenCalledOnce();
		expect(send).not.toHaveBeenCalled();
		expect(counters).toMatchObject({
			d1Prepare: 1,
			d1StatementFirst: 1,
			d1StatementAll: 0,
			d1StatementRun: 0,
			d1Batch: 0,
		});
	});
});

function fakeAdapter(
	observed: NormalizedTransaction | null,
): PaymentAdapter<unknown> {
	return {
		id: "test",
		network: "tron",
		configSchema: {} as PaymentAdapter<unknown>["configSchema"],
		validateConfig: (value) => value,
		createPaymentTarget: async ({ address, expiresAt }) => ({
			address,
			expiresAt,
		}),
		getTransaction: async () => observed,
		findTransactions: async () => [],
		validateAddress: () => true,
		validatePayment: (payment, target, assetCode) =>
			payment.to === target.address && payment.assetCode === assetCode,
		getConfirmations: async (payment) => payment.confirmations,
		healthCheck: async () => ({
			healthy: true,
			latencyMs: 0,
			checkedAt: new Date(),
		}),
		classifyError: () => "permanent",
		isRetryable: () => false,
	};
}

function transaction(
	overrides: Partial<NormalizedTransaction> = {},
): NormalizedTransaction {
	return {
		network: "tron",
		hash: "checkout-transaction-1",
		eventIndex: 0,
		from: "TPayer111111111111111111111111111111",
		to: receivingAddress,
		assetCode: "USDT",
		amountUnits: 10_000_000n,
		blockNumber: 100n,
		blockHash: "checkout-block-100",
		confirmations: 2,
		timestamp: new Date(),
		success: true,
		...overrides,
	};
}

async function seed(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('checkout-asset', 'tron', 'USDT', 'USDT', 'token', 6, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, enabled, health_status, created_at, updated_at) VALUES ('checkout-connection', 'tron', 'TRON', 'rpc', 'https://api.trongrid.io', 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 2, created_at = ?, updated_at = ? WHERE id = 'checkout-asset'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('checkout-method', 'Primary USDT', 'tron', 'address', ?, ?, 1, ?, ?)",
			)
			.bind(receivingAddress, receivingAddress, now, now),
		db
			.prepare(
				"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at) VALUES (?, 'checkout-manual-1', 'pending', '1000', 'USD', 2, 'checkout-asset', '0', ?, 0, ?, ?)",
			)
			.bind(orderId, now + 900_000, now, now),
		db
			.prepare(
				`INSERT INTO order_payment_snapshots
				 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
				  asset_id, asset_code, decimals, target_value, connection_id,
				  adapter, required_confirmations, expected_amount_units, created_at)
				 VALUES (?, 'checkout-method', 'Primary USDT', 'tron', 'chain',
				  'checkout-asset', 'USDT', 6, ?, 'checkout-connection',
				  'tron', 2, '10000000', ?)`,
			)
			.bind(orderId, receivingAddress, now),
	]);
}

async function resetOrder(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db.prepare("DELETE FROM webhook_deliveries"),
		db.prepare("DELETE FROM webhook_events"),
		db.prepare("DELETE FROM order_payments"),
		db.prepare("DELETE FROM blockchain_transactions"),
		db
			.prepare(
				"UPDATE orders SET status = 'pending', received_amount_units = '0', paid_at = NULL, version = 0, expires_at = ?, updated_at = ? WHERE id = ?",
			)
			.bind(now + 900_000, now, orderId),
	]);
}
