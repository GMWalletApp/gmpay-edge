import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	listCheckoutPaymentOptions,
	selectCheckoutPaymentOption,
} from "#/features/checkout/server/payment-options";
import { createOrder } from "#/features/orders/server/create";
import { encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const selectableOrderId = "26071306234512345690";
const paymentConfigSecret = "okpay-hosted-payment-config-secret";

describe("OKPay hosted payment initialization failures", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-order-okpay-hosted" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("provider unreachable");
			}),
		);
	});

	afterAll(async () => {
		vi.unstubAllGlobals();
		await miniflare.dispose();
	});

	it("rolls back a merchant order whose hosted payment could not be created", async () => {
		const input = {
			externalOrderId: "okpay-hosted-failure",
			amount: "3.50",
			currency: "USD",
			paymentAsset: "USDT",
			paymentNetwork: "okpay",
		};
		await expect(
			createOrder(db, input, "https://pay.example.test"),
		).rejects.toMatchObject({ code: "provider_unavailable", status: 502 });
		await expect(
			db
				.prepare(
					`SELECT
					 (SELECT COUNT(*) FROM orders WHERE external_order_id = 'okpay-hosted-failure') AS orders,
					 (SELECT COUNT(*) FROM order_payment_snapshots) AS snapshots,
					 (SELECT COUNT(*) FROM receiving_method_locks) AS locks,
					 (SELECT COUNT(*) FROM audit_logs WHERE action = 'order.hosted_payment_failed') AS audits`,
				)
				.first(),
		).resolves.toEqual({ orders: 0, snapshots: 0, locks: 0, audits: 1 });
		// The external order ID is free again: the retry reaches the provider
		// instead of failing with a duplicate order error.
		await expect(
			createOrder(db, input, "https://pay.example.test"),
		).rejects.toMatchObject({ code: "provider_unavailable" });
	});

	it("releases a checkout selection without burning the existing order", async () => {
		await expect(
			selectCheckoutPaymentOption(db, {
				orderId: selectableOrderId,
				receivingMethodId: "receiving-okpay",
				paymentMethodId: "okpay-usdt",
			}),
		).rejects.toMatchObject({ code: "provider_unavailable", status: 502 });
		await expect(
			db
				.prepare(
					`SELECT o.status, o.payment_asset_id, o.provider_order_id, o.payment_url,
					 (SELECT COUNT(*) FROM order_payment_snapshots WHERE order_id = o.id) AS snapshots,
					 (SELECT COUNT(*) FROM receiving_method_locks WHERE order_id = o.id) AS locks
					 FROM orders o WHERE o.id = ?`,
				)
				.bind(selectableOrderId)
				.first(),
		).resolves.toEqual({
			status: "pending",
			payment_asset_id: null,
			provider_order_id: null,
			payment_url: null,
			snapshots: 0,
			locks: 0,
		});
		await expect(
			listCheckoutPaymentOptions(db, selectableOrderId),
		).resolves.toMatchObject({ selectable: true });
	});
});

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
	await db.batch([
		db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.integration_config_secret', ?, 1, ?, ?)",
			)
			.bind(JSON.stringify(paymentConfigSecret), now, now),
		db
			.prepare(
				"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('okpay', 'OKPay', 'wallet', 'okpay', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, default_confirmations, created_at, updated_at) VALUES ('okpay-usdt', 'okpay', 'USDT', 'USDT', 'external', 8, 1, ?, ?)",
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
				"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at) VALUES (?, 'selectable-okpay', 'pending', '350', 'USD', 2, NULL, '0', ?, 0, ?, ?)",
			)
			.bind(selectableOrderId, now + 900_000, now, now),
	]);
}
