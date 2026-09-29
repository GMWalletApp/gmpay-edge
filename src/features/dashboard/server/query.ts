import { minorToDecimal } from "#/lib/units";
import type { ReadDatabase } from "#/server/read-replica";

type OrderSummary = {
	total: number;
	active: number;
	paid: number;
	expired: number;
};
type WebhookSummary = { succeeded: number; completed: number };
type CountSummary = { total: number };
type ReadySummary = { enabled: number; total: number };
type ConnectionSummary = { total: number; healthy: number };
type DailyOrder = { day: string; order_count: number; paid_count: number };
type RecentOrder = {
	id: string;
	external_order_id: string;
	status: string;
	amount_minor: string;
	currency: string;
	currency_decimals: number;
	created_at: number;
	asset_code: string;
	network: string;
};

export async function queryAdminDashboard(db: ReadDatabase, now = Date.now()) {
	const rangeStart = startOfUtcDay(now) - 13 * 86_400_000;
	const results = await db.batch([
		db
			.prepare(`SELECT COUNT(*) AS total,
		 SUM(CASE WHEN status IN ('pending','confirming','partially_paid') AND expires_at > ? THEN 1 ELSE 0 END) AS active,
		 SUM(CASE WHEN status IN ('paid','overpaid') THEN 1 ELSE 0 END) AS paid,
		 SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired FROM orders`)
			.bind(now),
		db.prepare(`SELECT SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
		 SUM(CASE WHEN status IN ('succeeded','dead') THEN 1 ELSE 0 END) AS completed FROM webhook_deliveries`),
		db.prepare(`SELECT SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled,
				 COUNT(*) AS total FROM receiving_methods`),
		db.prepare("SELECT COUNT(*) AS total FROM order_payments"),
		db.prepare(`SELECT COUNT(*) AS total,
				 SUM(CASE WHEN connection.enabled = 1
				  AND (rail.kind IN ('exchange', 'wallet')
				   OR connection.health_status = 'healthy') THEN 1 ELSE 0 END) AS healthy
				 FROM payment_ingresses connection
				 JOIN payment_rails rail ON rail.code = connection.rail_code`),
		db
			.prepare(`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
			 COUNT(*) AS order_count,
			 SUM(CASE WHEN status IN ('paid','overpaid') THEN 1 ELSE 0 END) AS paid_count
			 FROM orders WHERE created_at >= ? GROUP BY day ORDER BY day`)
			.bind(rangeStart),
		db.prepare(`SELECT o.id, o.external_order_id, o.status, o.amount_minor,
			 o.currency, o.currency_decimals,
			 o.created_at, COALESCE(ops.asset_code, a.code, '') AS asset_code,
			 COALESCE(rail.name, ops.rail_code, a.rail_code, '') AS network
			 FROM orders o
			 LEFT JOIN payment_assets a ON a.id = o.payment_asset_id
			 LEFT JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 LEFT JOIN payment_rails rail ON rail.code = COALESCE(ops.rail_code, a.rail_code)
		 ORDER BY o.created_at DESC LIMIT 8`),
	]);
	if (results.length !== 7)
		throw new Error("Dashboard query batch is incomplete");
	const [
		orders,
		deliveries,
		receivingMethods,
		payments,
		connections,
		daily,
		recent,
	] = results as [
		D1Result<unknown>,
		D1Result<unknown>,
		D1Result<unknown>,
		D1Result<unknown>,
		D1Result<unknown>,
		D1Result<unknown>,
		D1Result<unknown>,
	];
	const orderSummary = first<OrderSummary>(orders);
	const webhookSummary = first<WebhookSummary>(deliveries);
	const receivingSummary = first<ReadySummary>(receivingMethods);
	const paymentSummary = first<CountSummary>(payments);
	const connectionSummary = first<ConnectionSummary>(connections);
	const completed = webhookSummary?.completed ?? 0;
	return {
		orders: {
			total: orderSummary?.total ?? 0,
			active: orderSummary?.active ?? 0,
			paid: orderSummary?.paid ?? 0,
			expired: orderSummary?.expired ?? 0,
		},
		webhooks: {
			succeeded: webhookSummary?.succeeded ?? 0,
			completed,
			successRate:
				completed > 0
					? Math.round(
							((webhookSummary?.succeeded ?? 0) / completed) * 10_000,
						) / 100
					: null,
		},
		receivingMethods: {
			enabled: receivingSummary?.enabled ?? 0,
			total: receivingSummary?.total ?? 0,
		},
		payments: { total: paymentSummary?.total ?? 0 },
		connections: {
			healthy: connectionSummary?.healthy ?? 0,
			total: connectionSummary?.total ?? 0,
		},
		dailyOrders: completeDailySeries(daily.results as DailyOrder[], rangeStart),
		recentOrders: (recent.results as RecentOrder[]).map((order) => ({
			id: order.id,
			externalOrderId: order.external_order_id,
			status: order.status,
			amount: minorToDecimal(order.amount_minor, order.currency_decimals),
			currency: order.currency,
			assetCode: order.asset_code,
			network: order.network,
			createdAt: new Date(order.created_at).toISOString(),
		})),
	};
}

function first<T>(result: D1Result<unknown>) {
	return result.results[0] as T | undefined;
}

function startOfUtcDay(value: number) {
	const date = new Date(value);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function completeDailySeries(
	rows: Array<{ day: string; order_count: number; paid_count: number }>,
	start: number,
) {
	const values = new Map(rows.map((row) => [row.day, row]));
	return Array.from({ length: 14 }, (_, index) => {
		const day = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
		const row = values.get(day);
		return {
			day,
			orderCount: row?.order_count ?? 0,
			paidCount: row?.paid_count ?? 0,
		};
	});
}
