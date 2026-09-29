import { describe, expect, it } from "vitest";
import { reconcileOrderPayment } from "#/features/payments/server/reconciliation";

describe("payment reconciliation", () => {
	it("does not count reorged or rejected transfers", () => {
		const result = reconcileOrderPayment({
			expectedUnits: 100n,
			requiredConfirmations: 2,
			payments: [
				{ amountUnits: 80n, confirmations: 9, status: "reorged" },
				{ amountUnits: 20n, confirmations: 9, status: "rejected" },
			],
		});
		expect(result).toEqual({
			receivedUnits: 0n,
			confirmedUnits: 0n,
			status: "pending",
		});
	});

	it("keeps payments awaiting review outside the balance", () => {
		expect(
			reconcileOrderPayment({
				expectedUnits: 100n,
				requiredConfirmations: 1,
				payments: [
					{ amountUnits: 100n, confirmations: 5, status: "pending_review" },
					{ amountUnits: 100n, confirmations: 5, status: "confirmed" },
				],
			}),
		).toEqual({ receivedUnits: 100n, confirmedUnits: 100n, status: "paid" });
	});

	it("aggregates split payments and waits for every required amount to confirm", () => {
		const confirming = reconcileOrderPayment({
			expectedUnits: 100n,
			requiredConfirmations: 2,
			payments: [
				{ amountUnits: 40n, confirmations: 2, status: "confirmed" },
				{ amountUnits: 60n, confirmations: 1, status: "confirming" },
			],
		});
		expect(confirming.status).toBe("confirming");
		expect(confirming.receivedUnits).toBe(100n);
		expect(confirming.confirmedUnits).toBe(40n);

		const paid = reconcileOrderPayment({
			expectedUnits: 100n,
			requiredConfirmations: 2,
			payments: [
				{ amountUnits: 40n, confirmations: 2, status: "confirmed" },
				{ amountUnits: 60n, confirmations: 2, status: "confirming" },
			],
		});
		expect(paid.status).toBe("paid");
	});

	it("classifies partial and overpayments using atomic integers", () => {
		expect(
			reconcileOrderPayment({
				expectedUnits: 100n,
				requiredConfirmations: 1,
				payments: [
					{ amountUnits: 99n, confirmations: 10, status: "confirmed" },
				],
			}).status,
		).toBe("partially_paid");
		expect(
			reconcileOrderPayment({
				expectedUnits: 100n,
				requiredConfirmations: 1,
				payments: [
					{ amountUnits: 101n, confirmations: 1, status: "confirmed" },
				],
			}).status,
		).toBe("overpaid");
	});
});
