import { z } from "zod";
import { enqueueProviderEventIds } from "#/features/payments/server/provider-event-outbox";
import { DomainError } from "#/lib/domain-error";

const providerEventStatusSchema = z.enum([
	"received",
	"queued",
	"processing",
	"succeeded",
	"ignored",
	"ambiguous",
	"failed",
	"dead",
]);

export const providerEventListSchema = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(100).default(10),
	search: z.string().trim().max(128).default(""),
	sourceId: z.uuid().optional(),
	status: providerEventStatusSchema.optional(),
});

export async function loadPaymentProviderEventPage(
	db: D1Database,
	input: z.infer<typeof providerEventListSchema>,
) {
	const filters: string[] = [];
	const parameters: Array<string | number> = [];
	if (input.sourceId) {
		filters.push("event.source_id = ?");
		parameters.push(input.sourceId);
	}
	if (input.status) {
		filters.push("event.status = ?");
		parameters.push(input.status);
	}
	if (input.search) {
		filters.push(
			"(event.transaction_hash LIKE ? OR event.provider_event_id LIKE ?)",
		);
		const search = `%${input.search}%`;
		parameters.push(search, search);
	}
	const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
	const index = input.sourceId
		? "inbound_provider_events_source_received_idx"
		: "inbound_provider_events_received_idx";
	const [countResult, rowsResult] = await db.batch([
		db
			.prepare(
				`SELECT COUNT(*) AS total FROM inbound_provider_events event ${where}`,
			)
			.bind(...parameters),
		db
			.prepare(
				`SELECT event.id, event.source_id, event.provider_event_id,
				 event.activity_index, event.transaction_hash, event.event_index,
				 event.ingest_mode, event.status, event.attempt_count,
				 event.last_error_code, event.received_at, event.processed_at,
				 source.provider, source.network
				 FROM inbound_provider_events event INDEXED BY ${index}
				 JOIN payment_ingresses source ON source.id = event.source_id
				 ${where}
				 ORDER BY event.received_at DESC, event.id DESC LIMIT ? OFFSET ?`,
			)
			.bind(...parameters, input.pageSize, input.pageIndex * input.pageSize),
	]);
	const count = countResult?.results?.[0] as { total: number } | undefined;
	const rows = rowsResult as D1Result<{
		id: string;
		source_id: string;
		provider_event_id: string;
		activity_index: number;
		transaction_hash: string;
		event_index: number;
		ingest_mode: "shadow" | "active";
		status: z.infer<typeof providerEventStatusSchema>;
		attempt_count: number;
		last_error_code: string | null;
		received_at: number;
		processed_at: number | null;
		provider: string;
		network: string;
	}>;
	return {
		items: rows.results.map((row) => ({
			id: row.id,
			sourceId: row.source_id,
			provider: row.provider,
			network: row.network,
			providerEventId: row.provider_event_id,
			activityIndex: row.activity_index,
			transactionHash: row.transaction_hash,
			eventIndex: row.event_index,
			ingestMode: row.ingest_mode,
			status: row.status,
			attemptCount: row.attempt_count,
			lastErrorCode: row.last_error_code,
			retryable: isProviderEventManuallyRetryable(
				row.status,
				row.last_error_code,
			),
			receivedAt: new Date(row.received_at).toISOString(),
			processedAt: row.processed_at
				? new Date(row.processed_at).toISOString()
				: null,
		})),
		total: count?.total ?? 0,
		pageIndex: input.pageIndex,
		pageSize: input.pageSize,
	};
}

export async function retryPaymentProviderEvent(
	env: { DB: D1Database; PAYMENT_QUEUE: Queue },
	eventId: string,
	now = Date.now(),
	audit?: {
		actorUserId: string | null;
		requestId: string | null;
		ipAddress: string | null;
	},
) {
	const event = await env.DB.prepare(
		`SELECT status, last_error_code FROM inbound_provider_events
		 WHERE id = ? LIMIT 1`,
	)
		.bind(eventId)
		.first<{
			status: z.infer<typeof providerEventStatusSchema>;
			last_error_code: string | null;
		}>();
	if (!event)
		throw new DomainError(
			"payment_provider_event_not_found",
			404,
			"Payment provider event not found",
		);
	if (!isProviderEventManuallyRetryable(event.status, event.last_error_code))
		throw new DomainError(
			"payment_provider_event_not_retryable",
			409,
			"Payment provider event is not retryable",
		);
	const [claim] = await env.DB.batch([
		env.DB.prepare(
			`UPDATE inbound_provider_events SET status = 'received', attempt_count = 0,
			 next_attempt_at = NULL, lease_until = NULL, last_error_code = NULL,
			 processed_at = NULL, queued_at = NULL, updated_at = ?
			 WHERE id = ? AND status = ?`,
		).bind(now, eventId, event.status),
		...(audit
			? [
					env.DB.prepare(
						`INSERT INTO audit_logs
						 (id, actor_user_id, action, target_type, target_id, request_id,
						  ip_address, after, created_at)
						 SELECT ?, ?, 'payment_provider_event.retry_requested',
						  'payment_provider_event', ?, ?, ?, ?, ? WHERE changes() = 1`,
					).bind(
						crypto.randomUUID(),
						audit.actorUserId,
						eventId,
						audit.requestId,
						audit.ipAddress,
						JSON.stringify({ status: "received" }),
						now,
					),
				]
			: []),
	]);
	if ((claim?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"payment_provider_event_retry_in_progress",
			409,
			"Payment provider event retry is already in progress",
		);
	const queued = await enqueueProviderEventIds(env, [eventId], now);
	return {
		id: eventId,
		status: queued.queued === 1 ? ("queued" as const) : ("received" as const),
	};
}

function isProviderEventManuallyRetryable(
	status: z.infer<typeof providerEventStatusSchema>,
	lastErrorCode: string | null,
) {
	if (status === "failed" || status === "dead" || status === "ambiguous")
		return true;
	return (
		status === "ignored" &&
		(lastErrorCode === "no_payment_candidate" ||
			lastErrorCode === "transaction_not_found" ||
			lastErrorCode === "webhook_rpc_mismatch" ||
			lastErrorCode === "reorg_hint")
	);
}
