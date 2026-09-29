import type { OrderStatus } from "#/features/orders/schema";
import { assertTransition } from "#/features/orders/state-machine";
import {
	displayOrderAmounts,
	type StoredOrderAmounts,
} from "#/features/payments/server/order-amounts";
import {
	dispatchPaymentNotifications,
	matchingWebhookEndpoints,
	type PaymentRuntime,
	paymentWebhookInstance,
} from "#/features/payments/server/payment-events";
import {
	type PaymentAggregate,
	parsePaymentTransactionId,
	reconcileOrderPayment,
} from "#/features/payments/server/reconciliation";
import type { OrderWebhookPayload } from "#/features/webhooks/types";
import { DomainError } from "#/lib/domain-error";

export async function resolveLatePayment(
	env: PaymentRuntime,
	paymentId: string,
	decision: "accept" | "reject",
	actorUserId?: string,
) {
	const storedRow = await env.DB.prepare(
		`SELECT op.id, op.order_id, op.transaction_id, op.amount_units,
		 op.confirmations, op.status AS payment_status, o.status AS order_status,
		 o.external_order_id, o.amount_minor, o.currency, o.currency_decimals,
		 o.received_amount_units, o.version, ops.expected_amount_units,
			 ops.asset_code AS code, ops.decimals,
			 ops.required_confirmations, ops.rail_code AS network
			 FROM order_payments op JOIN orders o ON o.id = op.order_id
			 JOIN order_payment_snapshots ops ON ops.order_id = o.id
		 WHERE op.id = ? LIMIT 1`,
	)
		.bind(paymentId)
		.first<
			StoredOrderAmounts & {
				id: string;
				order_id: string;
				transaction_id: string;
				amount_units: string;
				confirmations: number;
				payment_status: PaymentAggregate["status"];
				order_status: OrderStatus;
				external_order_id: string;
				currency: string;
				received_amount_units: string;
				version: number;
				decimals: number;
				required_confirmations: number;
				network: string;
				code: string;
			}
		>();
	if (!storedRow)
		throw new DomainError("payment_not_found", 404, "Late payment not found");
	const row = displayOrderAmounts(storedRow);
	if (row.paymentAmount === null || row.expected_amount_units === null)
		throw new Error("Order payment snapshot is incomplete");
	assertLateDecisionAvailable(row);
	const now = Date.now();
	const { hash, eventIndex } = parsePaymentTransactionId(row.transaction_id);
	if (decision === "reject") {
		const eventId = crypto.randomUUID();
		const eventType = "payment.late_rejected";
		const payload = {
			event: eventType,
			eventId,
			createdAt: new Date(now).toISOString(),
			instance: await paymentWebhookInstance(env.DB),
			orderId: row.order_id,
			externalOrderId: row.external_order_id,
			status: row.order_status,
			amount: row.amount,
			currency: row.currency,
			payment: {
				amount: row.paymentAmount,
				asset: row.code,
				network: row.network,
				receivedAmountUnits: row.received_amount_units,
				lateAmountUnits: row.amount_units,
				policy: "review",
				decision,
			},
			transaction: {
				id: row.transaction_id,
				hash,
				amountUnits: row.amount_units,
				confirmations: row.confirmations,
			},
		};
		const endpoints = await matchingWebhookEndpoints(env.DB, row.order_id);
		const deliveries = endpoints.map((endpoint) => ({
			id: crypto.randomUUID(),
			endpoint,
		}));
		try {
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE order_payments SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'pending_review'",
				).bind(now, row.id),
				env.DB.prepare(
					`SELECT CASE WHEN changes() = 1 THEN 1
				 ELSE json_extract('late payment decision conflict', '$') END`,
				),
				env.DB.prepare(
					"UPDATE blockchain_transactions SET status = 'failed', updated_at = ? WHERE network = ? AND tx_hash = ? AND event_index = ?",
				).bind(now, row.network, hash, eventIndex),
				lateDecisionAudit(env.DB, row, actorUserId, decision, now),
				env.DB.prepare(
					"INSERT INTO webhook_events (id, order_id, type, deduplication_key, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				).bind(
					eventId,
					row.order_id,
					eventType,
					`${row.order_id}:late:${row.id}:rejected`,
					JSON.stringify(payload),
					now,
					now,
				),
				...deliveries.map(({ id, endpoint }) =>
					env.DB.prepare(
						"INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)",
					).bind(id, eventId, endpoint.id, endpoint.api_key_id, now, now),
				),
			]);
		} catch (error) {
			await rethrowLatePaymentDecision(env.DB, row.id, error);
		}
		await dispatchPaymentNotifications(
			env,
			eventId,
			payload,
			deliveries,
			eventType,
		);
		return { orderId: row.order_id, status: row.order_status, decision };
	}
	const payments = await env.DB.prepare(
		"SELECT id, amount_units, confirmations, status FROM order_payments WHERE order_id = ?",
	)
		.bind(row.order_id)
		.all<{
			id: string;
			amount_units: string;
			confirmations: number;
			status: PaymentAggregate["status"];
		}>();
	const acceptedStatus: PaymentAggregate["status"] =
		row.confirmations >= row.required_confirmations
			? "confirmed"
			: row.confirmations > 0
				? "confirming"
				: "detected";
	const aggregate = reconcileOrderPayment({
		expectedUnits: BigInt(row.expected_amount_units),
		requiredConfirmations: row.required_confirmations,
		payments: payments.results.map((payment) => ({
			amountUnits: BigInt(payment.amount_units),
			confirmations: payment.confirmations,
			status: payment.id === row.id ? acceptedStatus : payment.status,
		})),
	});
	assertTransition(row.order_status, aggregate.status, "payment_detected");
	const eventId = crypto.randomUUID();
	const eventType = `order.${aggregate.status}` as const;
	const payload: OrderWebhookPayload = {
		event: eventType,
		eventId,
		createdAt: new Date(now).toISOString(),
		instance: await paymentWebhookInstance(env.DB),
		orderId: row.order_id,
		externalOrderId: row.external_order_id,
		status: aggregate.status,
		amount: row.amount,
		currency: row.currency,
		payment: {
			amount: row.paymentAmount,
			asset: row.code,
			network: row.network,
			receivedAmountUnits: aggregate.receivedUnits.toString(),
		},
		transaction: {
			id: row.transaction_id,
			hash,
			amountUnits: row.amount_units,
			confirmations: row.confirmations,
		},
	};
	const endpoints = await matchingWebhookEndpoints(env.DB, row.order_id);
	const deliveries = endpoints.map((endpoint) => ({
		id: crypto.randomUUID(),
		endpoint,
	}));
	try {
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE order_payments SET status = ?, confirmed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending_review'",
			).bind(
				acceptedStatus,
				acceptedStatus === "confirmed" ? now : null,
				now,
				row.id,
			),
			env.DB.prepare(
				`SELECT CASE WHEN changes() = 1 THEN 1
			 ELSE json_extract('late payment decision conflict', '$') END`,
			),
			env.DB.prepare(
				"UPDATE blockchain_transactions SET status = ?, updated_at = ? WHERE network = ? AND tx_hash = ? AND event_index = ?",
			).bind(
				acceptedStatus === "confirmed" ? "confirmed" : "pending",
				now,
				row.network,
				hash,
				eventIndex,
			),
			env.DB.prepare(
				`UPDATE orders SET status = ?, received_amount_units = ?,
			 paid_at = CASE WHEN ? THEN COALESCE(paid_at, ?) ELSE NULL END,
			 version = version + 1, updated_at = ? WHERE id = ? AND version = ?
			 AND EXISTS (SELECT 1 FROM order_payments WHERE id = ? AND status = ? AND updated_at = ?)`,
			).bind(
				aggregate.status,
				aggregate.receivedUnits.toString(),
				["paid", "overpaid"].includes(aggregate.status) ? 1 : 0,
				now,
				now,
				row.order_id,
				row.version,
				row.id,
				acceptedStatus,
				now,
			),
			env.DB.prepare(
				`SELECT CASE WHEN changes() = 1 THEN 1
			 ELSE json_extract('late payment order conflict', '$') END`,
			),
			lateDecisionAudit(env.DB, row, actorUserId, decision, now),
			env.DB.prepare(
				`INSERT INTO webhook_events
			 (id, order_id, type, deduplication_key, payload, created_at, updated_at)
			 SELECT ?, ?, ?, ?, ?, ?, ?
			 WHERE EXISTS (
			  SELECT 1 FROM orders WHERE id = ? AND version = ? AND status = ? AND updated_at = ?
			 )`,
			).bind(
				eventId,
				row.order_id,
				eventType,
				`${row.order_id}:late:${row.id}:${aggregate.status}`,
				JSON.stringify(payload),
				now,
				now,
				row.order_id,
				row.version + 1,
				aggregate.status,
				now,
			),
			...deliveries.map(({ id, endpoint }) =>
				env.DB.prepare(
					`INSERT INTO webhook_deliveries
					 (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at)
				 SELECT ?, ?, ?, ?, 'queued', 0, ?, ?
				 WHERE EXISTS (SELECT 1 FROM webhook_events WHERE id = ?)`,
				).bind(
					id,
					eventId,
					endpoint.id,
					endpoint.api_key_id,
					now,
					now,
					eventId,
				),
			),
		]);
	} catch (error) {
		await rethrowLatePaymentDecision(env.DB, row.id, error);
	}
	await dispatchPaymentNotifications(
		env,
		eventId,
		payload,
		deliveries,
		eventType,
	);
	return { orderId: row.order_id, status: aggregate.status, decision };
}

