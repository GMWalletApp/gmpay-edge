import { createReceivingMethodAdapters } from "#/features/payment-settings/server/method-adapter";
import {
	PaymentAttributionAmbiguousError,
	PaymentAttributionNotFoundError,
	resolvePaymentTransactionOrder,
} from "#/features/payments/server/attribution";
import { recordPaymentTransaction } from "#/features/payments/server/process";
import { paymentTransactionId } from "#/features/payments/server/reconciliation";
import type { PaymentScanMessage } from "#/features/payments/types";
import type {
	AdapterErrorKind,
	Network,
	NormalizedTransaction,
	PaymentAdapter,
	ScanTruncation,
	TransactionScan,
} from "#/integrations/chains/types";
import {
	isObservedProviderAdapter,
	providerOperationDurationMs,
	recordProviderOperation,
} from "#/integrations/provider-observability";
import type { RuntimeConfig } from "#/server/runtime-config";

/**
 * Transfers for an order cannot predate the order, so provider history walks
 * start at the order's creation minus this clock-skew margin instead of the
 * shared address's lifetime.
 */
const scanLowerBoundMarginMs = 15 * 60_000;
/** One unattributed audit row per transfer per day while shared-address scans keep re-discovering it. */
const unattributedAuditDedupeMs = 86_400_000;
/** Only faults of the connection itself may change its health; per-order scan limits and logic errors must not. */
const connectionFaultKinds = new Set<AdapterErrorKind>([
	"network",
	"authentication",
	"rate_limit",
	"invalid_response",
]);

export async function handlePaymentScan(
	message: Message<PaymentScanMessage>,
	env: Env,
	runtime?: RuntimeConfig,
	adapterCache?: Map<string, ReceivingAdaptersPromise>,
): Promise<void> {
	const payment = await env.DB.prepare(
		`SELECT ops.asset_id, ops.asset_code, ops.target_value, o.provider_order_id,
		 o.payment_scan_cursor, o.created_at
		 FROM order_payment_snapshots ops
		 JOIN orders o ON o.id = ops.order_id
		 WHERE ops.order_id = ? AND ops.receiving_method_id = ? LIMIT 1`,
	)
		.bind(message.body.orderId, message.body.receivingMethodId)
		.first<{
			asset_id: string;
			asset_code: string;
			target_value: string;
			provider_order_id: string | null;
			payment_scan_cursor: string | null;
			created_at: number;
		}>();
	if (!payment) {
		message.ack();
		return;
	}
	const scan: AuthoritativePaymentScan = {
		...message.body,
		address: payment.target_value,
		sinceTimestampMs: payment.created_at - scanLowerBoundMarginMs,
		...(payment.provider_order_id
			? { providerOrderId: payment.provider_order_id }
			: {}),
		...(payment.payment_scan_cursor
			? { sinceBlock: payment.payment_scan_cursor }
			: {}),
	};
	let candidates: Awaited<ReturnType<typeof createReceivingMethodAdapters>>;
	try {
		const load = () =>
			createReceivingMethodAdapters(
				env.DB,
				message.body.receivingMethodId,
				runtime,
				{ assetId: payment.asset_id, targetValue: payment.target_value },
			);
		if (!adapterCache) candidates = await load();
		else {
			const key = JSON.stringify([
				message.body.receivingMethodId,
				payment.asset_id,
				payment.target_value,
			]);
			let pending = adapterCache.get(key);
			if (!pending) {
				pending = load();
				adapterCache.set(key, pending);
			}
			candidates = await pending;
		}
	} catch {
		await recordPaymentScanIssue(env.DB, message.body, "configuration");
		message.retry();
		return;
	}
	if (!candidates.length) {
		await recordPaymentScanIssue(env.DB, message.body, "configuration");
		message.retry();
		return;
	}
	let failoverCount = 0;
	for (const [index, candidate] of candidates.entries()) {
		const startedAt = performance.now();
		let outcome: PaymentScanOutcome;
		try {
			outcome = await scanTransactions(
				env.DB,
				scan,
				payment.asset_code,
				candidate.adapter,
				candidate.subscription,
			);
		} catch (error) {
			outcome = { transactions: [], discoveryError: { cause: error } };
		}
		if (!outcome.discoveryError) {
			if (isObservedProviderAdapter(candidate.adapter.id))
				recordProviderOperation({
					adapter: candidate.adapter.id,
					operation: "payment_scan",
					outcome: "success",
					status: outcome.transactions.length ? "ok" : "empty",
					errorCode: null,
					durationMs: providerOperationDurationMs(startedAt),
					failoverCount,
				});
			if (candidate.connectionId)
				await updateConnectionHealth(
					env.DB,
					candidate.connectionId,
					"healthy",
					null,
				);
			let capBlock: bigint | undefined;
			await processScannedTransactions(
				env,
				message.body.orderId,
				outcome.transactions,
				runtime,
				{
					onUnattributed: (transaction) => {
						if (capBlock === undefined || transaction.blockNumber < capBlock)
							capBlock = transaction.blockNumber;
					},
				},
			);
			await advancePaymentScanCursor(
				env.DB,
				message.body.orderId,
				outcome.transactions,
				{
					...(outcome.truncated ? { truncated: outcome.truncated } : {}),
					...(capBlock === undefined ? {} : { capBlock }),
				},
			);
			message.ack();
			return;
		}
		const kind = candidate.adapter.classifyError(outcome.discoveryError.cause);
		const retryable = candidate.adapter.isRetryable(kind);
		const willFailover = retryable && index < candidates.length - 1;
		if (willFailover) failoverCount += 1;
		if (isObservedProviderAdapter(candidate.adapter.id))
			recordProviderOperation({
				adapter: candidate.adapter.id,
				operation: "payment_scan",
				outcome: "failure",
				status: "error",
				errorCode: kind,
				durationMs: providerOperationDurationMs(startedAt),
				failoverCount,
			});
		if (candidate.connectionId && connectionFaultKinds.has(kind))
			await updateConnectionHealth(
				env.DB,
				candidate.connectionId,
				"unhealthy",
				kind,
			);
		// Hash refreshes still carry confirmation and reorg updates for known
		// payments while address discovery is failing.
		await processScannedTransactions(
			env,
			message.body.orderId,
			outcome.transactions,
			runtime,
		);
		if (!retryable) {
			await recordPaymentScanIssue(env.DB, message.body, kind);
			message.ack();
			return;
		}
	}
	await recordPaymentScanIssue(env.DB, message.body, "connections_unavailable");
	message.retry();
}

