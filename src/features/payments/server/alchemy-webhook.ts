import { z } from "zod";
import { enqueueProviderEventIds } from "#/features/payments/server/provider-event-outbox";
import type { ProviderPaymentTrigger } from "#/features/payments/types";
import { recordInboundWebhookReceipt } from "#/features/webhooks/server/inbound-receipts";
import {
	alchemyEventSourceConfigSchema,
	parseAlchemyAddressActivity,
	verifyAlchemyWebhookSignature,
} from "#/integrations/chains/alchemy-webhook";
import { sha256Hex } from "#/lib/crypto";
import { decryptSecret } from "#/lib/secrets";
import { json, withRequestId } from "#/server/http";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import {
	RequestBodyTooLargeError,
	readLimitedRequestBytes,
} from "#/server/request-body";
import { loadRuntimeConfig } from "#/server/runtime-config";

const sourceIdSchema = z.uuid();
const maximumBodyBytes = 2 * 1024 * 1024;
const maximumDeliveriesPerMinute = 600;
const activityWriteBatchSize = 100;
const signatureSchema = z.string().regex(/^[0-9a-f]{64}$/i);
const decoder = new TextDecoder("utf-8", { fatal: true });

type AlchemySource = {
	external_source_id: string;
	external_network: string;
	network: string;
	config_encrypted: string;
	mode: "shadow" | "active";
	enabled: number;
};

