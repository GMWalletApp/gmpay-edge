import {
	assertLateDecisionAvailable,
	resolveLatePayment,
} from "#/features/payments/server/late-payment";
import type { PaymentRuntime } from "#/features/payments/server/payment-events";
import { DomainError } from "#/lib/domain-error";

export async function resolveLatePaymentAsAdmin(
	env: PaymentRuntime,
	paymentId: string,
	decision: "accept" | "reject",
	actorUserId: string,
) {
	const payment = await env.DB.prepare(
		`SELECT op.status AS payment_status, o.status AS order_status
		 FROM order_payments op JOIN orders o ON o.id = op.order_id
		 WHERE op.id = ? LIMIT 1`,
	)
		.bind(paymentId)
		.first<{ payment_status: string; order_status: string }>();
	if (!payment)
		throw new DomainError("payment_not_found", 404, "Payment not found");
	assertLateDecisionAvailable(payment);
	return resolveLatePayment(env, paymentId, decision, actorUserId);
}