function lateDecisionAudit(
	db: D1Database,
	row: { id: string; order_id: string },
	actorUserId: string | undefined,
	decision: "accept" | "reject",
	now: number,
) {
	return db
		.prepare(
			`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, after, created_at)
			 VALUES (?, ?, ?, 'order', ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			actorUserId ?? null,
			`payment.late_${decision}ed`,
			row.order_id,
			JSON.stringify({ paymentId: row.id }),
			now,
		);
}

async function rethrowLatePaymentDecision(
	db: D1Database,
	paymentId: string,
	error: unknown,
): Promise<never> {
	const current = await db
		.prepare(
			`SELECT op.status AS payment_status, o.status AS order_status
			 FROM order_payments op JOIN orders o ON o.id = op.order_id
			 WHERE op.id = ? LIMIT 1`,
		)
		.bind(paymentId)
		.first<{ payment_status: string; order_status: string }>();
	if (!current)
		throw new DomainError("payment_not_found", 404, "Late payment not found");
	assertLateDecisionAvailable(current);
	throw error;
}

/**
 * Only a `pending_review` row awaits a decision. The order may already have left
 * its terminal status through an earlier acceptance, so the row status decides.
 */
export function assertLateDecisionAvailable(payment: {
	payment_status: string;
	order_status: string;
}) {
	if (payment.payment_status === "pending_review") return;
	if (["expired", "cancelled"].includes(payment.order_status))
		throw new DomainError(
			"payment_decision_already_resolved",
			409,
			"Late payment has already been resolved",
		);
	throw new DomainError(
		"payment_decision_not_available",
		409,
		"Payment is not awaiting a late-payment decision",
	);
}
