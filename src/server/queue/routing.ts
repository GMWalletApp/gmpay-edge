import type { createReceivingMethodAdapters } from "#/features/payment-settings/server/method-adapter";
import type {
	PaymentEventSourceReconcileMessage,
	PaymentProviderEventMessage,
	PaymentQueueMessage,
	PaymentRateSyncMessage,
	PaymentRpcHealthMessage,
	PaymentScanMessage,
} from "#/features/payments/types";
import { processWebhookMessage } from "#/features/webhooks/server/consumer";
import type { WebhookQueueMessage } from "#/features/webhooks/types";
import { isRecord } from "#/lib/is-record";
import { loadOperationalSettings } from "#/server/operational-settings";
import { handlePaymentMaintenance } from "#/server/queue/payment-maintenance";
import { handlePaymentProviderEvent } from "#/server/queue/payment-provider-event";
import { handlePaymentScan } from "#/server/queue/payment-scan";
import { loadRuntimeConfig } from "#/server/runtime-config";

export async function handleQueue(
	batch: MessageBatch<WebhookQueueMessage | PaymentQueueMessage>,
	env: Env,
): Promise<void> {
	const invocationId = crypto.randomUUID();
	const startedAt = Date.now();
	const messages = mergeDuplicatePaymentScans(batch.messages);
	const concurrency = queueProcessingConcurrency(batch.queue);
	const trackedMessages = messages.map(trackQueueMessage);
	let failedMessages = 0;
	try {
		const kinds = messages.map((message) => queueMessageKind(message.body));
		const expectedKind = queueExpectedMessageKind(batch.queue);
		const settings =
			expectedKind === "webhook" && kinds.includes("webhook")
				? loadOperationalSettings(env.DB)
				: Promise.resolve(undefined);
		const runtime =
			expectedKind && kinds.includes(expectedKind)
				? loadRuntimeConfig(env.DB)
				: Promise.resolve(undefined);
		const adapterCache = new Map<
			string,
			ReturnType<typeof createReceivingMethodAdapters>
		>();
		for (let index = 0; index < trackedMessages.length; index += concurrency) {
			await Promise.all(
				trackedMessages
					.slice(index, index + concurrency)
					.map(async ({ message, disposition }) => {
						try {
							await processQueueMessage(message, env, {
								settings,
								runtime,
								adapterCache,
								expectedKind,
							});
						} catch (error) {
							failedMessages += 1;
							console.error(
								JSON.stringify({
									event: "queue_message_failed",
									invocationId,
									queue: batch.queue,
									messageId: message.id,
									kind: queueMessageKind(message.body),
									errorName:
										error instanceof Error ? error.name : "UnknownError",
								}),
							);
							if (disposition.value === "pending") message.retry();
						}
					}),
			);
		}
	} finally {
		const completedAt = Date.now();
		const ackedMessages = trackedMessages.filter(
			({ disposition }) => disposition.value === "ack",
		).length;
		const retriedMessages = trackedMessages.filter(
			({ disposition }) => disposition.value === "retry",
		).length;
		const oldestTimestamp = batch.messages.length
			? Math.min(
					...batch.messages.map((message) => message.timestamp.getTime()),
				)
			: startedAt;
		console.info(
			JSON.stringify({
				event: "queue_invocation_completed",
				invocationId,
				queue: batch.queue,
				batchSize: batch.messages.length,
				processedMessages: messages.length,
				dedupeCount: batch.messages.length - messages.length,
				maxBusinessConcurrency: concurrency,
				oldestMessageAgeMs: Math.max(0, startedAt - oldestTimestamp),
				maxAttempts: Math.max(
					0,
					...batch.messages.map((message) => message.attempts),
				),
				ackedMessages,
				retriedMessages,
				failedMessages,
				retryReason: failedMessages ? "consumer_error" : null,
				startedAt,
				completedAt,
				durationMs: Math.max(0, completedAt - startedAt),
				outcome: failedMessages ? "partial_failure" : "ok",
			}),
		);
	}
}

function trackQueueMessage(
	message: Message<WebhookQueueMessage | PaymentQueueMessage>,
) {
	const disposition: { value: "pending" | "ack" | "retry" } = {
		value: "pending",
	};
	return {
		disposition,
		message: {
			id: message.id,
			timestamp: message.timestamp,
			attempts: message.attempts,
			body: message.body,
			ack: () => {
				disposition.value = "ack";
				message.ack();
			},
			retry: (
				options?: Parameters<
					Message<WebhookQueueMessage | PaymentQueueMessage>["retry"]
				>[0],
			) => {
				disposition.value = "retry";
				message.retry(options);
			},
		} satisfies Message<WebhookQueueMessage | PaymentQueueMessage>,
	};
}

