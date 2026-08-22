import { z } from "zod";
import { applyBasisPoints } from "#/features/payment-settings/server/rates";
import type { AdapterErrorKind } from "#/integrations/chains/types";
import { observeProviderOperation } from "#/integrations/provider-observability";

const binanceTickerSchema = z.object({
	symbol: z.string(),
	price: z.string().regex(/^\d+(?:\.\d+)?$/),
});
const binanceTickersSchema = z.array(binanceTickerSchema);
const binanceMarketDataUrls = [
	"https://data-api.binance.vision",
	"https://api-gcp.binance.com",
	"https://api.binance.com",
] as const;
const okxTickerSchema = z.object({
	code: z.literal("0"),
	data: z.array(
		z.object({
			instId: z.string(),
			last: z.string().regex(/^\d+(?:\.\d+)?$/),
		}),
	),
});
const okxTickersSchema = z.object({
	code: z.literal("0"),
	data: z.array(z.object({ instId: z.string(), last: z.string() })),
});
const fiatRatesSchema = z.looseObject({
	success: z.boolean().optional(),
	rates: z.record(z.string(), z.number().positive()).optional(),
	quotes: z.record(z.string(), z.number().positive()).optional(),
	error: z
		.object({
			code: z.union([z.string(), z.number()]).optional(),
			type: z.string().optional(),
		})
		.optional(),
});

class ExchangeRateProviderError extends Error {
	readonly failureCode: `http_${number}` | "provider_error";

	constructor(message: string, status?: number) {
		super(message);
		this.name = "ExchangeRateProviderError";
		this.failureCode = status ? `http_${status}` : "provider_error";
	}
}

export type RateSyncCategory = "crypto" | "fiat";
export type CryptoRateSyncConfiguration = {
	enabled: boolean;
	provider: "binance" | "okx";
	intervalMs: number;
	adjustmentBps: number;
	lastSyncedAt: number | null;
};
export type FiatRateSyncConfiguration = {
	enabled: boolean;
	provider: "exchangerate_host";
	intervalMs: number;
	adjustmentBps: number;
	credentials: { apiKey: string };
	lastSyncedAt: number | null;
};
export type RateSyncConfiguration =
	| CryptoRateSyncConfiguration
	| FiatRateSyncConfiguration;
type ExchangeRateRow = {
	id: string;
	category: RateSyncCategory;
	base: string;
	quote: string;
	raw_rate: string | null;
	rate: string | null;
	source: string;
	observed_at: number;
	expires_at: number;
	adjustment_bps: number;
};

export const defaultCryptoRateSync: CryptoRateSyncConfiguration = {
	enabled: true,
	provider: "binance",
	intervalMs: 3_600_000,
	adjustmentBps: 0,
	lastSyncedAt: null,
};
export const defaultFiatRateSync: FiatRateSyncConfiguration = {
	enabled: true,
	provider: "exchangerate_host",
	intervalMs: 86_400_000,
	adjustmentBps: 0,
	credentials: { apiKey: "" },
	lastSyncedAt: null,
};

export async function loadRateSyncConfiguration(
	db: D1Database,
	category: "crypto",
): Promise<CryptoRateSyncConfiguration>;
export async function loadRateSyncConfiguration(
	db: D1Database,
	category: "fiat",
): Promise<FiatRateSyncConfiguration>;
export async function loadRateSyncConfiguration(
	db: D1Database,
	category: RateSyncCategory,
) {
	const row = await db
		.prepare("SELECT value FROM system_settings WHERE key = ?")
		.bind(`rates.${category}_sync`)
		.first<{ value: string }>();
	return parseRateSyncConfiguration(category, row?.value);
}

