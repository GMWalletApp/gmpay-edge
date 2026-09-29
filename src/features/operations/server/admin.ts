import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import {
	type SystemPermission,
	systemPermission,
} from "#/features/access/system-rbac";
import { scheduledTaskCatalog } from "#/features/operations/schedule";
import { exportAuditLogsToR2 } from "#/features/operations/server/audit-export";
import {
	loadDeadQueueMessageCounts,
	retryQueueWorkload,
} from "#/features/operations/server/retry-queue";
import {
	operationsTasks,
	runOperationsTask,
} from "#/features/operations/server/run-task";
import { loadLatestOperationTaskRuns } from "#/features/operations/server/task-runs";
import { loadRateSyncConfiguration } from "#/features/payment-settings/server/exchange-rates";
import { DomainError } from "#/lib/domain-error";
import { redactedAuditJson } from "#/server/audit-redaction";
import { getCloudflareEnv } from "#/server/db.server";
import { requestId } from "#/server/http";
import { loadOperationalSettings } from "#/server/operational-settings";

const auditQuery = z.object({
	page: z.number().int().min(1).default(1),
	pageSize: z.number().int().min(10).max(100).default(25),
	search: z.string().trim().max(100).default(""),
	beforeCreatedAt: z.number().int().positive().optional(),
});

type AuditRow = {
	id: string;
	action: string;
	target_type: string;
	target_id: string | null;
	request_id: string | null;
	ip_address: string | null;
	before: string | null;
	after: string | null;
	created_at: number;
	actor_name: string | null;
	actor_email: string | null;
};

export type AuditLogRecord = {
	id: string;
	action: string;
	targetType: string;
	targetId: string | null;
	requestId: string | null;
	ipAddress: string | null;
	before: string | null;
	after: string | null;
	createdAt: string;
	actorName: string | null;
	actorEmail: string | null;
};

export const listAuditLogsFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof auditQuery>) => auditQuery.parse(input))
	.handler(async ({ data }) => {
		const { db } = await adminContext(systemPermission("audit", "read"));
		const pattern = `%${data.search}%`;
		const filters: string[] = [];
		const bindings: Array<string | number> = [];
		if (data.search) {
			filters.push(
				"(al.action LIKE ? OR al.target_type LIKE ? OR al.target_id LIKE ? OR u.email LIKE ?)",
			);
			bindings.push(pattern, pattern, pattern, pattern);
		}
		if (data.beforeCreatedAt !== undefined) {
			filters.push("al.created_at <= ?");
			bindings.push(data.beforeCreatedAt);
		}
		const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
		const [countResult, rowsResult] = await db.batch([
			db
				.prepare(
					`SELECT COUNT(*) AS count FROM audit_logs al LEFT JOIN users u ON u.id = al.actor_user_id ${where}`,
				)
				.bind(...bindings),
			db
				.prepare(`SELECT al.id, al.action, al.target_type, al.target_id,
			 al.request_id, al.ip_address, al.before, al.after, al.created_at,
			 u.name AS actor_name, u.email AS actor_email
			 FROM audit_logs al LEFT JOIN users u ON u.id = al.actor_user_id
				 ${where}
			 ORDER BY al.created_at DESC, al.id DESC LIMIT ? OFFSET ?`)
				.bind(...bindings, data.pageSize, (data.page - 1) * data.pageSize),
		]);
		const count = countResult?.results?.[0] as { count: number } | undefined;
		const rows = rowsResult as D1Result<AuditRow>;
		return {
			items: rows.results.map((row) => ({
				id: row.id,
				action: row.action,
				targetType: row.target_type,
				targetId: row.target_id,
				requestId: row.request_id,
				ipAddress: row.ip_address,
				before: redactedAuditJson(row.before),
				after: redactedAuditJson(row.after),
				createdAt: new Date(row.created_at).toISOString(),
				actorName: row.actor_name,
				actorEmail: row.actor_email,
			})),
			total: count?.count ?? 0,
			page: data.page,
			pageSize: data.pageSize,
		};
	});

export const exportAuditLogsFn = createServerFn({ method: "POST" }).handler(
	async () => {
		const { db, env, user } = await adminContext(
			systemPermission("audit", "create"),
		);
		if (!env.FILES)
			throw new DomainError(
				"binding_unavailable",
				503,
				"R2 binding FILES is unavailable",
			);
		const settings = await loadOperationalSettings(db);
		return exportAuditLogsToR2({
			db,
			bucket: env.FILES,
			actorUserId: user.id,
			retentionMs: settings.retentionAuditMs,
		});
	},
);

