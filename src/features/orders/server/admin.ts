import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import {
	type SystemPermission,
	systemPermission,
} from "#/features/access/system-rbac";
import {
	type OrderStatus,
	orderAmountSchema,
	orderCurrencySchema,
	orderIdPathSchema,
	orderStatuses,
} from "#/features/orders/schema";
import {
	cancelOrderAsAdmin,
	queueAdminPaymentCheck,
	recordExternalRefund,
	resendOrderNotification,
} from "#/features/orders/server/admin-actions";
import { createOrder } from "#/features/orders/server/create";
import {
	assertTransition,
	InvalidOrderTransitionError,
	type TransitionReason,
} from "#/features/orders/state-machine";
import { recordPaymentTransaction } from "#/features/payments/server/process";
import { DomainError } from "#/lib/domain-error";
import { unitsToDecimal } from "#/lib/money";
import { minorToDecimal } from "#/lib/units";
import { getCloudflareEnv } from "#/server/db.server";
import { requestId } from "#/server/http";
import { readDatabase } from "#/server/read-replica";

const orderIdSchema = z.object({ orderId: orderIdPathSchema });
const refundSchema = orderIdSchema.extend({
	reference: z.string().trim().min(3).max(256),
	note: z.string().trim().min(3).max(1_000),
});
const developmentOrderSchema = z.object({
	amount: orderAmountSchema,
	currency: orderCurrencySchema,
	description: z.string().trim().max(500).optional(),
});
const developmentStatusSchema = orderIdSchema.extend({
	status: z.enum(orderStatuses),
});
const adminOrdersListSchema = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(100).default(10),
	search: z.string().trim().max(200).default(""),
	beforeCreatedAt: z.number().int().positive().optional(),
	cursor: z
		.object({
			createdAt: z.number().int().positive(),
			id: z.string().min(1).max(128),
		})
		.optional(),
});

type AdminOrderRow = {
	id: string;
	external_order_id: string;
	status: string;
	amount_minor: string;
	currency: string;
	currency_decimals: number;
	expected_amount_units: string | null;
	received_amount_units: string;
	expires_at: number;
	paid_at: number | null;
	created_at: number;
	notify_url: string | null;
	asset_code: string;
	network: string;
	network_name: string;
	rail_kind: "chain" | "exchange" | "wallet" | "";
	decimals: number;
	address: string | null;
	adapter: string | null;
	confirmations: number;
	required_confirmations: number;
};

