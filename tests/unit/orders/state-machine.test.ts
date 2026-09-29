import { describe, expect, it } from "vitest";
import {
	assertTransition,
	statusFromPayment,
} from "#/features/orders/state-machine";

describe("order state machine", () => {
	it("classifies no, partial, confirming, exact and excess payments", () => {
		expect(statusFromPayment(100n, 0n, 0, 1)).toBe("pending");
		expect(statusFromPayment(100n, 50n, 10, 1)).toBe("partially_paid");
		expect(statusFromPayment(100n, 100n, 0, 1)).toBe("confirming");
		expect(statusFromPayment(100n, 100n, 1, 1)).toBe("paid");
		expect(statusFromPayment(100n, 101n, 1, 1)).toBe("overpaid");
	});
	it("supports late arrival and chain reorg", () => {
		expect(() =>
			assertTransition("expired", "paid", "payment_detected"),
		).not.toThrow();
		expect(() =>
			assertTransition("paid", "confirming", "chain_reorg"),
		).not.toThrow();
		expect(() =>
			assertTransition("paid", "pending", "chain_reorg"),
		).not.toThrow();
		expect(() =>
			assertTransition("partially_paid", "pending", "chain_reorg"),
		).not.toThrow();
	});
	it("never expires a confirming order and lets administrators refund partial payments", () => {
		expect(() =>
			assertTransition("confirming", "expired", "expired"),
		).toThrow();
		expect(() =>
			assertTransition("partially_paid", "expired", "expired"),
		).not.toThrow();
		expect(() =>
			assertTransition("partially_paid", "refunded", "admin_refund"),
		).not.toThrow();
		expect(() =>
			assertTransition("expired", "refunded", "admin_refund"),
		).toThrow();
	});
	it("requires administrator intent for refunds", () =>
		expect(() =>
			assertTransition("paid", "refunded", "payment_detected"),
		).toThrow());
	it("binds every terminal target to its declared transition reason", () => {
		expect(() =>
			assertTransition("pending", "failed", "processing_failed"),
		).not.toThrow();
		expect(() =>
			assertTransition("pending", "expired", "payment_detected"),
		).toThrow();
		expect(() =>
			assertTransition("pending", "cancelled", "processing_failed"),
		).toThrow();
		expect(() => assertTransition("paid", "refunded", "chain_reorg")).toThrow();
	});
});
