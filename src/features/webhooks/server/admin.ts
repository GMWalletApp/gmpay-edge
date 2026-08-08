import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import {
	type SystemPermission,
	systemPermission,
} from "#/features/access/system-rbac";
import { loadAdminWebhookDelivery } from "#/features/webhooks/server/admin-detail";
import { loadInboundWebhookReceipt } from "#/features/webhooks/server/inbound-admin";
import { inboundWebhookCatalogEndpoints } from "#/features/webhooks/server/inbound-receipts";
import {
	claimManualWebhookRetry,
	completeManualWebhookRetry,
	releaseManualWebhookRetry,
	requireRetryableWebhookDelivery,
} from "#/features/webhooks/server/retry";
import type { WebhookQueueMessage } from "#/features/webhooks/types";
import { DomainError } from "#/lib/domain-error";
import { getCloudflareEnv } from "#/server/db.server";

const webhookListSchema = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(100).default(10),
	search: z.string().trim().max(200).default(""),
	beforeCreatedAt: z.number().int().positive().optional(),
});

export const listInboundWebhookEndpointsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await adminContext(
		systemPermission("webhooks", "read"),
		"webhook_inbound_unavailable",
	);
	const rows = await db
		.prepare(`SELECT endpoint_code, COUNT(id) AS receipt_count,
		MAX(received_at) AS last_received_at FROM inbound_webhook_receipts
		GROUP BY endpoint_code`)
		.all<{
			endpoint_code: string;
			receipt_count: number;
			last_received_at: number | null;
		}>();
	const statistics = new Map(
		rows.results.map((row) => [row.endpoint_code, row]),
	);
	return inboundWebhookCatalogEndpoints.map((endpoint) => {
		const statistic = statistics.get(endpoint.code);
		return {
			...endpoint,
			receiptCount: statistic?.receipt_count ?? 0,
			lastReceivedAt: statistic?.last_received_at
				? new Date(statistic.last_received_at).toISOString()
				: null,
		};
	});
});

export const listInboundWebhookReceiptsFn = createServerFn({ method: "GET" })
	.validator((input) => webhookListSchema.parse(input))
	.handler(async ({ data }) => {
		const { db } = await adminContext(
			systemPermission("webhooks", "read"),
			"webhook_inbound_unavailable",
		);
		const search = data.search ? `%${data.search}%` : null;
		const filters: string[] = [];
		const parameters: Array<string | number> = [];
		if (search) {
			filters.push(
				"(endpoint_code LIKE ? OR request_id LIKE ? OR external_request_id LIKE ? OR request_path LIKE ?)",
			);
			parameters.push(search, search, search, search);
		}
		if (data.beforeCreatedAt !== undefined) {
			filters.push("received_at <= ?");
			parameters.push(data.beforeCreatedAt);
		}
		const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
		const [countResult, rowsResult] = await db.batch([
			db
				.prepare(
					`SELECT COUNT(*) AS total FROM inbound_webhook_receipts ${where}`,
				)
				.bind(...parameters),
			db
				.prepare(`SELECT id, endpoint_code, request_id, external_request_id, method, request_path,
				 signature_status, processing_status, response_status, duration_ms,
				 error_code, received_at FROM inbound_webhook_receipts
				 INDEXED BY inbound_webhook_receipts_retention_idx ${where}
				 ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?`)
				.bind(...parameters, data.pageSize, data.pageIndex * data.pageSize),
		]);
		const count = countResult?.results?.[0] as { total: number } | undefined;
		const rows = rowsResult as D1Result<{
			id: string;
			endpoint_code: string;
			request_id: string;
			external_request_id: string | null;
			method: string;
			request_path: string;
			signature_status: string;
			processing_status: string;
			response_status: number;
			duration_ms: number;
			error_code: string | null;
			received_at: number;
		}>;
		return {
			items: rows.results.map((row) => ({
				id: row.id,
				endpointCode: row.endpoint_code,
				requestId: row.request_id,
				externalRequestId: row.external_request_id,
				method: row.method,
				requestPath: row.request_path,
				signatureStatus: row.signature_status,
				processingStatus: row.processing_status,
				responseStatus: row.response_status,
				durationMs: row.duration_ms,
				errorCode: row.error_code,
				receivedAt: new Date(row.received_at).toISOString(),
			})),
			total: count?.total ?? 0,
			pageIndex: data.pageIndex,
			pageSize: data.pageSize,
		};
	});

export const getInboundWebhookReceiptFn = createServerFn({ method: "GET" })
	.validator((input: { id: string }) =>
		z.object({ id: z.string().uuid() }).parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await adminContext(
			systemPermission("webhooks", "read"),
			"webhook_inbound_unavailable",
		);
		return loadInboundWebhookReceipt(db, data.id);
	});

