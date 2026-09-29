import { describe, expect, it } from "vitest";
import { createExchangeRateQuoter } from "#/features/payment-settings/server/rates";

const rows = [
	// ETH/USDT catalog seed, quotable forever.
	{
		base: "ETH",
		quote: "USDT",
		raw_rate: "2000",
		rate: "2000",
		source: "binance",
		adjustment_bps: 0,
		observed_at: 0,
	},
	// USD/CNY fiat seed for the USD bridge.
	{
		base: "USD",
		quote: "CNY",
		raw_rate: "7",
		rate: "7",
		source: "exchangerate_host",
		adjustment_bps: 0,
		observed_at: 0,
	},
];

function fakeDatabase() {
	const queries: Array<{ sql: string; bindings: unknown[] }> = [];
	const database = {
		prepare: (sql: string) => ({
			bind: (...bindings: unknown[]) => {
				queries.push({ sql, bindings });
				return {
					all: async () => ({
						success: true as const,
						results: rows,
						meta: {},
					}),
				};
			},
		}),
	} as unknown as Pick<D1Database, "prepare">;
	return { database, queries };
}

describe("exchange rate quoter", () => {
	it("quotes every payment option from a single exchange-rate read", async () => {
		const { database, queries } = fakeDatabase();
		const quoter = await createExchangeRateQuoter(database, {
			amount: "100",
			currency: "USD",
			paymentAssets: ["ETH", "USDT", "TRX", "ETH"],
			now: 1_000,
		});
		expect(queries).toHaveLength(1);
		expect(queries[0]?.bindings).toEqual([
			1_000,
			"USD",
			"ETH",
			"USDT",
			"TRX",
			"USDC",
			"USD",
			"ETH",
			"USDT",
			"TRX",
			"USDC",
		]);

		expect(
			quoter.quote({ paymentAsset: "ETH", assetDecimals: 8 }),
		).toMatchObject({
			paymentAmount: "0.05",
			source: "binance",
			finalRate: "2000",
		});
		expect(
			quoter.quote({ paymentAsset: "USDT", assetDecimals: 6 }),
		).toMatchObject({
			paymentAmount: "100",
			source: "stable_parity",
		});
		expect(quoter.quote({ paymentAsset: "TRX", assetDecimals: 6 })).toBeNull();
		expect(quoter.usdAmountMinor()).toBe("10000");
		expect(queries).toHaveLength(1);
	});

	it("bridges other fiat currencies through USD without another read", async () => {
		const { database, queries } = fakeDatabase();
		const quoter = await createExchangeRateQuoter(database, {
			amount: "700",
			currency: "CNY",
			paymentAssets: ["ETH"],
			now: 1_000,
		});
		expect(
			quoter.quote({ paymentAsset: "ETH", assetDecimals: 8 }),
		).toMatchObject({
			paymentAmount: "0.05",
			source: "exchangerate_host+binance",
			finalRate: "14000",
		});
		expect(quoter.usdAmountMinor()).toBe("10000");
		expect(queries).toHaveLength(1);
	});
});