export const createDevelopmentOrderFn = createServerFn({ method: "POST" })
	.validator((input) => developmentOrderSchema.parse(input))
	.handler(async ({ data }) => {
		if (!import.meta.env.DEV)
			throw new DomainError(
				"order_development_only",
				404,
				"Development order tools are unavailable",
			);
		const request = getRequest();
		const user = await requireAdmin(
			request,
			systemPermission("orders", "create"),
		);
		const db = getCloudflareEnv(request).DB;
		if (!db) throw new Error("D1 binding DB is unavailable");
		const order = await createOrder(
			db,
			{
				externalOrderId: `DEV-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
				amount: data.amount,
				currency: data.currency,
				description: data.description || undefined,
			},
			request.url,
			{},
		);
		await db
			.prepare(
				`INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id,
					 request_id, ip_address, after, created_at)
					 VALUES (?, ?, 'order.development_created', 'order', ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				user.id,
				order.orderId,
				requestId(request),
				request.headers.get("cf-connecting-ip"),
				JSON.stringify({ amount: order.amount, currency: order.currency }),
				Date.now(),
			)
			.run();
		return order;
	});

export const simulateDevelopmentOrderStatusFn = createServerFn({
	method: "POST",
})
	.validator((input) => developmentStatusSchema.parse(input))
	.handler(async ({ data }) => {
		if (!import.meta.env.DEV)
			throw new DomainError(
				"order_development_only",
				404,
				"Development order tools are unavailable",
			);
		const request = getRequest();
		const user = await requireAdmin(
			request,
			systemPermission("orders", "update"),
		);
		const db = getCloudflareEnv(request).DB;
		if (!db) throw new Error("D1 binding DB is unavailable");
		const order = await db
			.prepare(`SELECT o.status, ops.expected_amount_units FROM orders o
				LEFT JOIN order_payment_snapshots ops ON ops.order_id = o.id
				WHERE o.id = ? LIMIT 1`)
			.bind(data.orderId)
			.first<{ status: OrderStatus; expected_amount_units: string | null }>();
		if (!order)
			throw new DomainError("order_not_found", 404, "Order not found");
		assertDevelopmentTransition(order.status, data.status);
		const expected = BigInt(order.expected_amount_units ?? "0");
		const received = developmentReceivedAmount(data.status, expected);
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"UPDATE orders SET status = ?, received_amount_units = ?, paid_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = ?",
				)
				.bind(
					data.status,
					received.toString(),
					["paid", "overpaid", "refunded"].includes(data.status) ? now : null,
					now,
					data.orderId,
					order.status,
				),
			db.prepare(
				"SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('order simulation conflict', '$') END",
			),
			db
				.prepare(
					`INSERT INTO audit_logs (id, actor_user_id, action, target_type,
					 target_id, request_id, ip_address, before, after, created_at)
					 VALUES (?, ?, 'order.development_status_simulated', 'order', ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					user.id,
					data.orderId,
					requestId(request),
					request.headers.get("cf-connecting-ip"),
					JSON.stringify({ status: order.status }),
					JSON.stringify({
						status: data.status,
						receivedAmountUnits: received.toString(),
					}),
					now,
				),
		]);
		return { ...data, receivedAmountUnits: received.toString() };
	});

const developmentTransitionReasons: Partial<
	Record<OrderStatus, TransitionReason>
> = {
	expired: "expired",
	cancelled: "merchant_cancelled",
	failed: "processing_failed",
	refunded: "admin_refund",
};

/** The development simulator obeys the same state machine as real payments. */
function assertDevelopmentTransition(from: OrderStatus, to: OrderStatus) {
	try {
		assertTransition(
			from,
			to,
			developmentTransitionReasons[to] ?? "payment_detected",
		);
	} catch (error) {
		if (error instanceof InvalidOrderTransitionError)
			throw new DomainError(
				"order_status_conflict",
				409,
				"Order status does not allow this simulation",
			);
		throw error;
	}
}

function developmentReceivedAmount(
	status: (typeof orderStatuses)[number],
	expected: bigint,
) {
	if (status === "partially_paid")
		return expected > 1n ? expected / 2n : expected;
	if (status === "overpaid") return expected + 1n;
	if (["confirming", "paid", "refunded"].includes(status)) return expected;
	return 0n;
}

export const listAdminOrdersFn = createServerFn({ method: "GET" })
	.validator((input) => adminOrdersListSchema.parse(input))
	.handler(async ({ data }) => {
		const db = await adminDb(systemPermission("orders", "read"));
		const search = data.search ? `%${data.search}%` : null;
		const countClauses = [
			...(search ? ["(o.external_order_id LIKE ? OR o.id LIKE ?)"] : []),
			...(data.beforeCreatedAt ? ["o.created_at <= ?"] : []),
		];
		const countWhere = countClauses.length
			? `WHERE ${countClauses.join(" AND ")}`
			: "";
		const countBindings = [
			...(search ? [search, search] : []),
			...(data.beforeCreatedAt ? [data.beforeCreatedAt] : []),
		];
		const rowClauses = [
			...countClauses,
			...(data.cursor
				? ["(o.created_at < ? OR (o.created_at = ? AND o.id < ?))"]
				: []),
		];
		const rowWhere = rowClauses.length
			? `WHERE ${rowClauses.join(" AND ")}`
			: "";
		const rowBindings = [
			...countBindings,
			...(data.cursor
				? [data.cursor.createdAt, data.cursor.createdAt, data.cursor.id]
				: []),
		];
		const offset = data.cursor ? 0 : data.pageIndex * data.pageSize;
		const [countResult, rowsResult] = await db.batch([
			db
				.prepare(`SELECT COUNT(*) AS total FROM orders o ${countWhere}`)
				.bind(...countBindings),
			db
				.prepare(
					`SELECT o.id, o.external_order_id, o.status, o.amount_minor, o.currency,
		 o.currency_decimals, o.received_amount_units, o.expires_at, o.paid_at,
			 o.created_at, o.notify_url, COALESCE(ops.asset_code, a.code, '') AS asset_code,
			 ops.expected_amount_units,
			 COALESCE(ops.rail_code, a.rail_code, '') AS network,
			 COALESCE(pr.name, ops.rail_code, a.rail_code, '') AS network_name,
			 COALESCE(pr.kind, '') AS rail_kind,
		 COALESCE(ops.decimals, a.decimals, 0) AS decimals,
		 ops.target_value AS address,
		 ops.adapter,
			 COALESCE((SELECT MAX(op.confirmations) FROM order_payments op
				WHERE op.order_id = o.id), 0) AS confirmations,
			 COALESCE(ops.required_confirmations, 1) AS required_confirmations
		 FROM orders o
		 LEFT JOIN payment_assets a ON a.id = o.payment_asset_id
		 LEFT JOIN order_payment_snapshots ops ON ops.order_id = o.id
		 LEFT JOIN payment_rails pr ON pr.code = COALESCE(ops.rail_code, a.rail_code)
			 ${rowWhere}
			 ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
				)
				.bind(...rowBindings, data.pageSize, offset),
		]);
		const count = countResult?.results?.[0] as { total: number } | undefined;
		const rows = rowsResult as D1Result<AdminOrderRow>;
		const items = rows.results.map((row) => ({
			id: row.id,
			externalOrderId: row.external_order_id,
			status: row.status,
			amount: minorToDecimal(row.amount_minor, row.currency_decimals),
			currency: row.currency,
			paymentAmount:
				row.expected_amount_units !== null
					? unitsToDecimal(BigInt(row.expected_amount_units), row.decimals)
					: "",
			receivedAmountUnits: row.received_amount_units,
			assetCode: row.asset_code,
			network: row.network,
			networkName: row.network_name,
			railKind: row.rail_kind,
			decimals: row.decimals,
			address: row.address,
			adapter: row.adapter,
			confirmations: row.confirmations,
			requiredConfirmations: row.required_confirmations,
			expiresAt: new Date(row.expires_at).toISOString(),
			paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
			createdAt: new Date(row.created_at).toISOString(),
			notifyUrl: row.notify_url,
		}));
		const last = rows.results.at(-1);
		return {
			items,
			total: count?.total ?? 0,
			pageIndex: data.pageIndex,
			pageSize: data.pageSize,
			nextCursor:
				rows.results.length === data.pageSize && last
					? { createdAt: last.created_at, id: last.id }
					: null,
		};
	});

