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

type ExpirableOrder = {
	id: string;
	external_order_id: string;
	amount: string;
	currency: string;
	paymentAmount: string | null;
	received_amount_units: string;
	code: string | null;
	network: string | null;
	version: number;
	status: Extract<OrderStatus, "pending" | "partially_paid">;
};

export async function expireOrders(
	env: PaymentRuntime,
	now = Date.now(),
): Promise<number> {
	// The full status list is what lets SQLite prove the partial index applies;
	// confirming orders already hold the full amount and settle via confirmations.
	const storedCandidates = await env.DB.prepare(
		`SELECT o.id, o.external_order_id, o.amount_minor, o.currency,
		 o.currency_decimals, o.status, o.received_amount_units,
		 ops.expected_amount_units, ops.decimals,
		 ops.asset_code AS code, ops.rail_code AS network,
		 o.version
		 FROM orders o INDEXED BY orders_expiration_idx
		 LEFT JOIN order_payment_snapshots ops ON ops.order_id = o.id
		 WHERE o.status IN ('pending','confirming','partially_paid')
		 AND o.status <> 'confirming'
		 AND o.expires_at <= ? ORDER BY o.expires_at LIMIT 100`,
	)
		.bind(now)
		.all<
			StoredOrderAmounts & Omit<ExpirableOrder, "amount" | "paymentAmount">
		>();
	let expired = 0;
	for (const candidate of storedCandidates.results) {
		const order = displayOrderAmounts(candidate);
		if (await expireOrder(env, order, now)) expired += 1;
	}
	return expired;
}

export async function expireOrder(
	env: PaymentRuntime,
	order: ExpirableOrder,
	now: number,
) {
	assertTransition(order.status, "expired", "expired");
	const eventId = crypto.randomUUID();
	const eventType = "order.expired";
	const payload = {
		event: eventType,
		eventId,
		createdAt: new Date(now).toISOString(),
		instance: await paymentWebhookInstance(env.DB),
		orderId: order.id,
		externalOrderId: order.external_order_id,
		status: "expired",
		amount: order.amount,
		currency: order.currency,
		payment: {
			amount: order.paymentAmount,
			asset: order.code,
			network: order.network,
			receivedAmountUnits: order.received_amount_units,
		},
		transaction: null,
	};
	const endpoints = await matchingWebhookEndpoints(env.DB, order.id);
	const deliveries = endpoints.map((endpoint) => ({
		id: crypto.randomUUID(),
		endpoint,
	}));
	const results = await env.DB.batch([
		env.DB.prepare(
			"UPDATE orders SET status = 'expired', version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status IN ('pending','partially_paid')",
		).bind(now, order.id, order.version),
		env.DB.prepare(
			`UPDATE receiving_method_locks SET released_at = ?
			 WHERE order_id = ? AND released_at IS NULL
			 AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'expired' AND version = ?)`,
		).bind(now, order.id, order.id, order.version + 1),
		env.DB.prepare(
			`INSERT INTO webhook_events (id, order_id, type, deduplication_key, payload, created_at, updated_at)
			 SELECT ?, ?, ?, ?, ?, ?, ?
			 WHERE EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'expired' AND version = ?)`,
		).bind(
			eventId,
			order.id,
			eventType,
			`${order.id}:expired`,
			JSON.stringify(payload),
			now,
			now,
			order.id,
			order.version + 1,
		),
		...deliveries.map(({ id, endpoint }) =>
			env.DB.prepare(
				`INSERT INTO webhook_deliveries (id, event_id, order_id, api_key_id, status, attempt_count, created_at, updated_at)
				 SELECT ?, ?, ?, ?, 'queued', 0, ?, ? WHERE EXISTS (SELECT 1 FROM webhook_events WHERE id = ?)`,
			).bind(id, eventId, order.id, endpoint.api_key_id, now, now, eventId),
		),
	]);
	if ((results[0]?.meta.changes ?? 0) !== 1) return false;
	await dispatchPaymentNotifications(
		env,
		eventId,
		payload,
		deliveries,
		eventType,
	);
	return true;
}
