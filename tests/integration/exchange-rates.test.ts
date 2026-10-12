import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	fetchCryptoRateQuotes,
	fetchExchangeRateQuote,
	fetchFiatRates,
	refreshExchangeRates,
	saveRateSyncConfiguration,
} from "#/features/payment-settings/server/exchange-rates";
import { applyMigrations } from "./migrations";

describe("exchange-rate refresh", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-rate-test" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source, adjustment_bps, observed_at, expires_at, created_at, updated_at) VALUES ('btc-usdt', 'crypto', 'BTC', 'USDT', '1', '1', 'binance', 0, 0, 0, 0, 0)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source, adjustment_bps, observed_at, expires_at, created_at, updated_at) VALUES ('eth-usdt', 'crypto', 'ETH', 'USDT', '1', '1', 'okx', 0, 0, 0, 0, 0)",
			)
			.run();
	});

	afterAll(async () => miniflare.dispose());
	afterEach(() => vi.restoreAllMocks());

	it("refreshes configured Binance pairs with a bounded validity window", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const request = vi.fn((_input: string, _init?: RequestInit) =>
			Promise.resolve(
				Response.json([
					{ symbol: "BTCUSDT", price: "62345.67000000" },
					{ symbol: "ETHUSDT", price: "3456.78000000" },
				]),
			),
		);
		const now = 1_800_000_000_000;
		await expect(refreshExchangeRates(db, request, now)).resolves.toEqual({
			configured: 2,
			updated: 2,
			failed: 0,
			failures: [],
		});
		expect(request).toHaveBeenCalledTimes(1);
		const requestedUrl = new URL(String(request.mock.calls[0]?.[0]));
		expect(requestedUrl.origin).toBe("https://data-api.binance.vision");
		expect(requestedUrl.pathname).toBe("/api/v3/ticker/price");
		expect(
			JSON.parse(requestedUrl.searchParams.get("symbols") ?? "[]"),
		).toEqual(["BTCUSDT", "ETHUSDT"]);
		const row = await db
			.prepare(
				"SELECT rate, observed_at, expires_at FROM exchange_rates WHERE id = 'btc-usdt'",
			)
			.first<{ rate: string; observed_at: number; expires_at: number }>();
		expect(row).toEqual({
			rate: "62345.67",
			observed_at: now,
			expires_at: now + 3_660_000,
		});
		const okx = await db
			.prepare("SELECT rate FROM exchange_rates WHERE id = 'eth-usdt'")
			.first<{ rate: string }>();
		expect(okx?.rate).toBe("3456.78");
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "binance",
				operation: "sync_crypto_rates",
				outcome: "success",
				requestCount: 1,
			}),
		);
	});

	it("isolates provider failures, preserves prior observations and audits a safe summary", async () => {
		const before = await db
			.prepare(
				"SELECT rate, observed_at, expires_at FROM exchange_rates WHERE id = 'eth-usdt'",
			)
			.first<{ rate: string; observed_at: number; expires_at: number }>();
		const now = 1_800_000_600_000;
		const request = vi.fn(() =>
			Promise.resolve(
				Response.json([{ symbol: "BTCUSDT", price: "63000.00" }]),
			),
		);
		await expect(refreshExchangeRates(db, request, now)).resolves.toEqual({
			configured: 2,
			updated: 1,
			failed: 1,
			failures: [
				{
					id: "eth-usdt",
					pair: "ETH/USDT",
					source: "binance",
					code: "missing_pair",
				},
			],
		});
		const after = await db
			.prepare(
				"SELECT rate, observed_at, expires_at FROM exchange_rates WHERE id = 'eth-usdt'",
			)
			.first<{ rate: string; observed_at: number; expires_at: number }>();
		expect(after).toEqual(before);
		const audit = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action = 'exchange_rates.refreshed' AND created_at = ?",
			)
			.bind(now)
			.first<{ after: string }>();
		expect(JSON.parse(audit?.after ?? "null")).toMatchObject({
			configured: 2,
			updated: 1,
			failed: 1,
			failures: [{ code: "missing_pair", pair: "ETH/USDT", source: "binance" }],
		});
		expect(audit?.after).not.toContain("down");
	});

	it("classifies HTTP status structurally without parsing arbitrary error text", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const rateLimitedAt = 1_800_000_700_000;
		await expect(
			refreshExchangeRates(
				db,
				() => Promise.resolve(new Response("provider detail", { status: 429 })),
				rateLimitedAt,
			),
		).resolves.toMatchObject({
			updated: 0,
			failed: 2,
			failures: [{ code: "http_429" }, { code: "http_429" }],
		});
		const audit = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action = 'exchange_rates.refreshed' AND created_at = ?",
			)
			.bind(rateLimitedAt)
			.first<{ after: string }>();
		expect(audit?.after).not.toContain("provider detail");
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "binance",
				operation: "sync_crypto_rates",
				outcome: "failure",
				status: "error",
				errorCode: "rate_limit",
				requestCount: 1,
			}),
		);
		expect(JSON.stringify(info.mock.calls)).not.toContain("provider detail");

		await expect(
			refreshExchangeRates(
				db,
				() => Promise.reject(new Error("transport mentioned HTTP 429")),
				rateLimitedAt + 1,
			),
		).resolves.toMatchObject({
			updated: 0,
			failed: 2,
			failures: [{ code: "provider_error" }, { code: "provider_error" }],
		});
	});

	it("fetches a normalized current quote when an automatic source is created", async () => {
		const binance = vi.fn(() =>
			Promise.resolve(
				Response.json({ symbol: "SOLUSDT", price: "153.42000000" }),
			),
		);
		await expect(
			fetchExchangeRateQuote("binance", "SOL", "USDT", binance),
		).resolves.toBe("153.42000000");
		expect(binance).toHaveBeenCalledWith(
			"https://data-api.binance.vision/api/v3/ticker/price?symbol=SOLUSDT",
			expect.objectContaining({ headers: { accept: "application/json" } }),
		);
	});

	it("maps product asset codes to provider market symbols", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ symbol: "POLUSDT", price: "0.42" }),
			)
			.mockResolvedValueOnce(
				Response.json({ symbol: "TONUSDT", price: "3.15" }),
			);
		await expect(
			fetchExchangeRateQuote("binance", "MATIC", "USDT", request),
		).resolves.toBe("0.42");
		await expect(
			fetchExchangeRateQuote("binance", "GRAM", "USDT", request),
		).resolves.toBe("3.15");
		expect(request.mock.calls.map(([url]) => url)).toEqual([
			"https://data-api.binance.vision/api/v3/ticker/price?symbol=POLUSDT",
			"https://data-api.binance.vision/api/v3/ticker/price?symbol=TONUSDT",
		]);
	});

	it("loads all seven built-in crypto pairs with one provider request", async () => {
		const pairs = ["TRX", "ETH", "BNB", "MATIC", "GRAM", "APT", "SOL"].map(
			(base) => ({ id: base.toLowerCase(), base, quote: "USDT" }),
		);
		const request = vi.fn(() =>
			Promise.resolve(
				Response.json(
					["TRX", "ETH", "BNB", "POL", "TON", "APT", "SOL"].map(
						(symbol, index) => ({
							symbol: `${symbol}USDT`,
							price: String(index + 1),
						}),
					),
				),
			),
		);
		const prices = await fetchCryptoRateQuotes("binance", pairs, request);
		expect(request).toHaveBeenCalledTimes(1);
		expect([...prices]).toEqual(
			pairs.map((pair, index) => [pair.id, String(index + 1)]),
		);
	});

	it("loads all seven built-in crypto pairs from current OKX market symbols", async () => {
		const pairs = ["TRX", "ETH", "BNB", "MATIC", "GRAM", "APT", "SOL"].map(
			(base) => ({ id: base.toLowerCase(), base, quote: "USDT" }),
		);
		const request = vi.fn((_input: string) =>
			Promise.resolve(
				Response.json({
					code: "0",
					data: ["TRX", "ETH", "BNB", "POL", "GRAM", "APT", "SOL"].map(
						(symbol, index) => ({ instId: `${symbol}-USDT`, last: String(index + 1) }),
					),
				}),
			),
		);
		const prices = await fetchCryptoRateQuotes("okx", pairs, request);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0]?.[0]).toBe(
			"https://www.okx.com/api/v5/market/tickers?instType=SPOT",
		);
		expect([...prices]).toEqual(
			pairs.map((pair, index) => [pair.id, String(index + 1)]),
		);
	});

	it("falls back to another official Binance endpoint when the Worker endpoint is blocked", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(new Response("restricted", { status: 451 }))
			.mockResolvedValueOnce(
				Response.json([{ symbol: "BTCUSDT", price: "62000.00" }]),
			);

		await expect(
			fetchCryptoRateQuotes(
				"binance",
				[{ id: "btc-usdt", base: "BTC", quote: "USDT" }],
				request,
			),
		).resolves.toEqual(new Map([["btc-usdt", "62000.00"]]));
		expect(request.mock.calls.map(([url]) => new URL(url).origin)).toEqual([
			"https://data-api.binance.vision",
			"https://api-gcp.binance.com",
		]);
	});

	it("rejects mismatched or unavailable automatic ticker responses", async () => {
		await expect(
			fetchExchangeRateQuote("okx", "BTC", "USDT", () =>
				Promise.resolve(
					Response.json({
						code: "0",
						data: [{ instId: "ETH-USDT", last: "1" }],
					}),
				),
			),
		).rejects.toThrow("did not return BTC-USDT");
		await expect(
			fetchExchangeRateQuote("binance", "BTC", "USDT", () =>
				Promise.resolve(new Response("unavailable", { status: 503 })),
			),
		).rejects.toThrow("HTTP 503");
	});

	it("uses the exchangerate.host USD default without requesting paid source switching", async () => {
		const request = vi.fn((_url: string) =>
			Promise.resolve(
				Response.json({
					success: true,
					quotes: { USDCNY: 7.12, USDEUR: 0.92 },
				}),
			),
		);
		await expect(
			fetchFiatRates("USD", ["CNY", "EUR"], request, undefined, "secret"),
		).resolves.toEqual({ CNY: "7.12", EUR: "0.92" });
		const requestedUrl = new URL(String(request.mock.calls[0]?.[0]));
		expect(requestedUrl.searchParams.get("source")).toBeNull();
		expect(requestedUrl.searchParams.get("currencies")).toBe("CNY,EUR");
	});

	it("requests the complete fiat table when no symbols are specified", async () => {
		const request = vi.fn((_url: string) =>
			Promise.resolve(
				Response.json({
					success: true,
					quotes: { USDCNY: 7.12, USDJPY: 155.2 },
				}),
			),
		);
		await expect(
			fetchFiatRates("USD", [], request, undefined, "secret"),
		).resolves.toEqual({ CNY: "7.12", JPY: "155.2" });
		const requestedUrl = new URL(String(request.mock.calls[0]?.[0]));
		expect(requestedUrl.searchParams.get("currencies")).toBeNull();
		expect(requestedUrl.searchParams.get("source")).toBeNull();
	});

	it("persists every valid fiat quote returned by the provider", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const now = 1_800_001_000_000;
		const request = vi.fn(() =>
			Promise.resolve(
				Response.json({
					success: true,
					quotes: { USDCNY: 7.12, USDJPY: 155.2, USDEUR: 0.92, USDXAU: 0.0004 },
				}),
			),
		);
		await expect(
			refreshExchangeRates(db, request, now, {
				category: "fiat",
				apiKey: "secret",
			}),
		).resolves.toMatchObject({ configured: 4, updated: 4, failed: 0 });
		const rows = await db
			.prepare(
				"SELECT base, quote, raw_rate, rate, adjustment_bps, source FROM exchange_rates WHERE category = 'fiat' ORDER BY quote",
			)
			.all<{
				base: string;
				quote: string;
				raw_rate: string;
				rate: string;
				adjustment_bps: number;
				source: string;
			}>();
		expect(rows.results).toEqual([
			{
				base: "USD",
				quote: "CNY",
				raw_rate: "7.12",
				rate: "7.12",
				adjustment_bps: 0,
				source: "exchangerate_host",
			},
			{
				base: "USD",
				quote: "EUR",
				raw_rate: "0.92",
				rate: "0.92",
				adjustment_bps: 0,
				source: "exchangerate_host",
			},
			{
				base: "USD",
				quote: "JPY",
				raw_rate: "155.2",
				rate: "155.2",
				adjustment_bps: 0,
				source: "exchangerate_host",
			},
			{
				base: "USD",
				quote: "XAU",
				raw_rate: "0.0004",
				rate: "0.0004",
				adjustment_bps: 0,
				source: "exchangerate_host",
			},
		]);
		await saveRateSyncConfiguration(
			db,
			"fiat",
			{
				enabled: true,
				provider: "exchangerate_host",
				intervalMs: 86_400_000,
				adjustmentBps: 125,
				credentials: { apiKey: "secret" },
				lastSyncedAt: now,
			},
			null,
			now,
		);
		await refreshExchangeRates(db, request, now + 1, {
			category: "fiat",
			apiKey: "secret",
		});
		const adjusted = await db
			.prepare(
				"SELECT raw_rate, rate, adjustment_bps FROM exchange_rates WHERE base = 'USD' AND quote = 'CNY'",
			)
			.first<{ raw_rate: string; rate: string; adjustment_bps: number }>();
		expect(adjusted).toEqual({
			raw_rate: "7.12",
			rate: "7.209",
			adjustment_bps: 125,
		});
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "exchangerate_host",
				operation: "sync_fiat_rates",
				outcome: "success",
				requestCount: 1,
			}),
		);
	});

	it("surfaces exchangerate.host API errors without exposing credentials", async () => {
		await expect(
			fetchFiatRates(
				"USD",
				["CNY"],
				() =>
					Promise.resolve(
						Response.json({
							success: false,
							error: { code: 101, type: "invalid_access_key" },
						}),
					),
				undefined,
				"top-secret",
			),
		).rejects.toThrow("API error 101");
	});
});

