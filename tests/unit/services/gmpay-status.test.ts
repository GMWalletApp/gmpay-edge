import { describe, expect, it } from "vitest";
import { toGmpayStatus } from "#/features/orders/gmpay-status";

describe("GMPay status compatibility", () => {
	it("maps detailed order states to the documented integer status", () => {
		expect(toGmpayStatus("pending", false)).toBe(4);
		expect(toGmpayStatus("pending", true)).toBe(1);
		expect(toGmpayStatus("confirming")).toBe(1);
		expect(toGmpayStatus("partially_paid")).toBe(1);
		expect(toGmpayStatus("paid")).toBe(2);
		expect(toGmpayStatus("overpaid")).toBe(2);
		expect(toGmpayStatus("expired")).toBe(3);
		expect(toGmpayStatus("cancelled")).toBe(3);
		expect(toGmpayStatus("failed")).toBe(3);
		expect(toGmpayStatus("refunded")).toBe(3);
	});
});