export const listAdminWebhooksFn = createServerFn({ method: "GET" })
	.validator((input) => webhookListSchema.parse(input))
	.handler(async ({ data }) => {
		const { db } = await adminContext(systemPermission("webhooks", "read"));
		const search = data.search ? `%${data.search}%` : null;
		const filters: string[] = [];
		const parameters: Array<string | number> = [];
		if (search) {
			filters.push("(e.type LIKE ? OR d.id LIKE ? OR e.id LIKE ?)");
			parameters.push(search, search, search);
		}
		if (data.beforeCreatedAt !== undefined) {
			filters.push("d.created_at <= ?");
			parameters.push(data.beforeCreatedAt);
		}
		const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
		const offset = data.pageIndex * data.pageSize;
		const [countResult, rowsResult] = await db.batch([
			db
				.prepare(
					`SELECT COUNT(*) AS total
					 FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id ${where}`,
				)
				.bind(...parameters),
			db
				.prepare(`SELECT d.id, d.status, d.attempt_count, d.next_attempt_at,
		d.completed_at, d.created_at, e.id AS event_id, e.type, e.order_id, o.notify_url AS url,
		a.response_status, a.duration_ms, a.error_code, a.response_excerpt
		FROM webhook_deliveries d INDEXED BY webhook_deliveries_created_idx
		CROSS JOIN webhook_events e ON e.id = d.event_id
		CROSS JOIN orders o ON o.id = d.order_id
		LEFT JOIN webhook_attempts a ON a.delivery_id = d.id AND a.attempt = d.attempt_count
		${where}
		ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`)
				.bind(...parameters, data.pageSize, offset),
		]);
		const count = countResult?.results?.[0] as { total: number } | undefined;
		const rows = rowsResult as D1Result<{
			id: string;
			status: string;
			attempt_count: number;
			next_attempt_at: number | null;
			completed_at: number | null;
			created_at: number;
			event_id: string;
			type: string;
			order_id: string;
			url: string;
			response_status: number | null;
			duration_ms: number | null;
			error_code: string | null;
			response_excerpt: string | null;
		}>;
		return {
			items: rows.results.map((row) => ({
				id: row.id,
				eventId: row.event_id,
				type: row.type,
				orderId: row.order_id,
				url: row.url,
				status: row.status,
				attemptCount: row.attempt_count,
				responseStatus: row.response_status,
				durationMs: row.duration_ms,
				errorCode: row.error_code,
				responseExcerpt: row.response_excerpt,
				nextAttemptAt: row.next_attempt_at
					? new Date(row.next_attempt_at).toISOString()
					: null,
				completedAt: row.completed_at
					? new Date(row.completed_at).toISOString()
					: null,
				createdAt: new Date(row.created_at).toISOString(),
			})),
			total: count?.total ?? 0,
			pageIndex: data.pageIndex,
			pageSize: data.pageSize,
		};
	});

export const getAdminWebhookDeliveryFn = createServerFn({ method: "GET" })
	.validator((input: { id: string }) =>
		z.object({ id: z.string().uuid() }).parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await adminContext(systemPermission("webhooks", "read"));
		return loadAdminWebhookDelivery(db, data.id);
	});

export const retryWebhookDeliveryFn = createServerFn({ method: "POST" })
	.validator((input: { id: string }) =>
		z.object({ id: z.string().uuid() }).parse(input),
	)
	.handler(async ({ data }) => {
		const { db, env, request, user } = await adminContext(
			systemPermission("webhooks", "update"),
		);
		if (!env.WEBHOOK_QUEUE)
			throw new DomainError(
				"webhook_queue_unavailable",
				503,
				"Webhook queue is unavailable",
			);
		const row = await db
			.prepare(`SELECT d.id, d.status, d.attempt_count, e.id AS event_id
			FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id WHERE d.id = ? LIMIT 1`)
			.bind(data.id)
			.first<{
				id: string;
				status: "failed" | "dead" | "queued" | "delivering" | "succeeded";
				attempt_count: number;
				event_id: string;
			}>();
		requireRetryableWebhookDelivery(row);
		const now = Date.now();
		const claimToken =
			-Number.parseInt(crypto.randomUUID().slice(0, 8), 16) - 1;
		if (!(await claimManualWebhookRetry(db, data.id, claimToken, now)))
			throw new DomainError(
				"webhook_delivery_retry_in_progress",
				409,
				"Webhook delivery retry is already in progress",
			);
		const message: WebhookQueueMessage = {
			kind: "webhook.delivery",
			version: 1,
			deliveryId: data.id,
			eventId: row.event_id,
			attempt: 1,
		};
		try {
			await env.WEBHOOK_QUEUE.send(message);
			await completeManualWebhookRetry(db, data.id, claimToken);
			await db
				.prepare(`INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id,
				request_id, ip_address, created_at) VALUES (?, ?, 'webhook.delivery_retried', 'webhook_delivery', ?, ?, ?, ?)`)
				.bind(
					crypto.randomUUID(),
					user.id,
					data.id,
					request.headers.get("x-request-id"),
					request.headers.get("cf-connecting-ip"),
					now,
				)
				.run();
		} catch (error) {
			await releaseManualWebhookRetry(db, data.id, claimToken, {
				status: row.status,
				attemptCount: row.attempt_count,
			});
			throw error;
		}
		return { id: data.id, status: "queued" as const };
	});

async function adminContext(
	permission: SystemPermission,
	unavailableCode?: "webhook_inbound_unavailable",
) {
	const request = getRequest();
	const user = await requireAdmin(request, permission);
	const env = getCloudflareEnv(request);
	if (!env.DB && unavailableCode)
		throw new DomainError(
			unavailableCode,
			503,
			"Inbound webhook storage is unavailable",
		);
	if (!env.DB) throw new Error("D1 binding DB is unavailable");
	return { db: env.DB, env, request, user };
}
