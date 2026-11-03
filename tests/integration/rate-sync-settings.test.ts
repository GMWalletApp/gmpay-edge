import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	loadRateSyncConfiguration,
	loadRatesPageData,
	parseRateSyncConfiguration,
	refreshDueExchangeRates,
	refreshExchangeRates,
	saveRateSyncConfiguration,
} from "#/features/payment-settings/server/exchange-rates";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("rate sync settings", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-rate-sync-settings" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db.batch([
			db.prepare(
				"INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source, adjustment_bps, observed_at, expires_at, created_at, updated_at) VALUES ('btc-usdt', 'crypto', 'BTC', 'USDT', '0', '0', 'binance', 0, 0, 0, 1, 1)",
			),
			db.prepare(
				"INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source, adjustment_bps, observed_at, expires_at, created_at, updated_at) VALUES ('usd-cny', 'fiat', 'USD', 'CNY', '0', '0', 'exchangerate_host', 0, 0, 0, 1, 1)",
			),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it("persists provider credentials and executes only when each category is due", async () => {
		await saveRateSyncConfiguration(
			db,
			"crypto",
			{
				enabled: true,
				provider: "okx",
				intervalMs: 300_000,
				adjustmentBps: 0,
				lastSyncedAt: null,
			},
			null,
			1,
		);
		await saveRateSyncConfiguration(
			db,
			"fiat",
			{
				enabled: true,
				provider: "exchangerate_host",
				intervalMs: 86_400_000,
				adjustmentBps: 0,
				publicationValidityMs: 86_400_000,
				credentials: { apiKey: "fiat-test-key" },
				lastSyncedAt: null,
			},
			null,
			1,
		);
		const request = vi.fn(async (url: string) => {
			if (url.includes("okx.com"))
				return Response.json({
					code: "0",
					data: [{ instId: "BTC-USDT", last: "60000.25" }],
				});
			expect(url).toContain("/live?");
			expect(url).toContain("access_key=fiat-test-key");
			return Response.json({ success: true, quotes: { USDCNY: 7.25 } });
		});
		const result = await refreshDueExchangeRates(db, request, 1_000);
		expect(result.crypto).toMatchObject({ updated: 1, failed: 0 });
		expect(result.fiat).toMatchObject({ updated: 1, failed: 0 });
		expect(request).toHaveBeenCalledTimes(2);
		await expect(
			loadRateSyncConfiguration(db, "crypto"),
		).resolves.toMatchObject({
			provider: "okx",
			lastSyncedAt: 1_000,
		});
		await expect(loadRateSyncConfiguration(db, "fiat")).resolves.toMatchObject({
			publicationValidityMs: 86_400_000,
			credentials: { apiKey: "fiat-test-key" },
			lastSyncedAt: 1_000,
		});
		await expect(refreshDueExchangeRates(db, request, 2_000)).resolves.toEqual({
			crypto: null,
			fiat: null,
		});
		expect(request).toHaveBeenCalledTimes(2);

		const disabledCrypto = {
			...(await loadRateSyncConfiguration(db, "crypto")),
			enabled: false,
			lastSyncedAt: null,
		};
		const disabledFiat = {
			...(await loadRateSyncConfiguration(db, "fiat")),
			enabled: false,
			lastSyncedAt: null,
		};
		await saveRateSyncConfiguration(db, "crypto", disabledCrypto, null, 2_001);
		await saveRateSyncConfiguration(db, "fiat", disabledFiat, null, 2_001);
		await expect(refreshDueExchangeRates(db, request, 3_000)).resolves.toEqual({
			crypto: null,
			fiat: null,
		});
		expect(request).toHaveBeenCalledTimes(2);

		await saveRateSyncConfiguration(
			db,
			"crypto",
			{ ...disabledCrypto, enabled: true },
			null,
			3_001,
		);
		await expect(refreshDueExchangeRates(db, request, 3_002)).resolves.toEqual({
			crypto: expect.objectContaining({ updated: 1, failed: 0 }),
			fiat: null,
		});
		expect(request).toHaveBeenCalledTimes(3);

		await expect(
			refreshExchangeRates(db, request, 3_003, {
				category: "crypto",
				provider: disabledCrypto.provider,
				configuration: disabledCrypto,
			}),
		).resolves.toMatchObject({ updated: 1, failed: 0 });
		expect(request).toHaveBeenCalledTimes(4);
	});

	it("defaults missing and invalid automatic-sync settings safely", () => {
		expect(parseRateSyncConfiguration("crypto", undefined)).toMatchObject({
			enabled: true,
			provider: "binance",
			intervalMs: 3_600_000,
		});
		expect(
			parseRateSyncConfiguration(
				"crypto",
				JSON.stringify({ enabled: true, provider: "okx", intervalMs: 300_000 }),
			),
		).toMatchObject({ enabled: true, provider: "okx" });
		expect(parseRateSyncConfiguration("fiat", "invalid-json")).toMatchObject({
			enabled: true,
			provider: "exchangerate_host",
		});
	});

	it("loads one category and its secret-safe sync settings in one D1 batch", async () => {
		const counters = createDatastoreCounters();
		const result = await loadRatesPageData(instrumentD1(db, counters), "fiat");

		expect(result.rates).toEqual([
			expect.objectContaining({ id: "usd-cny", category: "fiat" }),
		]);
		expect(result.rates).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ category: "crypto" })]),
		);
		expect(result.syncSettings).toMatchObject({
			category: "fiat",
			provider: "exchangerate_host",
			hasCredentials: true,
		});
		expect(JSON.stringify(result)).not.toContain("fiat-test-key");
		expect(counters).toMatchObject({
			d1Prepare: 2,
			d1StatementBind: 2,
			d1Batch: 1,
			d1StatementAll: 0,
			d1StatementFirst: 0,
		});
	});
});
