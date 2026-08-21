import {
	convertByRate,
	decimalPlaces,
	decimalToUnits,
	divideByRate,
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

const dollarParityAssets = new Set(["USD", "USDT", "USDC"]);

export async function quoteUsdAmountMinor(
	db: D1Database,
	input: { amount: string; currency: string; now?: number },
): Promise<string | null> {
	const quote = await quoteWithExchangeRate(db, {
		...input,
		paymentAsset: "USD",
		assetDecimals: 2,
	});
	return quote ? decimalToUnits(quote.paymentAmount, 2).toString() : null;
}

export async function quoteWithExchangeRate(
	db: D1Database,
	input: {
		amount: string;
		currency: string;
		paymentAsset: string;
		assetDecimals: number;
		now?: number;
	},
): Promise<ExchangeRateQuote | null> {
	const now = input.now ?? Date.now();
	if (
		input.currency === input.paymentAsset ||
		(dollarParityAssets.has(input.paymentAsset) &&
			dollarParityAssets.has(input.currency))
	)
		return parityQuote(input.amount, input.assetDecimals, now);

	const observed = await db
		.prepare(
			`SELECT base, quote, raw_rate, rate, source, adjustment_bps, observed_at
			 FROM exchange_rates
			 WHERE raw_rate IS NOT NULL AND rate IS NOT NULL AND (
			  (base = ? AND quote = ?) OR (base = ? AND quote = ?)
			  OR (? IN ('USD', 'USDT', 'USDC') AND
			   ((base IN ('USD', 'USDT', 'USDC') AND quote = ?)
			    OR (base = ? AND quote IN ('USD', 'USDT', 'USDC'))))
			 )
			 ORDER BY CASE WHEN base = ? OR quote = ? THEN 0 ELSE 1 END,
			 observed_at DESC LIMIT 1`,
		)
		.bind(
			input.paymentAsset,
			input.currency,
			input.currency,
			input.paymentAsset,
			input.paymentAsset,
			input.currency,
			input.currency,
			input.paymentAsset,
			input.paymentAsset,
		)
		.first<{
			base: string;
			quote: string;
			raw_rate: string;
			rate: string;
			source: string;
			adjustment_bps: number;
			observed_at: number;
		}>();
	if (!observed) return null;
	if (decimalToUnits(observed.rate, decimalPlaces(observed.rate)) <= 0n)
		return null;
	const amountDecimals = decimalPlaces(input.amount);
	const rateDecimals = decimalPlaces(observed.rate);
	const divide =
		observed.base === input.paymentAsset ||
		(dollarParityAssets.has(observed.base) &&
			dollarParityAssets.has(input.paymentAsset));
	return {
		paymentAmount: divide
			? divideByRate(
					input.amount,
					amountDecimals,
					observed.rate,
					rateDecimals,
					input.assetDecimals,
				)
			: convertByRate(
					input.amount,
					amountDecimals,
					observed.rate,
					rateDecimals,
					input.assetDecimals,
				),
		source: observed.source,
		rawRate: observed.raw_rate,
		adjustmentBps: observed.adjustment_bps,
		finalRate: observed.rate,
		observedAt: observed.observed_at,
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
