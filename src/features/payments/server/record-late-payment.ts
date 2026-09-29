import type { OrderStatus } from "#/features/orders/schema";
import {
	dispatchPaymentNotifications,
	matchingWebhookEndpoints,
	type PaymentRuntime,
	paymentWebhookInstance,
} from "#/features/payments/server/payment-events";
import {
	PaymentAttributionConflictError,
	paymentTransactionId,
} from "#/features/payments/server/reconciliation";
import type { NormalizedTransaction } from "#/integrations/chains/types";

export async function recordLatePayment(
	env: PaymentRuntime,
	order: {
		id: string;
		external_order_id: string;
		status: OrderStatus;
		amount: string;
		currency: string;
		paymentAmount: string;
		received_amount_units: string;
		code: string;
		network: string;
	},
	transaction: NormalizedTransaction,
	policy: "review" | "reject",
	commitGuard?: D1PreparedStatement,
) {
	const db = env.DB;
	const transactionId = paymentTransactionId(transaction);
	const existing = await db
		.prepare(
			"SELECT id, order_id FROM order_payments WHERE transaction_id = ? LIMIT 1",
		)
		.bind(transactionId)
		.first<{ id: string; order_id: string }>();
	if (existing?.order_id === order.id)
		return { duplicate: true, status: order.status };
	if (existing) throw new PaymentAttributionConflictError();
	const now = Date.now();
	// A reviewed late transfer stays outside the order balance until an
	// administrator accepts it; reconciliation never counts pending_review rows.
	const paymentStatus = policy === "review" ? "pending_review" : "rejected";
	const transactionStatus = policy === "review" ? "pending" : "failed";
	const eventType =
		policy === "review" ? "payment.late_detected" : "payment.late_rejected";
	const eventId = crypto.randomUUID();
	const instance = await paymentWebhookInstance(db);
	const payload = {
		event: eventType,
		eventId,
		createdAt: new Date(now).toISOString(),
		instance,
		orderId: order.id,
		externalOrderId: order.external_order_id,
		status: order.status,
		amount: order.amount,
		currency: order.currency,
		payment: {
			amount: order.paymentAmount,
			asset: order.code,
			network: order.network,
			receivedAmountUnits: order.received_amount_units,
			lateAmountUnits: transaction.amountUnits.toString(),
			policy,
		},
		transaction: {
			id: transactionId,
			hash: transaction.hash,
			amountUnits: transaction.amountUnits.toString(),
			confirmations: transaction.confirmations,
		},
	};
	const endpoints = await matchingWebhookEndpoints(db, order.id);
	const deliveries = endpoints.map((endpoint) => ({
		id: crypto.randomUUID(),
		endpoint,
	}));
	const paymentRowId = crypto.randomUUID();
	const results = await db.batch([
		...(commitGuard ? [commitGuard] : []),
		db
			.prepare(
				`INSERT OR IGNORE INTO order_payments
				 (id, order_id, transaction_id, amount_units, confirmations, status,
				 detected_at, confirmed_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
			)
			.bind(
				paymentRowId,
				order.id,
				transactionId,
				transaction.amountUnits.toString(),
				transaction.confirmations,
				paymentStatus,
				now,
				now,
				now,
			),
		db
			.prepare(
				`INSERT INTO blockchain_transactions
				 (id, network, tx_hash, event_index, from_address, to_address, asset_code,
				 amount_units, block_number, block_hash, confirmations, status, observed_at,
				 created_at, updated_at)
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE EXISTS (SELECT 1 FROM order_payments WHERE id = ?)
				 ON CONFLICT(network, tx_hash, event_index) DO UPDATE SET
				 confirmations = excluded.confirmations, block_hash = excluded.block_hash,
				 updated_at = excluded.updated_at`,
			)
			.bind(
				crypto.randomUUID(),
				transaction.network,
				transaction.hash,
				transaction.eventIndex,
				transaction.from,
				transaction.to,
				transaction.assetCode,
				transaction.amountUnits.toString(),
				transaction.blockNumber.toString(),
				transaction.blockHash,
				transaction.confirmations,
				transactionStatus,
				now,
				now,
				now,
				paymentRowId,
			),
		db
			.prepare(
				`INSERT INTO audit_logs
				 (id, action, target_type, target_id, after, created_at)
				 SELECT ?, ?, 'order', ?, ?, ?
				 WHERE EXISTS (SELECT 1 FROM order_payments WHERE id = ?)`,
			)
			.bind(
				crypto.randomUUID(),
				policy === "review"
					? "payment.late_review_required"
					: "payment.late_rejected",
				order.id,
				JSON.stringify({
					transactionId,
					amountUnits: transaction.amountUnits.toString(),
				}),
				now,
				paymentRowId,
			),
		db
			.prepare(
				`INSERT INTO webhook_events
				 (id, order_id, type, deduplication_key, payload, created_at, updated_at)
				 SELECT ?, ?, ?, ?, ?, ?, ?
				 WHERE EXISTS (SELECT 1 FROM order_payments WHERE id = ?)`,
			)
			.bind(
				eventId,
				order.id,
				eventType,
				`${order.id}:${transactionId}:${eventType}`,
				JSON.stringify(payload),
				now,
				now,
				paymentRowId,
			),
		...deliveries.map(({ id, endpoint }) =>
			db
				.prepare(
					`INSERT INTO webhook_deliveries
					 (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at)
					 SELECT ?, ?, ?, ?, 'queued', 0, ?, ?
					 WHERE EXISTS (SELECT 1 FROM webhook_events WHERE id = ?)`,
				)
				.bind(id, eventId, endpoint.id, endpoint.api_key_id, now, now, eventId),
		),
	]);
	if ((results[commitGuard ? 1 : 0]?.meta.changes ?? 0) !== 1) {
		const attributed = await db
			.prepare(
				"SELECT order_id FROM order_payments WHERE transaction_id = ? LIMIT 1",
			)
			.bind(transactionId)
			.first<{ order_id: string }>();
		if (attributed?.order_id === order.id)
			return { duplicate: true, status: order.status };
		throw new PaymentAttributionConflictError();
	}
	await dispatchPaymentNotifications(
		env,
		eventId,
		payload,
		deliveries,
		eventType,
	);
	return { duplicate: false, status: order.status };
}
