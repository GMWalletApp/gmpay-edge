import type { OrderStatus } from "#/features/orders/schema";

export type GmpayStatus = 1 | 2 | 3 | 4;

export function toGmpayStatus(status: OrderStatus): Exclude<GmpayStatus, 4>;
export function toGmpayStatus(
	status: OrderStatus,
	hasPaymentTarget: boolean,
): GmpayStatus;
export function toGmpayStatus(
	status: OrderStatus,
	hasPaymentTarget = true,
): GmpayStatus {
	if (status === "pending" && !hasPaymentTarget) return 4;
	if (status === "paid" || status === "overpaid") return 2;
	if (
		status === "expired" ||
		status === "cancelled" ||
		status === "failed" ||
		status === "refunded"
	)
		return 3;
	return 1;
}
