import { getLocale } from "#/paraglide/runtime";

export function formatDateTime(
	value: Date | string | number,
	locale = getLocale(),
	timeZone?: string,
) {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "—";
	return new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		timeStyle: "medium",
		timeZone,
	}).format(date);
}

export function formatNumber(value: number, locale = getLocale()) {
	return new Intl.NumberFormat(locale).format(value);
}

/**
 * Localizes an exact decimal string produced from `*_minor` / `*_units`
 * values. Intl formats numeric strings as exact decimals, so no digit passes
 * through a float; the fraction digits given are kept, capped at
 * `fractionDigits` (the currency or asset precision).
 */
export function formatDecimalAmount(
	value: string,
	fractionDigits = fractionDigitCount(value),
	locale = getLocale(),
) {
	return new Intl.NumberFormat(locale, {
		minimumFractionDigits: Math.min(fractionDigitCount(value), fractionDigits),
		maximumFractionDigits: fractionDigits,
	}).format(value as `${number}`);
}

function fractionDigitCount(value: string) {
	const separator = value.indexOf(".");
	return separator === -1 ? 0 : value.length - separator - 1;
}
