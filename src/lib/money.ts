const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;

export function decimalToUnits(
	value: string,
	decimals: number,
	rounding: "reject" | "down" | "up" = "reject",
): bigint {
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30)
		throw new RangeError("Invalid decimals");
	if (!DECIMAL_PATTERN.test(value))
		throw new TypeError("Amount must be a non-negative decimal string");
	const [whole = "0", fraction = ""] = value.split(".");
	if (fraction.length <= decimals)
		return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
	const kept = fraction.slice(0, decimals);
	const discarded = fraction.slice(decimals);
	if (rounding === "reject" && /[1-9]/.test(discarded))
		throw new RangeError("Amount exceeds supported precision");
	const base = BigInt(`${whole}${kept}` || "0");
	return rounding === "up" && /[1-9]/.test(discarded) ? base + 1n : base;
}

export function unitsToDecimal(value: bigint, decimals: number): string {
	if (value < 0n) throw new RangeError("Amount cannot be negative");
	if (decimals === 0) return value.toString();
	const padded = value.toString().padStart(decimals + 1, "0");
	const whole = padded.slice(0, -decimals);
	const fraction = padded.slice(-decimals).replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}` : whole;
}

export function quantizeUnitsUp(
	value: bigint,
	decimals: number,
	maximumDecimals: number,
) {
	if (value < 0n) throw new RangeError("Amount cannot be negative");
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30)
		throw new RangeError("Invalid decimals");
	if (
		!Number.isInteger(maximumDecimals) ||
		maximumDecimals < 0 ||
		maximumDecimals > 30
	)
		throw new RangeError("Invalid maximum decimals");
	const stepUnits = 10n ** BigInt(Math.max(0, decimals - maximumDecimals));
	return {
		stepUnits,
		amountUnits: ((value + stepUnits - 1n) / stepUnits) * stepUnits,
	};
}

export type RateLeg = { rate: string; invert: boolean };

/**
 * Applies exact decimal rate legs in order (`invert` divides instead of
 * multiplying) and rounds the final amount up once, so composite quotes never
 * accumulate intermediate rounding.
 */
export function convertByRates(
	amount: string,
	amountDecimals: number,
	legs: readonly RateLeg[],
	outputDecimals: number,
): string {
	let numerator =
		decimalToUnits(amount, amountDecimals) * 10n ** BigInt(outputDecimals);
	let denominator = 10n ** BigInt(amountDecimals);
	for (const leg of legs) {
		const rateDecimals = decimalPlaces(leg.rate);
		const rateUnits = decimalToUnits(leg.rate, rateDecimals);
		if (rateUnits <= 0n) throw new RangeError("Rate must be positive");
		const scale = 10n ** BigInt(rateDecimals);
		numerator *= leg.invert ? scale : rateUnits;
		denominator *= leg.invert ? rateUnits : scale;
	}
	return unitsToDecimal(
		(numerator + denominator - 1n) / denominator,
		outputDecimals,
	);
}

export function decimalPlaces(value: string) {
	const fraction = value.split(".")[1];
	return fraction?.length ?? 0;
}
