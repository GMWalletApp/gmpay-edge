import { z } from "zod";
import { submitCheckoutTransaction } from "#/features/checkout/server/submit-transaction";
import { resolveLatePayment } from "#/features/payments/server/late-payment";
import type { PaymentRuntime } from "#/features/payments/server/payment-events";
import { DomainError } from "#/lib/domain-error";

export const resolvePaymentReviewSchema = z.object({
	reviewId: z.uuid(),
	decision: z.enum(["approve", "reject"]),
	transactionHash: z.string().trim().min(8).max(256).optional(),
	note: z.string().trim().min(3).max(1_000),
});

export async function resolvePaymentReview(
	env: PaymentRuntime,
	input: z.infer<typeof resolvePaymentReviewSchema>,
	context: {
		reviewerUserId: string;
		requestId?: string | null;
		ipAddress?: string | null;
		adapterFactory?: Parameters<typeof submitCheckoutTransaction>[2];
	},
) {
	const data = resolvePaymentReviewSchema.parse(input);
	const review = await env.DB.prepare(
		"SELECT order_id, status, transaction_hash FROM payment_reviews WHERE id = ? LIMIT 1",
	)
		.bind(data.reviewId)
		.first<{
			order_id: string;
			status: string;
			transaction_hash: string | null;
		}>();
	if (!review)
		throw new DomainError(
			"payment_review_not_found",
			404,
			"Payment review not found",
		);
	if (review.status !== "pending")
		throw new DomainError(
			"payment_review_already_resolved",
			409,
			"Payment review is already resolved",
		);

	let orderStatus: string | null = null;
	const transactionHash = data.transactionHash ?? review.transaction_hash;
	if (data.decision === "approve") {
		if (!transactionHash)
			throw new DomainError(
				"payment_review_transaction_required",
				422,
				"A transaction hash is required",
			);
		const verified = await submitCheckoutTransaction(
			env,
			{ orderId: review.order_id, transactionHash },
			context.adapterFactory,
			true,
		);
		if (verified.status !== "accepted")
			throw verificationError(verified.status);
		orderStatus = verified.orderStatus;
		if (["expired", "cancelled"].includes(verified.orderStatus)) {
			const payment = await env.DB.prepare(
				"SELECT id FROM order_payments WHERE order_id = ? AND transaction_id = ? LIMIT 1",
			)
				.bind(review.order_id, verified.transactionId)
				.first<{ id: string }>();
			if (!payment) throw new Error("Verified late payment was not persisted");
			const resolution = await resolveLatePayment(env, payment.id, "accept");
			orderStatus = resolution.status;
		}
	}

	const now = Date.now();
	const nextStatus = data.decision === "approve" ? "approved" : "rejected";
	const [update] = await env.DB.batch([
		env.DB.prepare(
			`UPDATE payment_reviews SET status = ?, transaction_hash = ?, reviewer_user_id = ?,
				 resolution_note = ?, reviewed_at = ?, updated_at = ?
				 WHERE id = ? AND status = 'pending'`,
		).bind(
			nextStatus,
			transactionHash ?? null,
			context.reviewerUserId,
			data.note,
			now,
			now,
			data.reviewId,
		),
		env.DB.prepare(
			`INSERT INTO audit_logs
				 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
				 SELECT ?, ?, ?, 'payment_review', ?, ?, ?, ?, ?
				 WHERE EXISTS (
				  SELECT 1 FROM payment_reviews WHERE id = ? AND status = ? AND reviewed_at = ?
				 )`,
		).bind(
			crypto.randomUUID(),
			context.reviewerUserId,
			`payment_review.${nextStatus}`,
			data.reviewId,
			context.requestId ?? null,
			context.ipAddress ?? null,
			JSON.stringify({ orderId: review.order_id, orderStatus }),
			now,
			data.reviewId,
			nextStatus,
			now,
		),
	]);
	if ((update?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"payment_review_resolution_conflict",
			409,
			"Payment review was resolved concurrently",
		);
	return { status: nextStatus, orderStatus };
}

function verificationError(
	status: "not_found" | "mismatch" | "unavailable",
): DomainError {
	switch (status) {
		case "not_found":
			return new DomainError(
				"payment_review_transaction_not_found",
				409,
				"Transaction not found",
			);
		case "mismatch":
			return new DomainError(
				"payment_review_transaction_mismatch",
				409,
				"Transaction does not match the order",
			);
		case "unavailable":
			return new DomainError(
				"payment_review_transaction_unavailable",
				503,
				"Transaction verification is unavailable",
			);
	}
	const unhandled: never = status;
	return unhandled;
}