function queueProcessingConcurrency(queue: string) {
	if (queue === "gmpay-edge-payments") return 2;
	if (queue === "gmpay-edge-webhooks") return 5;
	return 3;
}

function mergeDuplicatePaymentScans(
	messages: readonly Message<WebhookQueueMessage | PaymentQueueMessage>[],
) {
	const groups = new Map<
		string,
		Message<WebhookQueueMessage | PaymentQueueMessage>[]
	>();
	for (const message of messages) {
		if (!isPaymentScanQueueMessage(message)) continue;
		const body = message.body;
		const key = JSON.stringify([body.orderId, body.receivingMethodId]);
		const group = groups.get(key);
		if (group) group.push(message);
		else groups.set(key, [message]);
	}
	const emitted = new Set<string>();
	return messages.flatMap((message) => {
		if (!isPaymentScanQueueMessage(message)) return [message];
		const body = message.body;
		const key = JSON.stringify([body.orderId, body.receivingMethodId]);
		if (emitted.has(key)) return [];
		emitted.add(key);
		const group = groups.get(key) ?? [message];
		if (group.length === 1) return [message];
		return [
			{
				id: message.id,
				timestamp: message.timestamp,
				attempts: Math.max(...group.map((entry) => entry.attempts)),
				body: message.body,
				ack: () => group.forEach((entry) => void entry.ack()),
				retry: (
					options: Parameters<
						Message<WebhookQueueMessage | PaymentQueueMessage>["retry"]
					>[0],
				) => group.forEach((entry) => void entry.retry(options)),
			},
		];
	});
}

async function processQueueMessage(
	message: Message<WebhookQueueMessage | PaymentQueueMessage>,
	env: Env,
	context: {
		settings: Promise<
			Awaited<ReturnType<typeof loadOperationalSettings>> | undefined
		>;
		runtime: Promise<Awaited<ReturnType<typeof loadRuntimeConfig>> | undefined>;
		adapterCache: Map<string, ReturnType<typeof createReceivingMethodAdapters>>;
		expectedKind: ReturnType<typeof queueExpectedMessageKind>;
	},
) {
	const kind = queueMessageKind(message.body);
	if (kind !== context.expectedKind) {
		await recordRejectedQueueMessage(
			env.DB,
			message,
			kind === "invalid" ? "invalid_or_unsupported_envelope" : "wrong_queue",
		);
		message.ack();
		return;
	}
	if (isWebhookQueueMessage(message)) {
		const [settings, runtime] = await Promise.all([
			context.settings,
			context.runtime,
		]);
		return processWebhookMessage(env.DB, message, fetch, env.WEBHOOK_QUEUE, {
			...(settings ? { settings } : {}),
			...(runtime ? { runtime } : {}),
		});
	}
	if (isPaymentScanQueueMessage(message))
		return handlePaymentScan(
			message,
			env,
			await context.runtime,
			context.adapterCache,
		);
	if (isPaymentProviderEventQueueMessage(message))
		return handlePaymentProviderEvent(message, env, await context.runtime);
	if (isPaymentMaintenanceQueueMessage(message))
		return handlePaymentMaintenance(message, env, await context.runtime);
}

function queueExpectedMessageKind(queue: string) {
	if (queue === "gmpay-edge-webhooks") return "webhook" as const;
	if (queue === "gmpay-edge-payments") return "payment" as const;
	return null;
}

export function queueMessageKind(value: unknown) {
	if (isWebhookQueueMessageBody(value)) return "webhook" as const;
	if (
		isPaymentScanMessageBody(value) ||
		isPaymentProviderEventMessageBody(value) ||
		isPaymentRateSyncMessageBody(value) ||
		isPaymentRpcHealthMessageBody(value) ||
		isPaymentEventSourceReconcileMessageBody(value)
	)
		return "payment" as const;
	return "invalid" as const;
}

function isWebhookQueueMessage(
	message: Message<WebhookQueueMessage | PaymentQueueMessage>,
): message is Message<WebhookQueueMessage> {
	return isWebhookQueueMessageBody(message.body);
}

function isPaymentScanQueueMessage(
	message: Message<WebhookQueueMessage | PaymentQueueMessage>,
): message is Message<PaymentScanMessage> {
	return isPaymentScanMessageBody(message.body);
}

