import type { OrderStatus } from "#/features/orders/schema";

export type TransitionReason =
	| "payment_detected"
	| "confirmations_updated"
	| "expired"
	| "merchant_cancelled"
	| "processing_failed"
	| "admin_refund"
	| "chain_reorg";

const transitions = {
	pending: [
		"confirming",
		"partially_paid",
		"paid",
		"overpaid",
		"expired",
		"cancelled",
		"failed",
	],
	// A confirming order already holds the full amount; it settles through
	// confirmations (or a reorg back to pending) instead of expiring.
	confirming: ["partially_paid", "paid", "overpaid", "failed", "pending"],
	partially_paid: [
		"pending",
		"confirming",
		"paid",
		"overpaid",
		"expired",
		"failed",
		"refunded",
	],
	paid: ["pending", "partially_paid", "overpaid", "refunded", "confirming"],
	overpaid: ["pending", "partially_paid", "refunded", "paid", "confirming"],
	expired: ["confirming", "partially_paid", "paid", "overpaid"],
	cancelled: ["partially_paid", "confirming", "paid", "overpaid"],
	failed: ["pending", "confirming"],
	refunded: [],
} as const satisfies Record<OrderStatus, readonly OrderStatus[]>;

const targetsByReason = {
	payment_detected: [
		"pending",
		"confirming",
		"partially_paid",
		"paid",
		"overpaid",
	],
	confirmations_updated: [
		"pending",
		"confirming",
		"partially_paid",
		"paid",
		"overpaid",
	],
	expired: ["expired"],
	merchant_cancelled: ["cancelled"],
	processing_failed: ["failed"],
	admin_refund: ["refunded"],
	chain_reorg: ["pending", "confirming", "partially_paid", "paid", "overpaid"],
} as const satisfies Record<TransitionReason, readonly OrderStatus[]>;

export function canTransition(from: OrderStatus, to: OrderStatus) {
	return from === to || transitions[from].some((status) => status === to);
}

export function assertTransition(
	from: OrderStatus,
	to: OrderStatus,
	reason: TransitionReason,
) {
	if (
		!canTransition(from, to) ||
		!targetsByReason[reason].some((status) => status === to)
	)
		throw new InvalidOrderTransitionError(from, to, reason);
}

export class InvalidOrderTransitionError extends Error {
	constructor(
		readonly from: OrderStatus,
		readonly to: OrderStatus,
		readonly reason: TransitionReason,
	) {
		super(`Illegal order transition: ${from} -> ${to} (${reason})`);
		this.name = "InvalidOrderTransitionError";
	}
}

export function statusFromPayment(
	expectedUnits: bigint,
	receivedUnits: bigint,
	confirmations: number,
	requiredConfirmations: number,
): OrderStatus {
	if (receivedUnits === 0n) return "pending";
	if (receivedUnits < expectedUnits) return "partially_paid";
	if (confirmations < requiredConfirmations) return "confirming";
	if (receivedUnits > expectedUnits) return "overpaid";
	return "paid";
}
