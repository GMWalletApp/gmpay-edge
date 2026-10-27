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
	fetchAllRatesTodayFiatRates,
	fetchExchangeRateQuote,
	fetchFiatRates,
	refreshExchangeRates,
	refreshRateCategoryIfDue,
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

	it("refreshes fiat rates from the keyless AllRatesToday source", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		const now = 1_800_002_000_000;
		// Published one hour before the sync; next table announced for +24h.
		const publishedUnix = Math.floor(now / 1000) - 3_600;
		const request = vi.fn((_url: string, _init?: RequestInit) =>
			Promise.resolve(
				Response.json({
					result: "success",
					base_code: "USD",
					time_last_update_unix: publishedUnix,
					time_next_update_unix: publishedUnix + 86_400,
					rates: { USD: 1, CNY: 7.1, EUR: 0.86 },
				}),
			),
		);
		await expect(
			refreshExchangeRates(db, request, now, {
				category: "fiat",
				configuration: {
					enabled: true,
					provider: "allratestoday",
					intervalMs: 86_400_000,
					adjustmentBps: 0,
					credentials: { apiKey: "" },
					lastSyncedAt: null,
				},
			}),
		).resolves.toMatchObject({ configured: 2, updated: 2, failed: 0 });
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0]?.[0]).toBe(
			"https://allratestoday.com/api/open/latest/USD",
		);
		const rows = await db
			.prepare(
				"SELECT quote, raw_rate, source FROM exchange_rates WHERE category = 'fiat' AND quote IN ('CNY', 'EUR', 'JPY') ORDER BY quote",
			)
			.all<{ quote: string; raw_rate: string; source: string }>();
		expect(rows.results).toEqual([
			{ quote: "CNY", raw_rate: "7.1", source: "allratestoday" },
			{ quote: "EUR", raw_rate: "0.86", source: "allratestoday" },
			{ quote: "JPY", raw_rate: "155.2", source: "exchangerate_host" },
		]);
		// observed_at is the provider's publication time, not the fetch time,
		// and validity ends 12h after the announced next update.
		const timing = await db
			.prepare(
				"SELECT observed_at, expires_at FROM exchange_rates WHERE category = 'fiat' AND quote = 'EUR'",
			)
			.first<{ observed_at: number; expires_at: number }>();
		expect(timing).toEqual({
			observed_at: publishedUnix * 1000,
			expires_at: (publishedUnix + 86_400) * 1000 + 12 * 3_600_000,
		});
		await expect(
			fetchAllRatesTodayFiatRates(() =>
				Promise.resolve(
					Response.json(
						{ result: "error", "error-type": "unsupported-code" },
						{ status: 400 },
					),
				),
			),
		).rejects.toThrow("HTTP 400");
	});

	it("refuses AllRatesToday payloads with a wrong or missing base and leaves stored USD rows untouched", async () => {
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		const now = 1_800_002_500_000;
		const publishedUnix = Math.floor(now / 1000) - 600;
		const before = await db
			.prepare(
				"SELECT quote, raw_rate, source, observed_at, expires_at FROM exchange_rates WHERE category = 'fiat' ORDER BY quote",
			)
			.all();
		const configuration = {
			category: "fiat" as const,
			configuration: {
				enabled: true,
				provider: "allratestoday" as const,
				intervalMs: 86_400_000,
				adjustmentBps: 0,
				credentials: { apiKey: "" },
				lastSyncedAt: null,
			},
		};
		const payloads = [
			// EUR table served where a USD one was requested
			{
				result: "success",
				base_code: "EUR",
				time_last_update_unix: publishedUnix,
				rates: { USD: 1.16, CNY: 8.3 },
			},
			// base omitted entirely
			{
				result: "success",
				time_last_update_unix: publishedUnix,
				rates: { USD: 1, CNY: 7.1 },
			},
			// publication time missing
			{ result: "success", base_code: "USD", rates: { USD: 1, CNY: 7.1 } },
		];
		for (const payload of payloads) {
			await expect(
				refreshExchangeRates(
					db,
					() => Promise.resolve(Response.json(payload)),
					now,
					configuration,
				),
			).resolves.toMatchObject({
				updated: 0,
				failed: 1,
				failures: [{ source: "allratestoday", code: "provider_error" }],
			});
		}
		const after = await db
			.prepare(
				"SELECT quote, raw_rate, source, observed_at, expires_at FROM exchange_rates WHERE category = 'fiat' ORDER BY quote",
			)
			.all();
		expect(after.results).toEqual(before.results);
	});

	it("does not renew validity when AllRatesToday keeps serving the same snapshot, and refuses stale ones", async () => {
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		const configuration = {
			category: "fiat" as const,
			configuration: {
				enabled: true,
				provider: "allratestoday" as const,
				intervalMs: 86_400_000,
				adjustmentBps: 0,
				credentials: { apiKey: "" },
				lastSyncedAt: null,
			},
		};
		const firstSync = 1_800_010_000_000;
		const publishedUnix = Math.floor(firstSync / 1000) - 3_600;
		const snapshot = {
			result: "success",
			base_code: "USD",
			time_last_update_unix: publishedUnix,
			time_next_update_unix: publishedUnix + 86_400,
			rates: { USD: 1, EUR: 0.87 },
		};
		await expect(
			refreshExchangeRates(
				db,
				() => Promise.resolve(Response.json(snapshot)),
				firstSync,
				configuration,
			),
		).resolves.toMatchObject({ updated: 1, failed: 0 });
		const read = () =>
			db
				.prepare(
					"SELECT raw_rate, observed_at, expires_at FROM exchange_rates WHERE category = 'fiat' AND quote = 'EUR'",
				)
				.first<{ raw_rate: string; observed_at: number; expires_at: number }>();
		const stored = await read();
		expect(stored).toEqual({
			raw_rate: "0.87",
			observed_at: publishedUnix * 1000,
			expires_at: (publishedUnix + 86_400) * 1000 + 12 * 3_600_000,
		});
		// Two days later the provider still serves the identical snapshot:
		// the row keeps its original observation and expiry (now in the past)
		// instead of being re-published as a fresh 24h observation.
		const secondSync = firstSync + 2 * 86_400_000;
		await expect(
			refreshExchangeRates(
				db,
				() => Promise.resolve(Response.json(snapshot)),
				secondSync,
				configuration,
			),
		).resolves.toMatchObject({ updated: 0, failed: 0 });
		expect(await read()).toEqual(stored);
		// Six days later the same snapshot is refused outright.
		await expect(
			refreshExchangeRates(
				db,
				() => Promise.resolve(Response.json(snapshot)),
				firstSync + 6 * 86_400_000,
				configuration,
			),
		).resolves.toMatchObject({
			updated: 0,
			failed: 1,
			failures: [{ source: "allratestoday", code: "provider_error" }],
		});
		expect(await read()).toEqual(stored);
		// A genuinely newer publication replaces it.
		const newerUnix = publishedUnix + 86_400;
		await expect(
			refreshExchangeRates(
				db,
				() =>
					Promise.resolve(
						Response.json({
							...snapshot,
							time_last_update_unix: newerUnix,
							time_next_update_unix: newerUnix + 86_400,
							rates: { USD: 1, EUR: 0.88 },
						}),
					),
				secondSync,
				configuration,
			),
		).resolves.toMatchObject({ updated: 1, failed: 0 });
		expect(await read()).toEqual({
			raw_rate: "0.88",
			observed_at: newerUnix * 1000,
			expires_at: (newerUnix + 86_400) * 1000 + 12 * 3_600_000,
		});
	});

	it("keeps prior fiat rows and reports a structured failure when AllRatesToday is rate limited or down", async () => {
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		const before = await db
			.prepare(
				"SELECT quote, raw_rate, source FROM exchange_rates WHERE category = 'fiat' ORDER BY quote",
			)
			.all<{ quote: string; raw_rate: string; source: string }>();
		const configuration = {
			category: "fiat" as const,
			configuration: {
				enabled: true,
				provider: "allratestoday" as const,
				intervalMs: 86_400_000,
				adjustmentBps: 0,
				credentials: { apiKey: "" },
				lastSyncedAt: null,
			},
		};
		await expect(
			refreshExchangeRates(
				db,
				() => Promise.resolve(new Response("slow down", { status: 429 })),
				1_800_003_000_000,
				configuration,
			),
		).resolves.toMatchObject({
			updated: 0,
			failed: 1,
			failures: [{ source: "allratestoday", code: "http_429" }],
		});
		await expect(
			refreshExchangeRates(
				db,
				() => Promise.reject(new Error("socket hang up")),
				1_800_003_000_001,
				configuration,
			),
		).resolves.toMatchObject({
			updated: 0,
			failed: 1,
			failures: [{ source: "allratestoday", code: "provider_error" }],
		});
		const after = await db
			.prepare(
				"SELECT quote, raw_rate, source FROM exchange_rates WHERE category = 'fiat' ORDER BY quote",
			)
			.all<{ quote: string; raw_rate: string; source: string }>();
		expect(after.results).toEqual(before.results);
	});

	it("runs the keyless provider on schedule without an API key but still gates exchangerate.host on one", async () => {
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		const request = vi.fn(() =>
			Promise.resolve(
				Response.json({
					result: "success",
					base_code: "USD",
					time_last_update_unix: 1_800_004_000 - 3_600,
					rates: { USD: 1, EUR: 0.86 },
				}),
			),
		);
		const base = {
			enabled: true,
			intervalMs: 86_400_000,
			adjustmentBps: 0,
			credentials: { apiKey: "" },
			lastSyncedAt: null,
		};
		await expect(
			refreshRateCategoryIfDue(db, "fiat", request, 1_800_004_000_000, {
				...base,
				provider: "exchangerate_host",
			}),
		).resolves.toBeNull();
		expect(request).not.toHaveBeenCalled();
		await expect(
			refreshRateCategoryIfDue(db, "fiat", request, 1_800_004_000_000, {
				...base,
				provider: "allratestoday",
			}),
		).resolves.toMatchObject({ failed: 0 });
		expect(request).toHaveBeenCalledTimes(1);
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