export const simulateOrderPaymentFn = createServerFn({ method: "POST" })
	.validator((input) => orderIdSchema.parse(input))
	.handler(async ({ data }) => {
		const request = getRequest();
		const user = await requireAdmin(
			request,
			systemPermission("orders", "update"),
		);
		const env = getCloudflareEnv(request);
		if (!env.DB) throw new Error("D1 binding DB is unavailable");
		if (!env.WEBHOOK_QUEUE)
			throw new DomainError(
				"order_webhook_queue_unavailable",
				503,
				"Webhook queue is unavailable",
			);
		const order = await env.DB.prepare(
			`SELECT ops.expected_amount_units, ops.decimals, ops.asset_code AS code,
			 ops.rail_code AS network, ops.target_value AS address,
			 ops.adapter, ops.required_confirmations
			 FROM orders o JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 WHERE o.id = ? LIMIT 1`,
		)
			.bind(data.orderId)
			.first<{
				expected_amount_units: string;
				decimals: number;
				code: string;
				network: "tron";
				address: string;
				adapter: string;
				required_confirmations: number;
			}>();
		if (!order)
			throw new DomainError("order_not_found", 404, "Order not found");
		if (order.adapter !== "mock") {
			throw new DomainError(
				"order_mock_only",
				409,
				"Only mock payment methods can be simulated",
			);
		}
		const now = Date.now();
		const result = await recordPaymentTransaction(
			{ DB: env.DB, WEBHOOK_QUEUE: env.WEBHOOK_QUEUE },
			data.orderId,
			{
				network: order.network,
				hash: `sim_${crypto.randomUUID().replaceAll("-", "")}`,
				eventIndex: 0,
				from: "TSimulatedPayer11111111111111111111",
				to: order.address,
				assetCode: order.code,
				amountUnits: BigInt(order.expected_amount_units),
				blockNumber: BigInt(now),
				blockHash: `sim-block-${now}`,
				confirmations: order.required_confirmations,
				timestamp: new Date(now),
				success: true,
			},
		);
		await env.DB.prepare(
			"INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at) VALUES (?, ?, 'order.payment_simulated', 'order', ?, ?, ?, ?, ?)",
		)
			.bind(
				crypto.randomUUID(),
				user.id,
				data.orderId,
				requestId(request),
				request.headers.get("cf-connecting-ip"),
				JSON.stringify(result),
				now,
			)
			.run();
		return result;
	});

