import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import { resolveLatePaymentAsAdmin } from "#/features/payments/server/admin-actions";
import { DomainError } from "#/lib/domain-error";
import { getCloudflareEnv } from "#/server/db.server";
import { readDatabase } from "#/server/read-replica";

const adminPaymentsListSchema = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(100).default(10),
	search: z.string().trim().max(200).default(""),
	beforeDetectedAt: z.number().int().positive().optional(),
	cursor: z
		.object({
			detectedAt: z.number().int().positive(),
			id: z.string().min(1).max(128),
		})
		.optional(),
});

type AdminPaymentRow = {
	id: string;
	order_id: string;
	transaction_id: string;
	amount_units: string;
	confirmations: number;
	status: string;
	detected_at: number;
	confirmed_at: number | null;
	external_order_id: string;
	order_status: string;
	asset_code: string;
	network: string;
	decimals: number;
};

export const listAdminPaymentsFn = createServerFn({ method: "GET" })
	.validator((input) => adminPaymentsListSchema.parse(input))
	.handler(async ({ data }) => {
		const db = await adminPaymentsDb(systemPermission("payments", "read"));
		const search = data.search ? `%${data.search}%` : null;
		const countClauses = [
			...(search
				? [
						"(op.transaction_id LIKE ? OR op.order_id LIKE ? OR o.external_order_id LIKE ?)",
					]
				: []),
			...(data.beforeDetectedAt ? ["op.detected_at <= ?"] : []),
		];
		const countWhere = countClauses.length
			? `WHERE ${countClauses.join(" AND ")}`
			: "";
		const countBindings = [
			...(search ? [search, search, search] : []),
			...(data.beforeDetectedAt ? [data.beforeDetectedAt] : []),
		];
		const rowClauses = [
			...countClauses,
			...(data.cursor
				? ["(op.detected_at < ? OR (op.detected_at = ? AND op.id < ?))"]
				: []),
		];
		const rowWhere = rowClauses.length
			? `WHERE ${rowClauses.join(" AND ")}`
			: "";
		const rowBindings = [
			...countBindings,
			...(data.cursor
				? [data.cursor.detectedAt, data.cursor.detectedAt, data.cursor.id]
				: []),
		];
		const offset = data.cursor ? 0 : data.pageIndex * data.pageSize;
		const [countResult, rowsResult] = await db.batch([
			db
				.prepare(
					`SELECT COUNT(*) AS total
					 FROM order_payments op JOIN orders o ON o.id = op.order_id ${countWhere}`,
				)
				.bind(...countBindings),
			db
				.prepare(
					`SELECT op.id, op.order_id, op.transaction_id, op.amount_units,
		 op.confirmations, op.status, op.detected_at, op.confirmed_at,
		 o.external_order_id, o.status AS order_status, ops.asset_code,
		 ops.rail_code AS network, ops.decimals
		 FROM order_payments op JOIN orders o ON o.id = op.order_id
		 JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 ${rowWhere}
			 ORDER BY op.detected_at DESC, op.id DESC LIMIT ? OFFSET ?`,
				)
				.bind(...rowBindings, data.pageSize, offset),
		]);
		const count = countResult?.results?.[0] as { total: number } | undefined;
		const rows = rowsResult as D1Result<AdminPaymentRow>;
		const items = rows.results.map((row) => ({
			id: row.id,
			orderId: row.order_id,
			externalOrderId: row.external_order_id,
			orderStatus: row.order_status,
			transactionId: row.transaction_id,
			amountUnits: row.amount_units,
			confirmations: row.confirmations,
			status: row.status,
			assetCode: row.asset_code,
			network: row.network,
			decimals: row.decimals,
			detectedAt: new Date(row.detected_at).toISOString(),
			confirmedAt: row.confirmed_at
				? new Date(row.confirmed_at).toISOString()
				: null,
		}));
		const last = rows.results.at(-1);
		return {
			items,
			total: count?.total ?? 0,
			pageIndex: data.pageIndex,
			pageSize: data.pageSize,
			nextCursor:
				rows.results.length === data.pageSize && last
					? { detectedAt: last.detected_at, id: last.id }
					: null,
		};
	});

export const resolveLatePaymentFn = createServerFn({ method: "POST" })
	.validator((input: { paymentId: string; decision: "accept" | "reject" }) =>
		z
			.object({ paymentId: z.uuid(), decision: z.enum(["accept", "reject"]) })
			.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const user = await requireAdmin(
			request,
			systemPermission("payments", "update"),
		);
		const env = getCloudflareEnv(request);
		if (!(env.DB && env.WEBHOOK_QUEUE))
			throw new DomainError(
				"payment_service_unavailable",
				503,
				"Payment service is unavailable",
			);
		return resolveLatePaymentAsAdmin(
			{ DB: env.DB, WEBHOOK_QUEUE: env.WEBHOOK_QUEUE },
			data.paymentId,
			data.decision,
			user.id,
		);
	});

async function adminPaymentsDb(
	permission: ReturnType<typeof systemPermission>,
) {
	const request = getRequest();
	await requireAdmin(request, permission);
	const db = getCloudflareEnv(request).DB;
	if (!db)
		throw new DomainError(
			"payment_service_unavailable",
			503,
			"Payment service is unavailable",
		);
	return readDatabase(request, db);
}