export function parseRateSyncConfiguration(
	category: "crypto",
	value: string | null | undefined,
): CryptoRateSyncConfiguration;
export function parseRateSyncConfiguration(
	category: "fiat",
	value: string | null | undefined,
): FiatRateSyncConfiguration;
export function parseRateSyncConfiguration(
	category: RateSyncCategory,
	value: string | null | undefined,
): RateSyncConfiguration;
export function parseRateSyncConfiguration(
	category: RateSyncCategory,
	value: string | null | undefined,
) {
	const fallback =
		category === "crypto" ? defaultCryptoRateSync : defaultFiatRateSync;
	if (!value) return structuredClone(fallback);
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return structuredClone(fallback);
		const record = parsed as Record<string, unknown>;
		const intervalMs =
			typeof record.intervalMs === "number" &&
			Number.isInteger(record.intervalMs) &&
			record.intervalMs >= 60_000
				? record.intervalMs
				: fallback.intervalMs;
		const lastSyncedAt =
			typeof record.lastSyncedAt === "number" ? record.lastSyncedAt : null;
		if (category === "crypto")
			return {
				enabled: record.enabled === true,
				provider: record.provider === "okx" ? "okx" : "binance",
				intervalMs,
				adjustmentBps: validAdjustmentBps(record.adjustmentBps),
				lastSyncedAt,
			} satisfies CryptoRateSyncConfiguration;
		const credentials =
			record.credentials && typeof record.credentials === "object"
				? (record.credentials as Record<string, unknown>)
				: {};
		return {
			enabled: record.enabled === true,
			provider: "exchangerate_host",
			intervalMs,
			adjustmentBps: validAdjustmentBps(record.adjustmentBps),
			credentials: {
				apiKey:
					typeof credentials.apiKey === "string" ? credentials.apiKey : "",
			},
			lastSyncedAt,
		} satisfies FiatRateSyncConfiguration;
	} catch {
		return structuredClone(fallback);
	}
}

export async function loadRatesPageData(
	db: D1Database,
	category: RateSyncCategory,
) {
	const [rates, storedConfiguration] = await db.batch([
		db
			.prepare(
				`SELECT er.id, er.category, er.base, er.quote, er.raw_rate, er.rate,
				 er.source, er.adjustment_bps, er.observed_at, er.expires_at
				 FROM exchange_rates er WHERE er.category = ?
				 ORDER BY er.base, er.quote, er.source`,
			)
			.bind(category),
		db
			.prepare("SELECT value FROM system_settings WHERE key = ?")
			.bind(`rates.${category}_sync`),
	]);
	const rateRows = (rates as D1Result<ExchangeRateRow>).results;
	const configurationValue = (
		storedConfiguration as D1Result<{ value: string }>
	).results[0]?.value;
	if (category === "crypto")
		return {
			rates: rateRows,
			syncSettings: {
				category,
				...parseRateSyncConfiguration(category, configurationValue),
			},
		};
	const configuration = parseRateSyncConfiguration(
		category,
		configurationValue,
	);
	return {
		rates: rateRows,
		syncSettings: {
			category,
			enabled: configuration.enabled,
			provider: configuration.provider,
			intervalMs: configuration.intervalMs,
			adjustmentBps: configuration.adjustmentBps,
			lastSyncedAt: configuration.lastSyncedAt,
			hasCredentials: Boolean(configuration.credentials.apiKey),
		},
	};
}

export async function saveRateSyncConfiguration(
	db: D1Database,
	category: RateSyncCategory,
	configuration: CryptoRateSyncConfiguration | FiatRateSyncConfiguration,
	updatedBy: string | null,
	now = Date.now(),
) {
	await db
		.prepare(
			`INSERT INTO system_settings
			 (key, value, is_secret, updated_by, created_at, updated_at)
			 VALUES (?, ?, 0, ?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			 updated_by = COALESCE(excluded.updated_by, system_settings.updated_by),
			 updated_at = excluded.updated_at`,
		)
		.bind(
			`rates.${category}_sync`,
			JSON.stringify(configuration),
			updatedBy,
			now,
			now,
		)
		.run();
}

