import { describe, expect, it } from "vitest";
import {
	convertByRates,
	decimalToUnits,
	quantizeUnitsUp,
	unitsToDecimal,
} from "#/lib/money";

describe("money", () => {
	it("converts decimal strings without floating point", () => {
		expect(decimalToUnits("12.345678", 6)).toBe(12_345_678n);
		expect(unitsToDecimal(12_345_600n, 6)).toBe("12.3456");
	});
	it("rejects precision loss by default", () =>
		expect(() => decimalToUnits("1.0000001", 6)).toThrow(/precision/));
	it("rounds a quoted payment amount up", () =>
		expect(
			convertByRates("10.00", 2, [{ rate: "0.333333", invert: false }], 6),
		).toBe("3.33333"));
	it("divides by a base-to-quote rate and rounds payment up", () =>
		expect(
			convertByRates("100.00", 2, [{ rate: "3.000000", invert: true }], 6),
		).toBe("33.333334"));
	it("composes rate legs exactly and rounds only once", () => {
		// 700 CNY -> 100 USD (÷7) -> 307.502... TRX (÷0.3252) rounds up once.
		expect(
			convertByRates(
				"700",
				0,
				[
					{ rate: "7", invert: true },
					{ rate: "0.3252", invert: true },
				],
				6,
			),
		).toBe("307.503076");
		expect(() =>
			convertByRates("1", 0, [{ rate: "0", invert: true }], 6),
		).toThrow(/positive/);
	});
	it("quantizes payment units upward without floating point", () => {
		expect(quantizeUnitsUp(14_925_374n, 6, 4)).toEqual({
			amountUnits: 14_925_400n,
			stepUnits: 100n,
		});
		expect(quantizeUnitsUp(123n, 2, 4)).toEqual({
			amountUnits: 123n,
			stepUnits: 1n,
		});
	});
});
