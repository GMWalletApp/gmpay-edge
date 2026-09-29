import {
	webhookJsonObjectSchema,
	webhookRequestSnapshotSchema,
} from "#/features/webhooks/types";
import { DomainError } from "#/lib/domain-error";
import type { ReadDatabase } from "#/server/read-replica";

export async function loadAdminWebhookDelivery(db: ReadDatabase, id: string) {
	const [deliveryResult, attemptsResult] = await db.batch([
		db
			.prepare(`SELECT d.id, d.status, d.attempt_count, d.next_attempt_at,
			d.completed_at, d.created_at, d.updated_at,
			e.id AS event_id, e.type, e.payload, e.created_at AS event_created_at,
			o.id AS order_id, o.external_order_id, o.notify_url, o.api_protocol,
			k.id AS api_key_id, k.name AS api_key_name, k.pid
			FROM webhook_deliveries d
			JOIN webhook_events e ON e.id = d.event_id
			JOIN orders o ON o.id = d.order_id
			JOIN api_keys k ON k.id = d.api_key_id
			WHERE d.id = ? LIMIT 1`)
			.bind(id),
		db
			.prepare(`SELECT attempt, request_id, response_status, duration_ms,
			error_code, response_excerpt, request_snapshot, attempted_at
			FROM webhook_attempts WHERE delivery_id = ?
			ORDER BY attempt DESC`)
			.bind(id),
	]);
	const delivery = deliveryResult?.results?.[0] as DeliveryRow | undefined;
	if (!delivery)
		throw new DomainError(
			"webhook_delivery_not_found",
			404,
			"Webhook delivery not found",
		);
	const attempts = attemptsResult as D1Result<AttemptRow>;
	return {
		id: delivery.id,
		status: delivery.status,
		attemptCount: delivery.attempt_count,
		protocol: delivery.api_protocol,
		url: delivery.notify_url,
		order: {
			id: delivery.order_id,
			externalOrderId: delivery.external_order_id,
		},
		apiKey: {
			id: delivery.api_key_id,
			name: delivery.api_key_name,
			pid: delivery.pid,
		},
		event: {
			id: delivery.event_id,
			type: delivery.type,
			payload: parseStoredRecord(delivery.payload),
			createdAt: new Date(delivery.event_created_at).toISOString(),
		},
		attempts: attempts.results.map((attempt) => ({
			attempt: attempt.attempt,
			requestId: attempt.request_id,
			responseStatus: attempt.response_status,
			durationMs: attempt.duration_ms,
			errorCode: attempt.error_code,
			responseExcerpt: attempt.response_excerpt,
			requestSnapshot: parseRequestSnapshot(attempt.request_snapshot),
			attemptedAt: new Date(attempt.attempted_at).toISOString(),
		})),
		nextAttemptAt: delivery.next_attempt_at
			? new Date(delivery.next_attempt_at).toISOString()
			: null,
		completedAt: delivery.completed_at
			? new Date(delivery.completed_at).toISOString()
			: null,
		createdAt: new Date(delivery.created_at).toISOString(),
		updatedAt: new Date(delivery.updated_at).toISOString(),
	};
}

interface DeliveryRow {
	id: string;
	status: string;
	attempt_count: number;
	next_attempt_at: number | null;
	completed_at: number | null;
	created_at: number;
	updated_at: number;
	event_id: string;
	type: string;
	payload: string;
	event_created_at: number;
	order_id: string;
	external_order_id: string;
	notify_url: string;
	api_protocol: string | null;
	api_key_id: string;
	api_key_name: string;
	pid: string;
}

interface AttemptRow {
	attempt: number;
	request_id: string;
	response_status: number | null;
	duration_ms: number | null;
	error_code: string | null;
	response_excerpt: string | null;
	request_snapshot: string | null;
	attempted_at: number;
}

function parseStoredRecord(value: string) {
	try {
		const result = webhookJsonObjectSchema.safeParse(JSON.parse(value));
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

function parseRequestSnapshot(value: string | null) {
	if (!value) return null;
	try {
		const result = webhookRequestSnapshotSchema.safeParse(JSON.parse(value));
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}