export const checkAdminOrderPaymentFn = createServerFn({ method: "POST" })
	.validator((input) => orderIdSchema.parse(input))
	.handler(async ({ data }) => {
		const { request, user, env } = await adminActionContext(
			systemPermission("orders", "update"),
		);
		if (!env.PAYMENT_QUEUE)
			throw new DomainError(
				"order_payment_queue_unavailable",
				503,
				"Payment queue is unavailable",
			);
		return queueAdminPaymentCheck(
			{ DB: env.DB, PAYMENT_QUEUE: env.PAYMENT_QUEUE },
			data.orderId,
			{
				actorUserId: user.id,
				requestId: requestId(request),
				ipAddress: request.headers.get("cf-connecting-ip"),
			},
		);
	});

export const cancelAdminOrderFn = createServerFn({ method: "POST" })
	.validator((input) => orderIdSchema.parse(input))
	.handler(async ({ data }) => {
		const { request, user, env } = await adminActionContext(
			systemPermission("orders", "update"),
		);
		if (!env.WEBHOOK_QUEUE)
			throw new DomainError(
				"order_webhook_queue_unavailable",
				503,
				"Webhook queue is unavailable",
			);
		return cancelOrderAsAdmin(
			{ DB: env.DB, WEBHOOK_QUEUE: env.WEBHOOK_QUEUE },
			data.orderId,
			{
				actorUserId: user.id,
				requestId: requestId(request),
				ipAddress: request.headers.get("cf-connecting-ip"),
			},
		);
	});

export const refundAdminOrderFn = createServerFn({ method: "POST" })
	.validator((input) => refundSchema.parse(input))
	.handler(async ({ data }) => {
		const { request, user, env } = await adminActionContext(
			systemPermission("orders", "update"),
		);
		if (!env.WEBHOOK_QUEUE)
			throw new DomainError(
				"order_webhook_queue_unavailable",
				503,
				"Webhook queue is unavailable",
			);
		return recordExternalRefund(
			{ DB: env.DB, WEBHOOK_QUEUE: env.WEBHOOK_QUEUE },
			data,
			{
				actorUserId: user.id,
				requestId: requestId(request),
				ipAddress: request.headers.get("cf-connecting-ip"),
			},
		);
	});

export const resendOrderNotificationFn = createServerFn({ method: "POST" })
	.validator((input) => orderIdSchema.parse(input))
	.handler(async ({ data }) => {
		const { request, user, env } = await adminActionContext(
			systemPermission("orders", "update"),
		);
		if (!env.WEBHOOK_QUEUE)
			throw new DomainError(
				"order_webhook_queue_unavailable",
				503,
				"Webhook queue is unavailable",
			);
		return resendOrderNotification(
			{ DB: env.DB, WEBHOOK_QUEUE: env.WEBHOOK_QUEUE },
			data.orderId,
			{
				actorUserId: user.id,
				requestId: requestId(request),
				ipAddress: request.headers.get("cf-connecting-ip"),
			},
		);
	});

async function adminActionContext(permission: SystemPermission) {
	const request = getRequest();
	const user = await requireAdmin(request, permission);
	const env = getCloudflareEnv(request);
	if (!env.DB) throw new Error("D1 binding DB is unavailable");
	return { request, user, env: { ...env, DB: env.DB } };
}

async function adminDb(permission: SystemPermission) {
	const request = getRequest();
	await requireAdmin(request, permission);
	const db = getCloudflareEnv(request).DB;
	if (!db) throw new Error("D1 binding DB is unavailable");
	return readDatabase(request, db);
}
