import type { OrderStatus } from "#/features/orders/schema";
import { statusFromPayment } from "#/features/orders/state-machine";
import type { NormalizedTransaction } from "#/integrations/chains/types";
import { DomainError } from "#/lib/domain-error";

export type PaymentStatus =
	| "detected"
	| "confirming"
	| "confirmed"
	| "pending_review"
	| "reorged"
	| "rejected";

export interface PaymentAggregate {
	amountUnits: bigint;
	confirmations: number;
	status: PaymentStatus;
}

/** Only these payment rows contribute to an order balance. */
const countedPaymentStatuses = new Set<PaymentStatus>([
	"detected",
	"confirming",
	"confirmed",
]);

export function reconcileOrderPayment(input: {
	expectedUnits: bigint;
	payments: readonly PaymentAggregate[];
	requiredConfirmations: number;
}): { receivedUnits: bigint; confirmedUnits: bigint; status: OrderStatus } {
	let receivedUnits = 0n;
	let confirmedUnits = 0n;
	for (const payment of input.payments) {
		if (!countedPaymentStatuses.has(payment.status)) continue;
		receivedUnits += payment.amountUnits;
		if (
			payment.status === "confirmed" ||
			payment.confirmations >= input.requiredConfirmations
		) {
			confirmedUnits += payment.amountUnits;
		}
	}

	const status = statusFromPayment(
		input.expectedUnits,
		receivedUnits,
		confirmedUnits >= input.expectedUnits ? input.requiredConfirmations : 0,
		input.requiredConfirmations,
	);
	return { receivedUnits, confirmedUnits, status };
}

export class PaymentAttributionConflictError extends DomainError {
	constructor() {
		super(
			"transaction_already_attributed",
			409,
			"Transaction is already attributed to another order",
		);
		this.name = "PaymentAttributionConflictError";
	}
}

export function paymentTransactionId(
	transaction: Pick<NormalizedTransaction, "network" | "hash" | "eventIndex">,
) {
	return `${transaction.network}:${transaction.hash}:${transaction.eventIndex}`;
}

export function parsePaymentTransactionId(value: string) {
	const firstSeparator = value.indexOf(":");
	const lastSeparator = value.lastIndexOf(":");
	if (firstSeparator <= 0 || lastSeparator <= firstSeparator) {
		throw new Error("Invalid payment transaction identifier");
	}
	return {
		hash: value.slice(firstSeparator + 1, lastSeparator),
		eventIndex: Number(value.slice(lastSeparator + 1)),
	};
}