type ReceivingAdaptersPromise = ReturnType<
	typeof createReceivingMethodAdapters
>;

type PaymentScanOutcome = {
	transactions: NormalizedTransaction[];
	truncated?: ScanTruncation;
	/** Present when address discovery failed; `transactions` then hold only pushed and refreshed events. */
	discoveryError?: { cause: unknown };
};

export async function scanTransactions(
	db: D1Database,
	message: AuthoritativePaymentScan,
	assetCode: string,
	adapter: PaymentAdapter<unknown>,
	subscription?: {
		connectionId: string;
		adapter: PaymentAdapter<unknown>;
	},
): Promise<PaymentScanOutcome> {
	const pushed: NormalizedTransaction[] = [];
	const subscriptionAdapter = subscription?.adapter ?? adapter;
	const subscriptionController = new AbortController();
	let subscriptionTask: Promise<void> | undefined;
	if (subscriptionAdapter.subscribeTransactions) {
		// WSS connections are opt-in and consumed for a bounded queue-task
		// window. They run alongside the authoritative HTTP poll rather than
		// adding a fixed delay after it. A dropped socket cannot lose a payment.
		const subscriptionWindowMs = 5_000;
		subscriptionTask = subscriptionAdapter
			.subscribeTransactions({
				address: message.address,
				assetCode,
				signal: AbortSignal.any([
					subscriptionController.signal,
					AbortSignal.timeout(subscriptionWindowMs),
				]),
				onTransaction: (transaction) => {
					pushed.push(transaction);
				},
			})
			.then(() => undefined)
			.catch(async (error: unknown) => {
				if (subscription)
					await updateConnectionHealth(
						db,
						subscription.connectionId,
						"unhealthy",
						subscriptionAdapter.classifyError(error),
					);
				// Subscription transport is an optimization. The HTTP poll below
				// remains the recovery path when a provider rejects or drops WSS.
			});
	}
	try {
		let discovered: TransactionScan = [];
		let discoveryError: PaymentScanOutcome["discoveryError"];
		try {
			discovered = message.providerOrderId
				? [
						await adapter.getTransaction(message.providerOrderId, {
							address: message.address,
							assetCode,
						}),
					].filter(
						(transaction): transaction is NonNullable<typeof transaction> =>
							transaction !== null,
					)
				: await adapter.findTransactions({
						address: message.address,
						assetCode,
						...(message.sinceBlock
							? { sinceBlock: BigInt(message.sinceBlock) }
							: {}),
						...(message.sinceTimestampMs === undefined
							? {}
							: { sinceTimestampMs: message.sinceTimestampMs }),
					});
		} catch (error) {
			discoveryError = { cause: error };
		}
		// Known payments are refreshed by hash even when discovery failed so
		// confirmation growth and reorg detection never stall behind it.
		const pending = await refreshPendingPaymentTransactions(
			db,
			message.orderId,
			adapter,
		);
		return {
			transactions: mergeScannedTransactions(discovered, pushed, pending),
			...(discovered.truncated ? { truncated: discovered.truncated } : {}),
			...(discoveryError ? { discoveryError } : {}),
		};
	} finally {
		subscriptionController.abort();
		await subscriptionTask;
	}
}

