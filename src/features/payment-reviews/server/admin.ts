import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import {
	resolvePaymentReview,
	resolvePaymentReviewSchema,
} from "#/features/payment-reviews/server/resolve";
import { DomainError } from "#/lib/domain-error";
import { unitsToDecimal } from "#/lib/money";
import { minorToDecimal } from "#/lib/units";
import { getCloudflareEnv } from "#/server/db.server";
import { requestId } from "#/server/http";

const paymentReviewsListSchema = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(100).default(10),
	search: z.string().trim().max(200).default(""),
	beforeCreatedAt: z.number().int().positive().optional(),
});

export const listPaymentReviewsFn = createServerFn({ method: "GET" })
	.validator((input) => paymentReviewsListSchema.parse(input))
	.handler(async ({ data }) => {
		const request = getRequest();
		await requireAdmin(request, systemPermission("payment_reviews", "read"));
		const db = getCloudflareEnv(request).DB;
		if (!db)
			throw new DomainError(
				"payment_review_service_unavailable",
				503,
				"Payment review storage is unavailable",
			);
		const search = data.search ? `%${data.search}%` : null;
		const filters: string[] = [];
		const bindings: Array<string | number> = [];
		if (search) {
			filters.push("(o.external_order_id LIKE ? OR o.id LIKE ?)");
			bindings.push(search, search);
		}
		if (data.beforeCreatedAt !== undefined) {
			filters.push("pr.created_at <= ?");
			bindings.push(data.beforeCreatedAt);
		}
		const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
		const offset = data.pageIndex * data.pageSize;
		const [countResult, rowsResult] = await db.batch([
			db
				.prepare(
					`SELECT COUNT(*) AS total
					 FROM payment_reviews pr JOIN orders o ON o.id = pr.order_id ${where}`,
				)
				.bind(...bindings),
			db
				.prepare(
					`SELECT pr.id, pr.order_id, pr.status, pr.transaction_hash, pr.description,
				 pr.evidence_content_type, pr.evidence_size_bytes, pr.evidence_sha256,
				 pr.resolution_note, pr.created_at, pr.reviewed_at,
				 o.external_order_id, o.status AS order_status, o.amount_minor,
				 o.currency, o.currency_decimals, ops.expected_amount_units,
				 ops.decimals, ops.asset_code,
				 ops.rail_code AS network,
				 u.name AS reviewer_name
					FROM payment_reviews pr INDEXED BY payment_reviews_list_idx
					CROSS JOIN orders o ON o.id = pr.order_id
					CROSS JOIN order_payment_snapshots ops ON ops.order_id = o.id
					LEFT JOIN users u ON u.id = pr.reviewer_user_id
					${where}
					ORDER BY CASE pr.status WHEN 'pending' THEN 0 ELSE 1 END,
					pr.created_at DESC, pr.id DESC LIMIT ? OFFSET ?`,
				)
				.bind(...bindings, data.pageSize, offset),
		]);
		const count = countResult?.results?.[0] as { total: number } | undefined;
		const rows = rowsResult as D1Result<Record<string, string | number | null>>;
		return {
			items: rows.results.map((row) => ({
				id: String(row.id),
				orderId: String(row.order_id),
				externalOrderId: String(row.external_order_id),
				status: String(row.status),
				orderStatus: String(row.order_status),
				transactionHash: row.transaction_hash
					? String(row.transaction_hash)
					: null,
				description: String(row.description),
				evidenceContentType: String(row.evidence_content_type),
				evidenceSize: Number(row.evidence_size_bytes),
				evidenceSha256: String(row.evidence_sha256),
				amount: minorToDecimal(
					String(row.amount_minor),
					Number(row.currency_decimals),
				),
				currency: String(row.currency),
				paymentAmount: unitsToDecimal(
					BigInt(String(row.expected_amount_units)),
					Number(row.decimals),
				),
				assetCode: String(row.asset_code),
				network: String(row.network),
				resolutionNote: row.resolution_note
					? String(row.resolution_note)
					: null,
				reviewerName: row.reviewer_name ? String(row.reviewer_name) : null,
				createdAt: new Date(Number(row.created_at)).toISOString(),
				reviewedAt: row.reviewed_at
					? new Date(Number(row.reviewed_at)).toISOString()
					: null,
			})),
			total: count?.total ?? 0,
			pageIndex: data.pageIndex,
			pageSize: data.pageSize,
		};
	});

export const resolvePaymentReviewFn = createServerFn({ method: "POST" })
	.validator(resolvePaymentReviewSchema)
	.handler(async ({ data }) => {
		const request = getRequest();
		const user = await requireAdmin(
			request,
			systemPermission("payment_reviews", "update"),
		);
		const env = getCloudflareEnv(request);
		if (!(env.DB && env.WEBHOOK_QUEUE))
			throw new DomainError(
				"payment_review_service_unavailable",
				503,
				"Payment review service is unavailable",
			);
		return resolvePaymentReview(
			{ DB: env.DB, WEBHOOK_QUEUE: env.WEBHOOK_QUEUE },
			data,
			{
				reviewerUserId: user.id,
				requestId: requestId(request),
				ipAddress: request.headers.get("cf-connecting-ip"),
			},
		);
	});