export const getOperationsOverviewFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await adminContext(systemPermission("operations", "read"));
	const [taskRuns, cryptoRates, fiatRates] = await Promise.all([
		loadLatestOperationTaskRuns(
			db,
			scheduledTaskCatalog.map((entry) => entry.task),
		),
		loadRateSyncConfiguration(db, "crypto"),
		loadRateSyncConfiguration(db, "fiat"),
	]);
	return {
		rateIntervals: {
			crypto: cryptoRates.intervalMs,
			fiat: fiatRates.intervalMs,
		},
		taskRuns: taskRuns.map((run) => ({
			invocationId: run.id,
			task: run.task,
			trigger: run.trigger,
			schedule: run.schedule,
			status: run.status,
			startedAt: new Date(run.started_at).toISOString(),
			completedAt: run.completed_at
				? new Date(run.completed_at).toISOString()
				: null,
			durationMs: run.duration_ms,
			errorCode: run.error_code,
		})),
	};
});

export const runOperationsTaskFn = createServerFn({ method: "POST" })
	.validator((input: { task: (typeof operationsTasks)[number] }) =>
		z.object({ task: z.enum(operationsTasks) }).parse(input),
	)
	.handler(async ({ data }) => {
		const { env, request, user } = await adminContext(
			systemPermission("operations", "update"),
		);
		return runOperationsTask(env as Env, {
			task: data.task,
			actorUserId: user.id,
			requestId: requestId(request),
			ipAddress: request.headers.get("cf-connecting-ip"),
		});
	});

export const getQueueOverviewFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db, env } = await adminContext(
			systemPermission("operations", "read"),
		);
		const [webhooks, payments, rejectedMessages, dispatchRuns, deadMessages] =
			await Promise.all([
				// Reads only the non-terminal partial index.
				db
					.prepare(
						`SELECT COALESCE(SUM(status = 'queued'), 0) AS queued,
						 COALESCE(SUM(status = 'delivering'), 0) AS delivering,
						 COALESCE(SUM(status = 'failed'), 0) AS failed
						 FROM webhook_deliveries WHERE status IN ('queued', 'failed', 'delivering')`,
					)
					.first<{ queued: number; delivering: number; failed: number }>(),
				db
					.prepare(
						`SELECT COUNT(*) AS count, MAX(last_payment_scan_at) AS last_scan FROM orders WHERE status IN ('pending', 'partially_paid')`,
					)
					.first<{ count: number; last_scan: number | null }>(),
				db
					.prepare(
						`SELECT target_id, after, created_at FROM audit_logs
						 WHERE action = 'queue.message_rejected' AND created_at >= ?
						 ORDER BY created_at DESC LIMIT 20`,
					)
					.bind(Date.now() - 86_400_000)
					.all<{
						target_id: string | null;
						after: string | null;
						created_at: number;
					}>(),
				loadLatestOperationTaskRuns(db, [
					"webhook_outbox",
					"payment_scan_enqueue",
				]),
				loadDeadQueueMessageCounts(db),
			]);
		const recentErrors = [
			...rejectedMessages.results,
			...dispatchRuns
				.filter((run) => run.status === "failed")
				.map((run) => ({
					target_id: run.task,
					after: JSON.stringify({ code: run.error_code ?? "task_failed" }),
					created_at: run.completed_at ?? run.started_at,
				})),
		].sort((left, right) => right.created_at - left.created_at);
		const paymentError = recentErrors.find((row) =>
			row.target_id?.includes("payment"),
		);
		const webhookError = recentErrors.find((row) =>
			row.target_id?.includes("webhook"),
		);
		return [
			{
				id: "payment",
				name: "Payment Scan Queue",
				available: Boolean(env.PAYMENT_QUEUE),
				pending: payments?.count ?? 0,
				processing: 0,
				failed: paymentError ? 1 : 0,
				dead: deadMessages?.get("gmpay-edge-payments") ?? null,
				lastConsumedAt: payments?.last_scan
					? new Date(payments.last_scan).toISOString()
					: null,
				lastError: redactedAuditJson(paymentError?.after ?? null),
			},
			{
				id: "webhook",
				name: "Webhook Queue",
				available: Boolean(env.WEBHOOK_QUEUE),
				pending: webhooks?.queued ?? 0,
				processing: webhooks?.delivering ?? 0,
				failed: Math.max(webhooks?.failed ?? 0, webhookError ? 1 : 0),
				dead: deadMessages?.get("gmpay-edge-webhooks") ?? null,
				lastConsumedAt: null,
				lastError: redactedAuditJson(webhookError?.after ?? null),
			},
		];
	},
);

export const retryQueueFn = createServerFn({ method: "POST" })
	.validator((input: { queue: "payment" | "webhook" }) =>
		z.object({ queue: z.enum(["payment", "webhook"]) }).parse(input),
	)
	.handler(async ({ data }) => {
		const { env, request, user } = await adminContext(
			systemPermission("operations", "update"),
		);
		return retryQueueWorkload(env as Env, data.queue, {
			actorUserId: user.id,
			requestId: requestId(request),
			ipAddress: request.headers.get("cf-connecting-ip"),
		});
	});

async function adminContext(permission: SystemPermission) {
	const request = getRequest();
	const user = await requireAdmin(request, permission);
	const env = getCloudflareEnv(request);
	if (!env.DB)
		throw new DomainError(
			"binding_unavailable",
			503,
			"D1 binding DB is unavailable",
		);
	return { db: env.DB, env, request, user };
}