type AuthoritativePaymentScan = PaymentScanMessage & {
	address: string;
	providerOrderId?: string;
	sinceBlock?: string;
	sinceTimestampMs?: number;
};

export async function refreshPendingPaymentTransactions(
	db: D1Database,
	orderId: string,
	adapter: PaymentAdapter<unknown>,
) {
	const rows = await db
		.prepare(
			`SELECT bt.network, bt.tx_hash, bt.event_index, bt.from_address,
			 bt.to_address, bt.asset_code, bt.amount_units, bt.block_number,
			 bt.block_hash, bt.confirmations, bt.status, bt.observed_at
			 FROM order_payments op JOIN blockchain_transactions bt
			 ON op.transaction_id = bt.network || ':' || bt.tx_hash || ':' || bt.event_index
			 WHERE op.order_id = ? AND op.status IN ('detected', 'pending_review', 'confirming', 'confirmed')`,
		)
		.bind(orderId)
		.all<{
			network: Network;
			tx_hash: string;
			event_index: number;
			from_address: string;
			to_address: string;
			asset_code: string;
			amount_units: string;
			block_number: string;
			block_hash: string;
			confirmations: number;
			status: string;
			observed_at: number;
		}>();
	const refreshed: NormalizedTransaction[] = [];
	for (const row of rows.results) {
		const stored: NormalizedTransaction = {
			network: row.network,
			hash: row.tx_hash,
			eventIndex: row.event_index,
			from: row.from_address,
			to: row.to_address,
			assetCode: row.asset_code,
			amountUnits: BigInt(row.amount_units),
			blockNumber: BigInt(row.block_number),
			blockHash: row.block_hash,
			confirmations: row.confirmations,
			timestamp: new Date(row.observed_at),
			success: true,
			canonical: true,
		};
		const current = await findCurrentTransactionEvent(adapter, stored);
		if (current) {
			if (row.status === "missing")
				await db
					.prepare(
						"UPDATE blockchain_transactions SET status = 'pending', updated_at = ? WHERE network = ? AND tx_hash = ? AND event_index = ? AND status = 'missing'",
					)
					.bind(Date.now(), row.network, row.tx_hash, row.event_index)
					.run();
			refreshed.push(current);
		} else if (row.status === "missing")
			refreshed.push({
				...stored,
				confirmations: 0,
				canonical: false,
			});
		else
			await db
				.prepare(
					"UPDATE blockchain_transactions SET status = 'missing', updated_at = ? WHERE network = ? AND tx_hash = ? AND event_index = ?",
				)
				.bind(Date.now(), row.network, row.tx_hash, row.event_index)
				.run();
	}
	return refreshed;
}

async function findCurrentTransactionEvent(
	adapter: PaymentAdapter<unknown>,
	stored: NormalizedTransaction,
) {
	const direct = await adapter.getTransaction(stored.hash, {
		address: stored.to,
		assetCode: stored.assetCode,
		eventIndex: stored.eventIndex,
		observedAtMs: stored.timestamp.getTime(),
	});
	return sameTransactionEvent(direct, stored) ? direct : undefined;
}

function sameTransactionEvent(
	candidate: NormalizedTransaction | null | undefined,
	stored: NormalizedTransaction,
) {
	return (
		candidate?.network === stored.network &&
		candidate.hash === stored.hash &&
		candidate.eventIndex === stored.eventIndex
	);
}

function mergeScannedTransactions(...groups: NormalizedTransaction[][]) {
	const merged = new Map<string, NormalizedTransaction>();
	for (const transaction of groups.flat())
		merged.set(paymentTransactionId(transaction), transaction);
	return [...merged.values()];
}

/**
 * Moves the order's provider cursor forward monotonically. A truncated scan
 * advances only to the block it fully covered, and an unattributed transfer
 * caps the cursor at its block so a later scan can re-discover it.
 */
