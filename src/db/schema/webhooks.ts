import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ProviderPaymentTrigger } from "#/features/payments/types";
import type { WebhookRequestSnapshot } from "#/features/webhooks/types";
import { timestamps } from "./common";
import { apiKeys, orders, paymentIngresses } from "./payments";

export const inboundWebhookReceipts = sqliteTable(
	"inbound_webhook_receipts",
	{
		id: text("id").primaryKey(),
		endpointCode: text("endpoint_code").notNull(),
		requestId: text("request_id").notNull(),
		externalRequestId: text("external_request_id"),
		method: text("method").notNull(),
		requestPath: text("request_path").notNull(),
		signatureStatus: text("signature_status", {
			enum: ["valid", "invalid", "not_applicable", "unknown"],
		}).notNull(),
		processingStatus: text("processing_status", {
			enum: ["succeeded", "rejected", "failed"],
		}).notNull(),
		responseStatus: integer("response_status").notNull(),
		durationMs: integer("duration_ms").notNull(),
		errorCode: text("error_code"),
		receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		uniqueIndex("inbound_webhook_receipts_request_uidx").on(
			table.endpointCode,
			table.requestId,
		),
		index("inbound_webhook_receipts_list_idx").on(
			table.endpointCode,
			table.receivedAt,
			table.id,
		),
		index("inbound_webhook_receipts_external_request_idx").on(
			table.endpointCode,
			table.externalRequestId,
			table.receivedAt,
		),
		index("inbound_webhook_receipts_retention_idx").on(
			table.receivedAt,
			table.id,
		),
	],
);

export const inboundProviderDeliveries = sqliteTable(
	"inbound_provider_deliveries",
	{
		id: text("id").primaryKey(),
		sourceId: text("source_id")
			.notNull()
			.references(() => paymentIngresses.id, { onDelete: "cascade" }),
		providerEventId: text("provider_event_id").notNull(),
		payloadHash: text("payload_hash").notNull(),
		acceptedActivityCount: integer("accepted_activity_count").notNull(),
		invalidActivityCount: integer("invalid_activity_count").notNull(),
		providerCreatedAt: integer("provider_created_at", { mode: "timestamp_ms" }),
		receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
		changedAt: integer("changed_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("inbound_provider_deliveries_identity_uidx").on(
			table.sourceId,
			table.providerEventId,
		),
		index("inbound_provider_deliveries_retention_idx").on(
			table.receivedAt,
			table.id,
		),
	],
);

export const inboundProviderEvents = sqliteTable(
	"inbound_provider_events",
	{
		id: text("id").primaryKey(),
		sourceId: text("source_id")
			.notNull()
			.references(() => paymentIngresses.id, { onDelete: "cascade" }),
		providerEventId: text("provider_event_id").notNull(),
		activityIndex: integer("activity_index").notNull(),
		network: text("network").notNull(),
		eventType: text("event_type").notNull(),
		transactionHash: text("transaction_hash").notNull(),
		eventIndex: integer("event_index").notNull(),
		payloadHash: text("payload_hash").notNull(),
		trigger: text("trigger", { mode: "json" })
			.$type<ProviderPaymentTrigger>()
			.notNull(),
		ingestMode: text("ingest_mode", { enum: ["shadow", "active"] })
			.notNull()
			.default("shadow"),
		status: text("status", {
			enum: [
				"received",
				"queued",
				"processing",
				"succeeded",
				"ignored",
				"ambiguous",
				"failed",
				"dead",
			],
		})
			.notNull()
			.default("received"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
		leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
		lastErrorCode: text("last_error_code"),
		receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
		queuedAt: integer("queued_at", { mode: "timestamp_ms" }),
		processedAt: integer("processed_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("inbound_provider_events_delivery_uidx").on(
			table.sourceId,
			table.providerEventId,
			table.activityIndex,
		),
		index("inbound_provider_events_outbox_idx").on(
			table.status,
			table.nextAttemptAt,
			table.receivedAt,
			table.id,
		),
		index("inbound_provider_events_lease_idx").on(
			table.status,
			table.leaseUntil,
			table.id,
		),
		index("inbound_provider_events_source_received_idx").on(
			table.sourceId,
			table.receivedAt,
			table.id,
		),
		index("inbound_provider_events_received_idx").on(
			table.receivedAt,
			table.id,
		),
		index("inbound_provider_events_retention_idx")
			.on(table.processedAt, table.id)
			.where(
				sql`${table.status} IN ('succeeded', 'ignored', 'ambiguous', 'dead')`,
			),
	],
);

export const webhookEvents = sqliteTable(
	"webhook_events",
	{
		id: text("id").primaryKey(),
		orderId: text("order_id").references(() => orders.id),
		type: text("type").notNull(),
		deduplicationKey: text("deduplication_key").notNull().unique(),
		payload: text("payload", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull(),
		...timestamps,
	},
	(table) => [
		index("webhook_events_retention_idx").on(table.createdAt, table.id),
	],
);

export const webhookDeliveries = sqliteTable(
	"webhook_deliveries",
	{
		id: text("id").primaryKey(),
		eventId: text("event_id")
			.notNull()
			.references(() => webhookEvents.id),
		orderId: text("order_id")
			.notNull()
			.references(() => orders.id),
		apiKeyId: text("api_key_id")
			.notNull()
			.references(() => apiKeys.id),
		status: text("status", {
			enum: ["queued", "delivering", "succeeded", "failed", "dead"],
		})
			.notNull()
			.default("queued"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
		completedAt: integer("completed_at", { mode: "timestamp_ms" }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("webhook_deliveries_event_order_uidx").on(
			table.eventId,
			table.orderId,
		),
		index("webhook_deliveries_created_idx").on(table.createdAt, table.id),
		index("webhook_deliveries_retention_idx")
			.on(table.completedAt, table.id)
			.where(sql`${table.status} IN ('succeeded', 'dead')`),
		index("webhook_deliveries_outbox_idx")
			.on(table.createdAt, table.id)
			.where(
				sql`(${table.status} = 'queued' AND ${table.attemptCount} = 0)
					OR (${table.status} = 'failed' AND ${table.attemptCount} > 0)`,
			),
	],
);

export const webhookAttempts = sqliteTable(
	"webhook_attempts",
	{
		id: text("id").primaryKey(),
		deliveryId: text("delivery_id")
			.notNull()
			.references(() => webhookDeliveries.id),
		attempt: integer("attempt").notNull(),
		requestId: text("request_id").notNull(),
		responseStatus: integer("response_status"),
		durationMs: integer("duration_ms"),
		errorCode: text("error_code"),
		responseExcerpt: text("response_excerpt"),
		requestSnapshot: text("request_snapshot", {
			mode: "json",
		}).$type<WebhookRequestSnapshot>(),
		attemptedAt: integer("attempted_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		uniqueIndex("webhook_attempts_delivery_attempt_uidx").on(
			table.deliveryId,
			table.attempt,
		),
		index("webhook_attempts_retention_idx").on(table.attemptedAt, table.id),
	],
);
