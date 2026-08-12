import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrderSchema } from "#/features/orders/schema";
import { createOrder } from "#/features/orders/server/create";
import { applyMigrations } from "./migrations";

const PRIMARY_ADDRESS = "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj";
const SECONDARY_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

describe("receiving method rotation for equal-amount orders", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-receiving-method-rotation" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	function orderInput(externalOrderId: string) {
		return createOrderSchema.parse({
			externalOrderId,
			amount: "1",
			currency: "TRX",
			paymentAsset: "TRX",
			paymentNetwork: "tron",
		});
	}

	it("spreads equal amounts across ready methods before stepping the amount", async () => {
		await expect(
			createOrder(db, orderInput("rotation-1"), "https://pay.example.test"),
		).resolves.toMatchObject({
			receivingMethodId: "method-primary",
			receiveAddress: PRIMARY_ADDRESS,
			paymentAmount: "1",
		});
		await expect(
			createOrder(db, orderInput("rotation-2"), "https://pay.example.test"),
		).resolves.toMatchObject({
			receivingMethodId: "method-secondary",
			receiveAddress: SECONDARY_ADDRESS,
			paymentAmount: "1",
		});
		await expect(
			createOrder(db, orderInput("rotation-3"), "https://pay.example.test"),
		).resolves.toMatchObject({
			receivingMethodId: "method-primary",
			receiveAddress: PRIMARY_ADDRESS,
			paymentAmount: "1.0001",
		});
	});

	it("keeps an explicitly pinned method without rotating", async () => {
		const input = createOrderSchema.parse({
			externalOrderId: "rotation-pinned",
			amount: "1",
			currency: "TRX",
			receivingMethodId: "method-secondary",
		});
		await expect(
			createOrder(db, input, "https://pay.example.test"),
		).resolves.toMatchObject({
			receivingMethodId: "method-secondary",
			receiveAddress: SECONDARY_ADDRESS,
			paymentAmount: "1.0001",
		});
	});
});

async function seed(db: D1Database) {
	await db.batch([
		db.prepare(
			"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', 1, 1)",
		),
		db.prepare(
			"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, default_confirmations, created_at, updated_at) VALUES ('asset-trx', 'tron', 'TRX', 'TRX', 'native', 6, 20, 1, 1)",
		),
		db.prepare(
			"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, priority, enabled, health_status, created_at, updated_at) VALUES ('connection-tron', 'tron', 'TronGrid', 'rpc', 'https://api.trongrid.io', 1, 1, 'healthy', 1, 1)",
		),
		db.prepare(
			`INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, sort_order, enabled, created_at, updated_at)
			 VALUES ('method-primary', 'Primary TRX', 'tron', 'address', '${PRIMARY_ADDRESS}', '${PRIMARY_ADDRESS}', 1, 1, 1, 1),
			 ('method-secondary', 'Secondary TRX', 'tron', 'address', '${SECONDARY_ADDRESS}', '${SECONDARY_ADDRESS}', 2, 1, 1, 1)`,
		),
		db.prepare(
			"INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source, adjustment_bps, observed_at, expires_at, created_at, updated_at) VALUES ('rate-usd-trx', 'fiat', 'USD', 'TRX', '1', '1', 'manual', 0, 900, 9999999999999, 1, 1)",
		),
	]);
}