export async function handleAlchemyAddressActivity(
	request: Request,
	sourceIdInput: string,
	env: { DB: D1Database; PAYMENT_QUEUE?: Queue },
) {
	const startedAt = Date.now();
	const finish = async (
		response: Response,
		signatureStatus: "valid" | "invalid" | "unknown",
		errorCode?: string,
	) => {
		await recordInboundWebhookReceipt(env.DB, {
			endpointCode: "alchemy.address_activity",
			request,
			startedAt,
			responseStatus: response.status,
			signatureStatus,
			...(errorCode ? { errorCode } : {}),
		});
		return response;
	};
	const sourceId = sourceIdSchema.safeParse(sourceIdInput);
	if (!sourceId.success)
		return finish(errorResponse(request, "source_not_found", 404), "unknown");
	if (!request.headers.get("content-type")?.includes("application/json"))
		return finish(
			errorResponse(request, "unsupported_content_type", 415),
			"unknown",
			"unsupported_content_type",
		);
	const contentEncoding = request.headers.get("content-encoding");
	if (contentEncoding && contentEncoding !== "identity")
		return finish(
			errorResponse(request, "unsupported_content_encoding", 415),
			"unknown",
			"unsupported_content_encoding",
		);
	const source = await loadSource(env.DB, sourceId.data);
	if (!source)
		return finish(errorResponse(request, "source_not_found", 404), "unknown");
	let rawBody: string;
	try {
		const bytes = await readLimitedRequestBytes(request, maximumBodyBytes);
		rawBody = decoder.decode(bytes);
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError)
			return finish(
				errorResponse(request, "payload_too_large", 413),
				"unknown",
				"payload_too_large",
			);
		return finish(
			errorResponse(request, "invalid_payload", 400),
			"unknown",
			"invalid_payload",
		);
	}

	const suppliedSignature = signatureSchema.safeParse(
		request.headers.get("x-alchemy-signature"),
	);
	if (!suppliedSignature.success)
		return finish(
			errorResponse(request, "invalid_signature", 401),
			"invalid",
			"invalid_signature",
		);
	let config: z.infer<typeof alchemyEventSourceConfigSchema>;
	try {
		const runtime = await loadRuntimeConfig(env.DB);
		config = alchemyEventSourceConfigSchema.parse(
			JSON.parse(
				await decryptSecret(
					source.config_encrypted,
					runtime.integrationConfigSecret,
				),
			),
		);
	} catch {
		return finish(
			errorResponse(request, "source_configuration_unavailable", 503),
			"unknown",
			"source_configuration_unavailable",
		);
	}
	if (
		!(await verifyAlchemyWebhookSignature(
			rawBody,
			suppliedSignature.data,
			config,
		))
	)
		return finish(
			errorResponse(request, "invalid_signature", 401),
			"invalid",
			"invalid_signature",
		);
	const rate = await claimFixedWindowRateLimit(env.DB, {
		bucketKey: `provider:alchemy:${sourceId.data}`,
		limit: maximumDeliveriesPerMinute,
		windowMs: 60_000,
	});
	if (!rate.allowed)
		return finish(
			errorResponse(request, "rate_limited", 429),
			"valid",
			"rate_limited",
		);

	const now = Date.now();
	let payload: ReturnType<typeof parseAlchemyAddressActivity>;
	try {
		payload = parseAlchemyAddressActivity(JSON.parse(rawBody));
	} catch {
		await markSourceError(
			env.DB,
			sourceId.data,
			"provider_payload_invalid",
			now,
		);
		return finish(
			errorResponse(request, "invalid_payload", 400),
			"valid",
			"invalid_payload",
		);
	}
	if (
		payload.externalSourceId !== source.external_source_id ||
		(payload.externalNetwork !== null &&
			payload.externalNetwork !== source.external_network)
	) {
		await markSourceError(
			env.DB,
			sourceId.data,
			"provider_source_mismatch",
			now,
		);
		return finish(
			errorResponse(request, "source_mismatch", 400),
			"valid",
			"source_mismatch",
		);
	}
	if (!source.enabled)
		return finish(
			withRequestId(request, json({ accepted: 0, queued: 0 })),
			"valid",
			"source_disabled",
		);

	const payloadHash = await sha256Hex(rawBody);
	if (
		!(await claimDeliveryIdentity(env.DB, {
			id: crypto.randomUUID(),
			sourceId: sourceId.data,
			providerEventId: payload.providerEventId,
			payloadHash,
			acceptedActivityCount: payload.activities.length,
			invalidActivityCount: payload.invalidActivityCount,
			providerCreatedAt: Date.parse(payload.createdAt),
			now,
		}))
	) {
		await env.DB.batch([
			env.DB.prepare(
				`UPDATE inbound_provider_deliveries SET changed_at = COALESCE(changed_at, ?),
				 updated_at = ? WHERE source_id = ? AND provider_event_id = ?`,
			).bind(now, now, sourceId.data, payload.providerEventId),
			env.DB.prepare(
				`UPDATE payment_ingresses SET health_status = 'degraded',
				 last_error_code = 'provider_event_changed', updated_at = ? WHERE id = ?`,
			).bind(now, sourceId.data),
		]);
		return finish(
			withRequestId(request, json({ accepted: 0, queued: 0 })),
			"valid",
			"provider_event_changed",
		);
	}
	if (payload.providerErrorCode) {
		await markSourceError(
			env.DB,
			sourceId.data,
			payload.providerErrorCode,
			now,
		);
		return finish(
			withRequestId(request, json({ accepted: 0, queued: 0 })),
			"valid",
			payload.providerErrorCode,
		);
	}
	await persistEvents(
		env.DB,
		sourceId.data,
		payload.providerEventId,
		payloadHash,
		payload.activities,
		source.network,
		source.mode,
		payload.invalidActivityCount,
		now,
	);
	const deliveryEvents = await loadDeliveryEvents(
		env.DB,
		sourceId.data,
		payload.providerEventId,
	);
	const eligibleEventIds = deliveryEvents
		.filter(
			(event) =>
				(event.status === "received" || event.status === "failed") &&
				(event.next_attempt_at === null || event.next_attempt_at <= now),
		)
		.map((event) => event.id);
	const delivery = await enqueueProviderEventIds(env, eligibleEventIds, now);
	let outcome = "deduplicated_or_in_flight";
	if (delivery.failed > 0) outcome = "queue_deferred";
	else if (eligibleEventIds.length) outcome = "accepted";
	console.info(
		JSON.stringify({
			event: "payment_provider_webhook_ingested",
			provider: "alchemy",
			sourceId: sourceId.data,
			mode: source.mode,
			acceptedActivities: payload.activities.length,
			invalidActivities: payload.invalidActivityCount,
			eligibleEvents: eligibleEventIds.length,
			queuedEvents: delivery.queued,
			queueFailedEvents: delivery.failed,
			deliveryDelayMs: Math.max(0, now - Date.parse(payload.createdAt)),
			outcome,
		}),
	);
	return finish(
		withRequestId(
			request,
			json({ accepted: payload.activities.length, queued: delivery.queued }),
		),
		"valid",
	);
}