export async function advancePaymentScanCursor(
	db: D1Database,
	orderId: string,
	transactions: Array<{ blockNumber: bigint }>,
	options?: { truncated?: ScanTruncation; capBlock?: bigint },
) {
	const scanned = options?.truncated
		? (options.truncated.scannedThroughBlock ?? null)
		: transactions.reduce<bigint | null>(
				(maximum, transaction) =>
					maximum === null || transaction.blockNumber > maximum
						? transaction.blockNumber
						: maximum,
				null,
			);
	if (scanned === null) return null;
	const cursor =
		options?.capBlock !== undefined && options.capBlock < scanned
			? options.capBlock
			: scanned;
	await db
		.prepare(
			`UPDATE orders SET payment_scan_cursor = CASE
			 WHEN payment_scan_cursor IS NULL OR CAST(payment_scan_cursor AS INTEGER) < CAST(? AS INTEGER)
			 THEN ? ELSE payment_scan_cursor END
			 WHERE id = ?`,
		)
		.bind(cursor.toString(), cursor.toString(), orderId)
		.run();
	return cursor;
}

export async function processScannedTransactions(
	env: Env,
	orderId: string,
	transactions: Parameters<typeof recordPaymentTransaction>[2][],
	runtime?: RuntimeConfig,
	options?: { onUnattributed?: (transaction: NormalizedTransaction) => void },
) {
	let skippedPreviouslyAttributed = 0;
	let skippedAmbiguous = 0;
	for (const transaction of transactions) {
		try {
			const attribution = await resolvePaymentTransactionOrder(
				env.DB,
				transaction,
				orderId,
			);
			await recordPaymentTransaction(
				env,
				attribution.orderId,
				transaction,
				runtime,
			);
			if (attribution.orderId !== orderId) skippedPreviouslyAttributed += 1;
		} catch (error) {
			if (
				!(error instanceof PaymentAttributionAmbiguousError) &&
				!(error instanceof PaymentAttributionNotFoundError)
			)
				throw error;
			skippedAmbiguous += 1;
			await recordUnattributedPaymentTransaction(
				env.DB,
				orderId,
				transaction,
				error.code,
			);
			options?.onUnattributed?.(transaction);
		}
	}
	return { skippedPreviouslyAttributed, skippedAmbiguous };
}

/** Real funds without an accounting owner leave an audit trail instead of vanishing from the scan. */
async function recordUnattributedPaymentTransaction(
	db: D1Database,
	orderId: string,
	transaction: NormalizedTransaction,
	code: string,
) {
	const now = Date.now();
	const transactionId = paymentTransactionId(transaction);
	await db
		.prepare(
			`INSERT INTO audit_logs (id, action, target_type, target_id, after, created_at)
			 SELECT ?, 'payment.scan_unattributed', 'transaction', ?, ?, ?
			 WHERE NOT EXISTS (
			  SELECT 1 FROM audit_logs INDEXED BY audit_logs_created_idx
			  WHERE created_at >= ? AND action = 'payment.scan_unattributed' AND target_id = ?)`,
		)
		.bind(
			crypto.randomUUID(),
			transactionId,
			JSON.stringify({
				orderId,
				code,
				network: transaction.network,
				to: transaction.to,
				assetCode: transaction.assetCode,
				amountUnits: transaction.amountUnits.toString(),
				blockNumber: transaction.blockNumber.toString(),
			}),
			now,
			now - unattributedAuditDedupeMs,
			transactionId,
		)
		.run();
}

async function recordPaymentScanIssue(
	db: D1Database,
	message: PaymentScanMessage,
	kind: string,
) {
	await db
		.prepare(
			`INSERT INTO audit_logs
			 (id, action, target_type, target_id, after, created_at)
			 VALUES (?, 'payment.scan_failed', 'order', ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			message.orderId,
			JSON.stringify({
				receivingMethodId: message.receivingMethodId,
				kind,
			}),
			Date.now(),
		)
		.run();
}

export async function updateConnectionHealth(
	db: D1Database,
	connectionId: string,
	status: "healthy" | "unhealthy",
	errorCode: string | null,
) {
	await db
		.prepare(
			`UPDATE payment_ingresses SET health_status = ?, last_checked_at = ?,
				 last_error_code = ?, updated_at = ? WHERE id = ?
				 AND EXISTS (
				  SELECT 1 FROM payment_rails rail
				  WHERE rail.code = payment_ingresses.rail_code AND rail.kind = 'chain'
				 )`,
		)
		.bind(status, Date.now(), errorCode, Date.now(), connectionId)
		.run();
}