export async function refreshDueExchangeRates(
	db: D1Database,
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	now = Date.now(),
) {
	const [cryptoResult, fiatResult] = await Promise.all([
		refreshRateCategoryIfDue(db, "crypto", request, now),
		refreshRateCategoryIfDue(db, "fiat", request, now),
	]);
	return { crypto: cryptoResult, fiat: fiatResult };
}

export async function refreshRateCategoryIfDue(
	db: D1Database,
	category: RateSyncCategory,
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	now = Date.now(),
	configuration?: RateSyncConfiguration,
) {
	if (category === "crypto") {
		const cryptoConfiguration =
			(configuration as CryptoRateSyncConfiguration | undefined) ??
			(await loadRateSyncConfiguration(db, "crypto"));
		if (!cryptoConfiguration.enabled) return null;
		if (
			cryptoConfiguration.lastSyncedAt !== null &&
			now - cryptoConfiguration.lastSyncedAt < cryptoConfiguration.intervalMs
		)
			return null;
		return assertScheduledRateResult(
			await refreshExchangeRates(db, request, now, {
				category,
				provider: cryptoConfiguration.provider,
				configuration: cryptoConfiguration,
			}),
		);
	}
	const fiatConfiguration =
		(configuration as FiatRateSyncConfiguration | undefined) ??
		(await loadRateSyncConfiguration(db, "fiat"));
	if (
		!fiatConfiguration.enabled ||
		!fiatConfiguration.credentials.apiKey ||
		(fiatConfiguration.lastSyncedAt !== null &&
			now - fiatConfiguration.lastSyncedAt < fiatConfiguration.intervalMs)
	)
		return null;
	return assertScheduledRateResult(
		await refreshExchangeRates(db, request, now, {
			category,
			apiKey: fiatConfiguration.credentials.apiKey,
			configuration: fiatConfiguration,
		}),
	);
}

function assertScheduledRateResult(
	result: Awaited<ReturnType<typeof refreshExchangeRates>>,
) {
	if (result.failed > 0)
		throw new Error(`Rate synchronization failed for ${result.failed} pair(s)`);
	return result;
}