async function claimDeliveryIdentity(
	db: D1Database,
	input: {
		id: string;
		sourceId: string;
		providerEventId: string;
		payloadHash: string;
		acceptedActivityCount: number;
		invalidActivityCount: number;
		providerCreatedAt: number;
		now: number;
	},
) {
	const row = await db
		.prepare(
			`INSERT INTO inbound_provider_deliveries
			 (id, source_id, provider_event_id, payload_hash, accepted_activity_count,
			  invalid_activity_count, provider_created_at, received_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(source_id, provider_event_id) DO UPDATE SET
			  updated_at = inbound_provider_deliveries.updated_at
			 WHERE inbound_provider_deliveries.payload_hash = excluded.payload_hash
			 RETURNING payload_hash`,
		)
		.bind(
			input.id,
			input.sourceId,
			input.providerEventId,
			input.payloadHash,
			input.acceptedActivityCount,
			input.invalidActivityCount,
			input.providerCreatedAt,
			input.now,
			input.now,
			input.now,
		)
		.first<{ payload_hash: string }>();
	return row?.payload_hash === input.payloadHash;
}

async function loadSource(db: D1Database, sourceId: string) {
	return db
		.prepare(
			`SELECT external_source_id, external_network, network, config_encrypted, mode, enabled
			 FROM payment_ingresses
			 WHERE id = ? AND type = 'provider_webhook'
			 AND provider = 'alchemy' LIMIT 1`,
		)
		.bind(sourceId)
		.first<AlchemySource>();
}

async function persistEvents(
	db: D1Database,
	sourceId: string,
	providerEventId: string,
	payloadHash: string,
	activities: ReadonlyArray<{
		activityIndex: number;
		trigger: ProviderPaymentTrigger;
	}>,
	network: string,
	ingestMode: "shadow" | "active",
	invalidActivityCount: number,
	now: number,
) {
	const persistedActivities = activities.map(({ activityIndex, trigger }) => ({
		id: crypto.randomUUID(),
		activityIndex,
		transactionHash: trigger.transactionHash,
		eventIndex: trigger.eventIndex,
		trigger,
	}));
	const statements: D1PreparedStatement[] = [];
	for (
		let offset = 0;
		offset < persistedActivities.length;
		offset += activityWriteBatchSize
	)
		statements.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO inbound_provider_events
				 (id, source_id, provider_event_id, activity_index, network,
				  event_type, transaction_hash, event_index, payload_hash, trigger,
				  ingest_mode, status, received_at, created_at, updated_at)
				 SELECT json_extract(activity.value, '$.id'), ?, ?,
				  CAST(json_extract(activity.value, '$.activityIndex') AS INTEGER), ?,
				  'address_activity', json_extract(activity.value, '$.transactionHash'),
				  CAST(json_extract(activity.value, '$.eventIndex') AS INTEGER), ?,
				  json_extract(activity.value, '$.trigger'), ?, 'received', ?, ?, ?
				 FROM json_each(?) activity`,
				)
				.bind(
					sourceId,
					providerEventId,
					network,
					payloadHash,
					ingestMode,
					now,
					now,
					now,
					JSON.stringify(
						persistedActivities.slice(offset, offset + activityWriteBatchSize),
					),
				),
		);
	statements.push(
		db
			.prepare(
				`UPDATE payment_ingresses SET last_event_at = ?,
				 health_status = CASE WHEN ? > 0 THEN 'degraded' ELSE health_status END,
				 last_error_code = CASE WHEN ? > 0 THEN 'provider_activity_invalid'
				  ELSE last_error_code END,
				 updated_at = ? WHERE id = ?`,
			)
			.bind(now, invalidActivityCount, invalidActivityCount, now, sourceId),
	);
	await db.batch(statements);
}

async function loadDeliveryEvents(
	db: D1Database,
	sourceId: string,
	providerEventId: string,
) {
	const rows = await db
		.prepare(
			`SELECT id, payload_hash, status, next_attempt_at
			 FROM inbound_provider_events
			 WHERE source_id = ? AND provider_event_id = ?
			 ORDER BY activity_index LIMIT 100`,
		)
		.bind(sourceId, providerEventId)
		.all<{
			id: string;
			payload_hash: string;
			status: string;
			next_attempt_at: number | null;
		}>();
	return rows.results;
}

async function markSourceError(
	db: D1Database,
	sourceId: string,
	errorCode: string,
	now: number,
) {
	await db
		.prepare(
			`UPDATE payment_ingresses SET health_status = 'degraded',
			 last_error_code = ?, updated_at = ? WHERE id = ?`,
		)
		.bind(errorCode, now, sourceId)
		.run();
}

function errorResponse(request: Request, error: string, status: number) {
	return withRequestId(request, json({ error }, { status }));
}
