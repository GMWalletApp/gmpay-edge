import type { PaymentScanMessage } from "#/features/payments/types";
import {
	assertWebhookOutboxRecovered,
	recoverWebhookOutbox,
} from "#/features/webhooks/server/outbox";
import { DomainError } from "#/lib/domain-error";
import type { ReadDatabase } from "#/server/read-replica";

/**
 * Dead-lettered messages of the Bun durable queue by queue name. Cloudflare
 * dead letters live in the DLQ outside D1, so the count is unavailable there.
 */
export async function loadDeadQueueMessageCounts(db: ReadDatabase) {
	const table = await db
		.prepare(
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'node_queue_messages' LIMIT 1",
		)
		.first<{ present: number }>();
	if (!table) return null;
	const rows = await db
		.prepare(
			"SELECT queue, COUNT(*) AS count FROM node_queue_messages WHERE status = 'dead' GROUP BY queue",
		)
		.all<{ queue: string; count: number }>();
	return new Map(rows.results.map((row) => [row.queue, row.count]));
}

export async function retryQueueWorkload(
	env: Env,
	queue: "payment" | "webhook",
	context: {
		actorUserId: string;
		requestId?: string | null;
		ipAddress?: string | null;
		now?: number;
	},
) {
	const now = context.now ?? Date.now();
	let result: { queued: number; failed?: number };
	if (queue === "webhook") {
		if (!env.WEBHOOK_QUEUE)
			throw new DomainError(
				"binding_unavailable",
				503,
				"Webhook Queue binding is unavailable",
			);
		result = await recoverWebhookOutbox(env, now);
	} else {
		if (!env.PAYMENT_QUEUE)
			throw new DomainError(
				"binding_unavailable",
				503,
				"Payment Queue binding is unavailable",
			);
		const rows = await env.DB.prepare(
			`SELECT orders.id, snapshot.receiving_method_id
				 FROM orders
				 CROSS JOIN order_payment_snapshots snapshot ON snapshot.order_id = orders.id
				 WHERE orders.status IN ('pending', 'confirming', 'partially_paid')
				 ORDER BY orders.last_payment_scan_at, orders.created_at, orders.id
				 LIMIT 50`,
		).all<{ id: string; receiving_method_id: string }>();
		if (rows.results.length) {
			try {
				await env.PAYMENT_QUEUE.sendBatch(
					rows.results.map((order) => ({
						body: {
							kind: "payment.scan",
							version: 1,
							orderId: order.id,
							receivingMethodId: order.receiving_method_id,
						} satisfies PaymentScanMessage,
					})),
				);
			} catch {
				throw new DomainError(
					"queue_enqueue_failed",
					502,
					"Payment Queue rejected the retry batch",
				);
			}
		}
		result = { queued: rows.results.length };
	}
	await env.DB.prepare(
		`INSERT INTO audit_logs
		 (id, actor_user_id, action, target_type, target_id, request_id,
		  ip_address, after, created_at)
		 VALUES (?, ?, 'queue.manual_retry', 'queue', ?, ?, ?, ?, ?)`,
	)
		.bind(
			crypto.randomUUID(),
			context.actorUserId,
			queue,
			context.requestId ?? null,
			context.ipAddress ?? null,
			JSON.stringify({ queued: result.queued, failed: result.failed ?? 0 }),
			now,
		)
		.run();
	if (queue === "webhook")
		assertWebhookOutboxRecovered({
			queued: result.queued,
			failed: result.failed ?? 0,
		});
	return result;
}
