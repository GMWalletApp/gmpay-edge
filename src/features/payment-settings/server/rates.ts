import {
	convertByRates,
	decimalPlaces,
	decimalToUnits,
	unitsToDecimal,
} from "#/lib/money";

export type ExchangeRateQuote = {
	paymentAmount: string;
	source: string;
	rawRate: string;
	adjustmentBps: number;
	finalRate: string;
	observedAt: number;
};

type ObservedRate = {
	base: string;
	quote: string;
	raw_rate: string;
	rate: string;
	source: string;
	adjustment_bps: number;
	observed_at: number;
};

type QuoteLeg = { observed: ObservedRate; invert: boolean };

const dollarParityAssets = new Set(["USD", "USDT", "USDC"]);

export type ExchangeRateQuoter = {
	/** Quotes the shared order amount in one of the preloaded payment assets. */
	quote(input: {
		paymentAsset: string;
		assetDecimals: number;
	}): ExchangeRateQuote | null;
	/** The order amount in USD minor units, used for receiving limits. */
	usdAmountMinor(): string | null;
};

/**
 * Loads every observation that can quote `currency` in any of `paymentAssets`
 * with a single query, so a checkout with many payment options costs one D1
 * round instead of one per option. A direct observation of a pair is used
 * when present (USD, USDT and USDC are interchangeable on either side); other
 * fiat currencies bridge through USD with the catalog's USD/fiat and
 * asset/USDT rows. Built-in catalog defaults are seeded with `observed_at = 0`
 * and stay quotable until the first synchronization replaces them; every
 * observed rate is usable only inside its validity window.
 *
 * A composite quote records the product of its leg rates, the sum of their
 * basis-point adjustments, the oldest observation time and both sources.
 */
export async function createExchangeRateQuoter(
	db: Pick<D1Database, "prepare">,
	input: {
		amount: string;
		currency: string;
		paymentAssets: readonly string[];
		now?: number;
	},
): Promise<ExchangeRateQuoter> {
	const now = input.now ?? Date.now();
	const symbols = [
		...new Set([
			input.currency,
			...input.paymentAssets,
			"USD",
			...dollarParityAssets,
		]),
	];
	// Dollar-parity assets quoted in a dollar currency need no observation.
	const observed = symbols.every((symbol) => sameUnit(input.currency, symbol))
		? []
		: await loadObservedRates(db, symbols, now);
	const quote = (paymentAsset: string, assetDecimals: number) =>
		quoteFromObservations(observed, {
			amount: input.amount,
			currency: input.currency,
			paymentAsset,
			assetDecimals,
			now,
		});
	return {
		quote: ({ paymentAsset, assetDecimals }) =>
			quote(paymentAsset, assetDecimals),
		usdAmountMinor: () => {
			const usd = quote("USD", 2);
			return usd ? decimalToUnits(usd.paymentAmount, 2).toString() : null;
		},
	};
}

export async function quoteUsdAmountMinor(
	db: Pick<D1Database, "prepare">,
	input: { amount: string; currency: string; now?: number },
): Promise<string | null> {
	const quoter = await createExchangeRateQuoter(db, {
		...input,
		paymentAssets: ["USD"],
	});
	return quoter.usdAmountMinor();
}

/** Quotes `amount` of `currency` in `paymentAsset`; see `createExchangeRateQuoter`. */
export async function quoteWithExchangeRate(
	db: Pick<D1Database, "prepare">,
	input: {
		amount: string;
		currency: string;
		paymentAsset: string;
		assetDecimals: number;
		now?: number;
	},
): Promise<ExchangeRateQuote | null> {
	const quoter = await createExchangeRateQuoter(db, {
		...input,
		paymentAssets: [input.paymentAsset],
	});
	return quoter.quote(input);
}