function isPaymentProviderEventQueueMessage(
	message: Message<WebhookQueueMessage | PaymentQueueMessage>,
): message is Message<PaymentProviderEventMessage> {
	return isPaymentProviderEventMessageBody(message.body);
}

function isPaymentMaintenanceQueueMessage(
	message: Message<WebhookQueueMessage | PaymentQueueMessage>,
): message is Message<
	| PaymentRateSyncMessage
	| PaymentRpcHealthMessage
	| PaymentEventSourceReconcileMessage
> {
	return (
		isPaymentRateSyncMessageBody(message.body) ||
		isPaymentRpcHealthMessageBody(message.body) ||
		isPaymentEventSourceReconcileMessageBody(message.body)
	);
}

function isWebhookQueueMessageBody(
	value: unknown,
): value is WebhookQueueMessage {
	if (!isRecord(value)) return false;
	return (
		value.kind === "webhook.delivery" &&
		value.version === 1 &&
		hasOnlyKeys(value, [
			"kind",
			"version",
			"deliveryId",
			"eventId",
			"attempt",
		]) &&
		isBoundedString(value.deliveryId, 128) &&
		isBoundedString(value.eventId, 128) &&
		Number.isSafeInteger(value.attempt) &&
		Number(value.attempt) >= 1 &&
		Number(value.attempt) <= 1000
	);
}

function isPaymentScanMessageBody(value: unknown): value is PaymentScanMessage {
	if (!isRecord(value)) return false;
	return (
		value.kind === "payment.scan" &&
		value.version === 1 &&
		hasOnlyKeys(value, ["kind", "version", "receivingMethodId", "orderId"]) &&
		isBoundedString(value.receivingMethodId, 128) &&
		isBoundedString(value.orderId, 128)
	);
}

function isPaymentProviderEventMessageBody(
	value: unknown,
): value is PaymentProviderEventMessage {
	if (!isRecord(value)) return false;
	return (
		value.kind === "payment.provider_event" &&
		value.version === 1 &&
		hasOnlyKeys(value, ["kind", "version", "eventId"]) &&
		isBoundedString(value.eventId, 128)
	);
}

function isPaymentRateSyncMessageBody(
	value: unknown,
): value is PaymentRateSyncMessage {
	if (!isRecord(value)) return false;
	return (
		value.kind === "payment.rate_sync" &&
		value.version === 1 &&
		hasOnlyKeys(value, ["kind", "version", "category"]) &&
		(value.category === "crypto" || value.category === "fiat")
	);
}

function isPaymentRpcHealthMessageBody(
	value: unknown,
): value is PaymentRpcHealthMessage {
	if (!isRecord(value)) return false;
	return (
		value.kind === "payment.rpc_health" &&
		value.version === 1 &&
		hasOnlyKeys(value, ["kind", "version", "connectionIds"]) &&
		Array.isArray(value.connectionIds) &&
		value.connectionIds.length > 0 &&
		value.connectionIds.length <= 20 &&
		value.connectionIds.every((id) => isBoundedString(id, 128)) &&
		new Set(value.connectionIds).size === value.connectionIds.length
	);
}

function isPaymentEventSourceReconcileMessageBody(
	value: unknown,
): value is PaymentEventSourceReconcileMessage {
	if (!isRecord(value)) return false;
	return (
		value.kind === "payment.event_source_reconcile" &&
		value.version === 1 &&
		hasOnlyKeys(value, ["kind", "version", "sourceId"]) &&
		isBoundedString(value.sourceId, 128)
	);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
	const keys = Object.keys(value);
	return (
		keys.length === allowed.length && keys.every((key) => allowed.includes(key))
	);
}

function isBoundedString(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= maximum
	);
}

async function recordRejectedQueueMessage(
	database: D1Database,
	message: Message<unknown>,
	reason: "invalid_or_unsupported_envelope" | "wrong_queue",
) {
	const body = isRecord(message.body) ? message.body : {};
	await database
		.prepare(
			`INSERT INTO audit_logs
			 (id, action, target_type, target_id, after, created_at)
			 VALUES (?, 'queue.message_rejected', 'queue_message', ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			message.id,
			JSON.stringify({
				kind: scalarMetadata(body.kind),
				version: scalarMetadata(body.version),
				reason,
			}),
			Date.now(),
		)
		.run();
}

function scalarMetadata(value: unknown) {
	return typeof value === "string" || typeof value === "number" ? value : null;
}