export async function refreshExchangeRates(
	db: D1Database,
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	now = Date.now(),
	context: {
		category?: "crypto" | "fiat";
		provider?: "binance" | "okx";
		apiKey?: string | null;
		configuration?: RateSyncConfiguration;
		actorUserId?: string | null;
		requestId?: string | null;
		ipAddress?: string | null;
	} = {},
) {
	const category = context.category ?? "crypto";
	const cryptoConfiguration =
		category === "crypto"
			? ((context.configuration as CryptoRateSyncConfiguration | undefined) ??
				(await loadRateSyncConfiguration(db, "crypto")))
			: null;
	const fiatConfiguration =
		category === "fiat"
			? ((context.configuration as FiatRateSyncConfiguration | undefined) ??
				(await loadRateSyncConfiguration(db, "fiat")))
			: null;
	const provider =
		context.provider ?? cryptoConfiguration?.provider ?? "binance";
	const configured = await db
		.prepare(
			"SELECT id, base, quote FROM exchange_rates WHERE category = ? ORDER BY base, quote",
		)
		.bind(category)
		.all<{ id: string; base: string; quote: string }>();
	let configuredCount = configured.results.length;
	let updated = 0;
	const allFailures: Array<{
		id: string;
		pair: string;
		source: "binance" | "okx" | "exchangerate_host";
		code: string;
	}> = [];
	if (category === "crypto") {
		try {
			const prices = await observeProviderOperation(
				{
					adapter: provider,
					operation: "sync_crypto_rates",
					classifyError: classifyExchangeRateError,
				},
				(counters) => {
					counters.request();
					return fetchCryptoRateQuotes(provider, configured.results, request);
				},
			);
			const adjustmentBps = cryptoConfiguration?.adjustmentBps ?? 0;
			const validityMs =
				(cryptoConfiguration?.intervalMs ?? defaultCryptoRateSync.intervalMs) +
				60_000;
			const available = configured.results.flatMap((rate) => {
				const price = prices.get(rate.id);
				if (!price) {
					allFailures.push({
						id: rate.id,
						pair: `${rate.base}/${rate.quote}`,
						source: provider,
						code: "missing_pair",
					});
					return [];
				}
				return [{ rate, price }];
			});
			const results = available.length
				? await db.batch(
						available.map(({ rate, price }) =>
							db
								.prepare(
									`UPDATE exchange_rates SET raw_rate = ?, rate = ?, source = ?, adjustment_bps = ?,
									 observed_at = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
								)
								.bind(
									price,
									applyBasisPoints(price, adjustmentBps),
									provider,
									adjustmentBps,
									now,
									now + validityMs,
									now,
									rate.id,
								),
						),
					)
				: [];
			updated = results.reduce(
				(sum, result) => sum + (result.meta.changes ?? 0),
				0,
			);
		} catch (error) {
			const code = exchangeRateErrorCode(error);
			allFailures.push(
				...configured.results.map((rate) => ({
					id: rate.id,
					pair: `${rate.base}/${rate.quote}`,
					source: provider,
					code,
				})),
			);
		}
	} else {
		try {
			const apiKey =
				context.apiKey ?? fiatConfiguration?.credentials.apiKey ?? null;
			if (!apiKey)
				throw new Error("exchangerate_host API Key is not configured");
			const rates = await observeProviderOperation(
				{
					adapter: "exchangerate_host",
					operation: "sync_fiat_rates",
					classifyError: classifyExchangeRateError,
				},
				(counters) => {
					counters.request();
					return fetchFiatRates(
						"USD",
						[],
						request,
						"https://api.exchangerate.host",
						apiKey,
					);
				},
			);
			const snapshots = Object.entries(rates)
				.filter(([quote]) => /^[A-Z]{3}$/.test(quote) && quote !== "USD")
				.map(([quote, rawRate]) => ({ quote, rawRate }));
			const results = await db.batch(
				snapshots.map((snapshot) =>
					db
						.prepare(
							`INSERT INTO exchange_rates
							 (id, category, base, quote, raw_rate, rate, source, adjustment_bps,
							  observed_at, expires_at, created_at, updated_at)
							 VALUES (?, 'fiat', 'USD', ?, ?, ?, 'exchangerate_host', ?, ?, ?, ?, ?)
							 ON CONFLICT(category, base, quote) DO UPDATE SET
							 raw_rate = excluded.raw_rate, rate = excluded.rate,
							 source = excluded.source, adjustment_bps = excluded.adjustment_bps,
							 observed_at = excluded.observed_at, expires_at = excluded.expires_at,
							 updated_at = excluded.updated_at`,
						)
						.bind(
							`rate-usd-${snapshot.quote.toLowerCase()}`,
							snapshot.quote,
							snapshot.rawRate,
							applyBasisPoints(
								snapshot.rawRate,
								fiatConfiguration?.adjustmentBps ?? 0,
							),
							fiatConfiguration?.adjustmentBps ?? 0,
							now,
							now + 24 * 60 * 60_000,
							now,
							now,
						),
				),
			);
			updated = results.reduce(
				(sum, result) => sum + (result.meta.changes ?? 0),
				0,
			);
			configuredCount = snapshots.length;
		} catch (error) {
			allFailures.push({
				id: "fiat",
				pair: "USD/fiat",
				source: "exchangerate_host",
				code: exchangeRateErrorCode(error),
			});
		}
	}
	const result = {
		configured: configuredCount,
		updated,
		failed: allFailures.length,
		failures: allFailures,
	};
	if (result.updated > 0 && result.failed === 0) {
		const nextConfiguration =
			category === "crypto"
				? {
						...(cryptoConfiguration ?? defaultCryptoRateSync),
						provider,
						lastSyncedAt: now,
					}
				: { ...(fiatConfiguration ?? defaultFiatRateSync), lastSyncedAt: now };
		await saveRateSyncConfiguration(
			db,
			category,
			nextConfiguration,
			context.actorUserId ?? null,
			now,
		);
	}
	if (result.configured && (context.actorUserId || allFailures.length > 0)) {
		await db
			.prepare(
				`INSERT INTO audit_logs
				(id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
				VALUES (?, ?, 'exchange_rates.refreshed', 'exchange_rates', NULL, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				context.actorUserId ?? null,
				context.requestId ?? null,
				context.ipAddress ?? null,
				JSON.stringify(result),
				now,
			)
			.run();
	}
	return result;
}

export async function fetchExchangeRateQuote(
	source: "binance" | "okx",
	base: string,
	quote: string,
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	apiUrl?: string | null,
	apiKey?: string | null,
) {
	const symbol = providerSymbol(source, base, quote);
	const path =
		source === "okx"
			? `/api/v5/market/ticker?instId=${encodeURIComponent(symbol)}`
			: `/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
	const response = await fetchRateProviderResponse(
		source,
		path,
		request,
		apiUrl,
		apiKey,
	);
	const payload: unknown = await response.json();
	const price =
		source === "okx"
			? okxPrice(payload, symbol)
			: binancePrice(payload, symbol);
	if (!price) throw new Error(`${source} ticker did not return ${symbol}`);
	return price;
}

export async function fetchCryptoRateQuotes(
	source: "binance" | "okx",
	pairs: Array<{ id: string; base: string; quote: string }>,
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	apiUrl?: string | null,
) {
	const symbols = new Map(
		pairs.map((pair) => [
			providerSymbol(source, pair.base, pair.quote),
			pair.id,
		]),
	);
	const path =
		source === "okx"
			? "/api/v5/market/tickers?instType=SPOT"
			: `/api/v3/ticker/price?${new URLSearchParams({
					symbols: JSON.stringify([...symbols.keys()]),
				})}`;
	const response = await fetchRateProviderResponse(
		source,
		path,
		request,
		apiUrl,
	);
	const payload: unknown = await response.json();
	const tickers =
		source === "okx"
			? okxTickersSchema.parse(payload).data.map((ticker) => ({
					symbol: ticker.instId,
					price: ticker.last,
				}))
			: binanceTickersSchema.parse(payload);
	const prices = new Map<string, string>();
	for (const ticker of tickers) {
		const id = symbols.get(ticker.symbol.toUpperCase());
		if (id && /^\d+(?:\.\d+)?$/.test(ticker.price))
			prices.set(id, ticker.price);
	}
	return prices;
}

export async function fetchFiatRates(
	base: string,
	symbols: string[],
	request: (input: string, init?: RequestInit) => Promise<Response> = fetch as (
		input: string,
		init?: RequestInit,
	) => Promise<Response>,
	apiUrl = "https://api.exchangerate.host",
	apiKey?: string | null,
) {
	const root = apiUrl.replace(/\/$/, "");
	if (!apiKey) throw new Error("exchangerate_host API Key is required");
	const params = new URLSearchParams({ access_key: apiKey });
	if (symbols.length > 0)
		params.set(
			"currencies",
			symbols.map((symbol) => symbol.toUpperCase()).join(","),
		);
	// USD is exchangerate.host's default source. Sending source=USD needlessly
	// exercises the paid "source currency switching" feature on free plans.
	if (base.toUpperCase() !== "USD") params.set("source", base.toUpperCase());
	const response = await request(`${root}/live?${params}`, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(8_000),
	});
	if (!response.ok)
		throw new ExchangeRateProviderError(
			`exchangerate_host returned HTTP ${response.status}`,
			response.status,
		);
	const payload = fiatRatesSchema.parse(await response.json());
	if (payload.success === false) {
		const providerCode = payload.error?.code ?? payload.error?.type;
		throw new ExchangeRateProviderError(
			`exchangerate_host API error${providerCode ? ` ${providerCode}` : ""}`,
		);
	}
	if (!payload.rates && !payload.quotes)
		throw new Error("exchangerate_host response did not contain rates");
	const entries: Array<[string, number]> = payload.rates
		? Object.entries(payload.rates)
		: Object.entries(payload.quotes ?? {}).map(([pair, rate]) => [
				pair.toUpperCase().startsWith(base.toUpperCase())
					? pair.slice(base.length)
					: pair,
				rate,
			]);
	return Object.fromEntries(
		entries.map(([quote, rate]) => [quote.toUpperCase(), String(rate)]),
	);
}

function defaultRateSourceUrl(source: "binance" | "okx") {
	return source === "okx"
		? "https://www.okx.com"
		: "https://data-api.binance.vision";
}

async function fetchRateProviderResponse(
	source: "binance" | "okx",
	path: string,
	request: (input: string, init?: RequestInit) => Promise<Response>,
	apiUrl?: string | null,
	apiKey?: string | null,
) {
	const roots = apiUrl
		? [apiUrl]
		: source === "binance"
			? binanceMarketDataUrls
			: [defaultRateSourceUrl(source)];
	let lastError: unknown;

	for (const [index, candidate] of roots.entries()) {
		const isLast = index === roots.length - 1;
		try {
			const response = await request(`${candidate.replace(/\/$/, "")}${path}`, {
				headers: {
					accept: "application/json",
					...(apiKey ? { "x-api-key": apiKey } : {}),
				},
				signal: AbortSignal.timeout(source === "binance" ? 5_000 : 8_000),
			});
			if (response.ok) return response;

			const error = new ExchangeRateProviderError(
				`${source} ticker returned HTTP ${response.status}`,
				response.status,
			);
			if (isLast || !isBinanceEndpointFailure(response.status)) throw error;
			lastError = error;
		} catch (error) {
			if (isLast || !isNetworkFailure(error)) throw error;
			lastError = error;
		}
	}

	throw lastError;
}

function isBinanceEndpointFailure(status: number) {
	return status === 403 || status === 451 || status >= 500;
}

function isNetworkFailure(error: unknown) {
	return (
		error instanceof TypeError ||
		error instanceof DOMException ||
		(error instanceof Error && error.name === "TimeoutError")
	);
}

function providerSymbol(
	source: "binance" | "okx",
	base: string,
	quote: string,
) {
	const marketBase = providerMarketAsset(base);
	const marketQuote = providerMarketAsset(quote);
	return source === "okx"
		? `${marketBase}-${marketQuote}`.toUpperCase()
		: `${marketBase}${marketQuote}`.toUpperCase();
}

function providerMarketAsset(asset: string) {
	const normalized = asset.toUpperCase();
	if (normalized === "MATIC") return "POL";
	if (normalized === "GRAM") return "TON";
	return normalized;
}

function binancePrice(payload: unknown, symbol: string) {
	const ticker = binanceTickerSchema.parse(payload);
	return ticker.symbol.toUpperCase() === symbol ? ticker.price : null;
}

function okxPrice(payload: unknown, symbol: string) {
	const ticker = okxTickerSchema.parse(payload).data[0];
	return ticker?.instId.toUpperCase() === symbol ? ticker.last : null;
}

function exchangeRateErrorCode(error: unknown) {
	if (error instanceof ExchangeRateProviderError) return error.failureCode;
	if (error instanceof Error) {
		if (error.name === "TimeoutError") return "timeout";
		if (error instanceof z.ZodError) return "invalid_response";
	}
	return "provider_error";
}

function classifyExchangeRateError(error: unknown): AdapterErrorKind {
	if (error instanceof ExchangeRateProviderError) {
		const status = Number(error.failureCode.slice("http_".length));
		if (status === 401 || status === 403) return "authentication";
		if (status === 429) return "rate_limit";
		if (status >= 500) return "network";
		return error.failureCode === "provider_error"
			? "invalid_response"
			: "permanent";
	}
	if (error instanceof z.ZodError) return "invalid_response";
	if (error instanceof TypeError || error instanceof DOMException)
		return "network";
	return "permanent";
}

function validAdjustmentBps(value: unknown) {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value > -10_000 &&
		value <= 100_000
		? value
		: 0;
}