async function loadObservedRates(
	db: Pick<D1Database, "prepare">,
	symbols: readonly string[],
	now: number,
) {
	const placeholders = symbols.map(() => "?").join(", ");
	const observed = await db
		.prepare(
			`SELECT base, quote, raw_rate, rate, source, adjustment_bps, observed_at
			 FROM exchange_rates
			 WHERE raw_rate IS NOT NULL AND rate IS NOT NULL
			 AND (observed_at = 0 OR expires_at > ?)
			 AND base IN (${placeholders}) AND quote IN (${placeholders})
			 ORDER BY observed_at DESC`,
		)
		.bind(now, ...symbols, ...symbols)
		.all<ObservedRate>();
	return observed.results;
}

function quoteFromObservations(
	rates: readonly ObservedRate[],
	input: {
		amount: string;
		currency: string;
		paymentAsset: string;
		assetDecimals: number;
		now: number;
	},
): ExchangeRateQuote | null {
	if (sameUnit(input.currency, input.paymentAsset))
		return parityQuote(input.amount, input.assetDecimals, input.now);
	const legs = quoteLegs(rates, input.currency, input.paymentAsset);
	if (
		!legs ||
		legs.some(
			({ observed }) =>
				decimalToUnits(observed.rate, decimalPlaces(observed.rate)) <= 0n,
		)
	)
		return null;
	return {
		paymentAmount: convertByRates(
			input.amount,
			decimalPlaces(input.amount),
			legs.map(({ observed, invert }) => ({ rate: observed.rate, invert })),
			input.assetDecimals,
		),
		source: legs.map(({ observed }) => observed.source).join("+"),
		rawRate: legs
			.map(({ observed }) => observed.raw_rate)
			.reduce(multiplyDecimals),
		adjustmentBps: legs.reduce(
			(sum, { observed }) => sum + observed.adjustment_bps,
			0,
		),
		finalRate: legs
			.map(({ observed }) => observed.rate)
			.reduce(multiplyDecimals),
		observedAt: Math.min(...legs.map(({ observed }) => observed.observed_at)),
	};
}

export function applyBasisPoints(rate: string, adjustmentBps: number) {
	if (adjustmentBps <= -10_000 || adjustmentBps > 100_000)
		throw new Error("Rate adjustment is outside the supported range");
	const decimals = decimalPlaces(rate);
	const rateUnits = decimalToUnits(rate, decimals);
	const adjusted = rateUnits * BigInt(10_000 + adjustmentBps);
	return unitsToDecimal(adjusted, decimals + 4);
}

function quoteLegs(rates: readonly ObservedRate[], from: string, to: string) {
	const direct = findLeg(rates, from, to);
	if (direct) return [direct];
	if (dollarParityAssets.has(from) || dollarParityAssets.has(to)) return null;
	const toDollar = findLeg(rates, from, "USD");
	const fromDollar = findLeg(rates, "USD", to);
	return toDollar && fromDollar ? [toDollar, fromDollar] : null;
}

/** Rows arrive freshest first, so the first connecting observation wins. */
function findLeg(
	rates: readonly ObservedRate[],
	from: string,
	to: string,
): QuoteLeg | null {
	for (const observed of rates) {
		if (sameUnit(observed.base, observed.quote)) continue;
		if (sameUnit(observed.base, from) && sameUnit(observed.quote, to))
			return { observed, invert: false };
		if (sameUnit(observed.base, to) && sameUnit(observed.quote, from))
			return { observed, invert: true };
	}
	return null;
}

function sameUnit(left: string, right: string) {
	return (
		left === right ||
		(dollarParityAssets.has(left) && dollarParityAssets.has(right))
	);
}

function multiplyDecimals(left: string, right: string) {
	const leftDecimals = decimalPlaces(left);
	const rightDecimals = decimalPlaces(right);
	return unitsToDecimal(
		decimalToUnits(left, leftDecimals) * decimalToUnits(right, rightDecimals),
		leftDecimals + rightDecimals,
	);
}

function parityQuote(
	amount: string,
	assetDecimals: number,
	observedAt: number,
): ExchangeRateQuote {
	return {
		paymentAmount: unitsToDecimal(
			decimalToUnits(amount, assetDecimals, "up"),
			assetDecimals,
		),
		source: "stable_parity",
		rawRate: "1",
		adjustmentBps: 0,
		finalRate: "1",
		observedAt,
	};
}
