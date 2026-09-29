import { DomainError } from "#/lib/domain-error";

const MANUAL_RETRY_LEASE_MS = 5 * 60_000;

type RetryState = { status: string; next_attempt_at: number | null };

/**
 * A delivery accepts a manual retry when it is `dead`, or `failed`/`delivering`
 * with no scheduled or leased attempt (`next_attempt_at` unset or elapsed).
 */
export function isManuallyRetryableWebhookDelivery(
	delivery: RetryState,
	now: number,
) {
	if (delivery.status === "dead") return true;
	if (delivery.status !== "failed" && delivery.status !== "delivering")
		return false;
	return delivery.next_attempt_at === null || delivery.next_attempt_at <= now;
}

export function requireRetryableWebhookDelivery<T extends RetryState>(
	delivery: T | null,
	now = Date.now(),
): asserts delivery is T & { status: "failed" | "dead" | "delivering" } {
	if (!delivery)
		throw new DomainError(
			"webhook_delivery_not_found",
			404,
			"Webhook delivery not found",
		);
	if (
		delivery.status !== "failed" &&
		delivery.status !== "dead" &&
		delivery.status !== "delivering"
	)
		throw new DomainError(
			"webhook_delivery_not_retryable",
			409,
			"Webhook delivery cannot be retried",
		);
	if (!isManuallyRetryableWebhookDelivery(delivery, now))
		throw new DomainError(
			"webhook_delivery_retry_in_progress",
			409,
			"Webhook delivery retry is already in progress",
		);
}

/**
 * Leases the delivery for the enqueue in one conditional write. The row is
 * left `failed` with the attempt number preserved, so a crash before the Queue
 * send is recovered by the outbox sweep once the lease elapses and the next
 * attempt continues the numbering instead of overwriting history.
 */
export async function claimManualWebhookRetry(
	db: D1Database,
	deliveryId: string,
	attemptCount: number,
	now = Date.now(),
) {
	const result = await db
		.prepare(
			`UPDATE webhook_deliveries
			 SET status = 'failed', next_attempt_at = ?, completed_at = NULL, updated_at = ?
			 WHERE id = ? AND attempt_count = ? AND (
			  status = 'dead'
			  OR (status IN ('failed', 'delivering')
			   AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
			 )`,
		)
		.bind(now + MANUAL_RETRY_LEASE_MS, now, deliveryId, attemptCount, now)
		.run();
	return (result.meta.changes ?? 0) === 1;
}

/** Makes a leased retry due immediately after the Queue rejected the message. */
export async function releaseManualWebhookRetry(
	db: D1Database,
	deliveryId: string,
	attemptCount: number,
	now: number,
) {
	await db
		.prepare(
			`UPDATE webhook_deliveries SET next_attempt_at = ?, updated_at = ?
			 WHERE id = ? AND status = 'failed' AND attempt_count = ? AND next_attempt_at = ?`,
		)
		.bind(now, now, deliveryId, attemptCount, now + MANUAL_RETRY_LEASE_MS)
		.run();
}
