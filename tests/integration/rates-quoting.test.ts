import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrder } from "#/features/orders/server/create";
import {
	quoteUsdAmountMinor,
	quoteWithExchangeRate,
} from "#/features/payment-settings/server/rates";
import { applyMigrations } from "./migrations";

const now = Date.now();
const hourMs = 3_600_000;

describe("exchange-rate quoting", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-rates-quoting" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it("quotes a native asset for a dollar-parity order from its USDT pair", async () => {
		for (const currency of ["USD", "USDC"]) {
			await expect(
				quoteWithExchangeRate(db, {
					amount: "3738",
					currency,
					paymentAsset: "ETH",
					assetDecimals: 18,
					now,
				}),
			).resolves.toEqual({
				paymentAmount: "2",
				source: "binance",
				rawRate: "1869",
				adjustmentBps: 0,
				finalRate: "1869",
				observedAt: now - 1_000,
			});
		}
	});

	it("bridges another fiat currency through USD with one exact rounding", async () => {
		await expect(
			quoteWithExchangeRate(db, {
				amount: "700",
				currency: "CNY",
				paymentAsset: "TRX",
				assetDecimals: 6,
				now,
			}),
		).resolves.toEqual({
			// 700 CNY ÷ 7.0175 CNY/USD ÷ 0.3252 USDT/TRX, rounded up once.
			paymentAmount: "306.736235",
			source: "exchangerate_host+binance",
			rawRate: "2.2764",
			adjustmentBps: 25,
			finalRate: "2.282091",
			observedAt: now - 3_000,
		});
		await expect(
			quoteUsdAmountMinor(db, { amount: "700", currency: "CNY", now }),
		).resolves.toBe("9976");
	});

	it("keeps stablecoin parity quotes independent of stored rates", async () => {
		await expect(
			quoteWithExchangeRate(db, {
				amount: "12.5",
				currency: "USD",
				paymentAsset: "USDT",
				assetDecimals: 6,
				now,
			}),
		).resolves.toMatchObject({
			paymentAmount: "12.5",
			source: "stable_parity",
			finalRate: "1",
		});
	});

	it("refuses an expired observation but still quotes catalog defaults", async () => {
		await expect(
			quoteWithExchangeRate(db, {
				amount: "1500",
				currency: "JPY",
				paymentAsset: "USDT",
				assetDecimals: 6,
				now,
			}),
		).resolves.toBeNull();
		await expect(
			quoteUsdAmountMinor(db, { amount: "1500", currency: "JPY", now }),
		).resolves.toBeNull();
		await expect(
			quoteWithExchangeRate(db, {
				amount: "100",
				currency: "EUR",
				paymentAsset: "USDT",
				assetDecimals: 6,
				now,
			}),
		).resolves.toMatchObject({
			paymentAmount: "111.111112",
			source: "exchangerate_host",
			observedAt: 0,
		});
		await expect(
			quoteWithExchangeRate(db, {
				amount: "77.07",
				currency: "USD",
				paymentAsset: "SOL",
				assetDecimals: 9,
				now,
			}),
		).resolves.toMatchObject({ paymentAmount: "1", observedAt: 0 });
	});

	it("returns no quote when neither a direct pair nor a USD bridge exists", async () => {
		await expect(
			quoteWithExchangeRate(db, {
				amount: "10",
				currency: "GBP",
				paymentAsset: "ETH",
				assetDecimals: 18,
				now,
			}),
		).resolves.toBeNull();
		await expect(
			quoteWithExchangeRate(db, {
				amount: "10",
				currency: "USD",
				paymentAsset: "BTC",
				assetDecimals: 8,
				now,
			}),
		).resolves.toBeNull();
	});

	it("persists the composite observation in the order payment snapshot", async () => {
		const created = await createOrder(
			db,
			{
				externalOrderId: "composite-quote",
				amount: "700",
				currency: "CNY",
				paymentAsset: "TRX",
				paymentNetwork: "tron",
			},
			"https://pay.example.test/payments/gmpay/v1/order/create-transaction",
		);
		expect(created).toMatchObject({
			paymentAsset: "TRX",
			paymentNetwork: "tron",
			paymentAmount: "306.7363",
		});
		await expect(
			db
				.prepare(
					`SELECT rate_source, raw_rate, rate_adjustment, final_rate, rate_observed_at
					 FROM order_payment_snapshots WHERE order_id = ?`,
				)
				.bind(created.orderId)
				.first(),
		).resolves.toEqual({
			rate_source: "exchangerate_host+binance",
			raw_rate: "2.2764",
			rate_adjustment: "25",
			final_rate: "2.282091",
			rate_observed_at: now - 3_000,
		});
	});
});

async function seed(db: D1Database) {
	const rate = (
		id: string,
		category: "crypto" | "fiat",
		base: string,
		quote: string,
		raw: string,
		final: string,
		source: string,
		bps: number,
		observedAt: number,
		expiresAt: number,
	) =>
		db
			.prepare(
				`INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source,
				 adjustment_bps, observed_at, expires_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				category,
				base,
				quote,
				raw,
				final,
				source,
				bps,
				observedAt,
				expiresAt,
				now,
				now,
			);
	await db.batch([
		rate(
			"rate-eth-usdt",
			"crypto",
			"ETH",
			"USDT",
			"1869",
			"1869",
			"binance",
			0,
			now - 1_000,
			now + hourMs,
		),
		rate(
			"rate-trx-usdt",
			"crypto",
			"TRX",
			"USDT",
			"0.3252",
			"0.3252",
			"binance",
			0,
			now - 2_000,
			now + hourMs,
		),
		rate(
			"rate-usd-cny",
			"fiat",
			"USD",
			"CNY",
			"7",
			"7.0175",
			"exchangerate_host",
			25,
			now - 3_000,
			now + 24 * hourMs,
		),
		rate(
			"rate-usd-jpy",
			"fiat",
			"USD",
			"JPY",
			"150",
			"150",
			"exchangerate_host",
			0,
			now - 48 * hourMs,
			now - 1,
		),
		rate(
			"rate-usd-eur",
			"fiat",
			"USD",
			"EUR",
			"0.9",
			"0.9",
			"exchangerate_host",
			0,
			0,
			0,
		),
		rate(
			"rate-sol-usdt",
			"crypto",
			"SOL",
			"USDT",
			"77.07",
			"77.07",
			"binance",
			0,
			0,
			0,
		),
		db
			.prepare(
				"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, default_confirmations, created_at, updated_at) VALUES ('asset-trx', 'tron', 'TRX', 'TRX', 'native', 6, 20, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, priority, enabled, health_status, created_at, updated_at) VALUES ('connection-tron', 'tron', 'TronGrid', 'rpc', 'https://api.trongrid.io', 1, 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, sort_order, enabled, created_at, updated_at) VALUES ('method-trx', 'Primary TRX', 'tron', 'address', 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', 1, 1, ?, ?)",
			)
			.bind(now, now),
	]);
}
