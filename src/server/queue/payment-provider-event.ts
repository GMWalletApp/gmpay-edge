import { z } from "zod";
import { createPaymentMethodAdapters } from "#/features/payment-settings/server/method-adapter";
import {
	PaymentAttributionAmbiguousError,
	PaymentAttributionNotFoundError,
	paymentTargetAddressMatches,
	resolvePaymentTransactionOrder,
} from "#/features/payments/server/attribution";
import { recordPaymentTransaction } from "#/features/payments/server/process";
import { PaymentAttributionConflictError } from "#/features/payments/server/reconciliation";
import type { PaymentProviderEventMessage } from "#/features/payments/types";
import type { NormalizedTransaction } from "#/integrations/chains/types";
import { DomainError } from "#/lib/domain-error";
import { immediateReleaseModeSql } from "#/server/operational-settings";
import type { RuntimeConfig } from "#/server/runtime-config";

const maximumAttempts = 5;
const maximumAdapterAttempts = 8;
// Eight bounded EVM lookups plus database/dispatch headroom.
const processingLeaseMs = maximumAdapterAttempts * 30_000 + 60_000;

type ProviderEventLease = { eventId: string; token: string; until: number };

const triggerSchema = z.object({
	transactionHash: z.string().min(1).max(128),
	eventIndex: z.number().int().min(0),
	fromAddress: z.string().min(1).max(256),
	toAddress: z.string().min(1).max(256),
	assetCode: z.string().min(1).max(32),
	contractAddress: z.string().min(1).max(256).nullable(),
	blockNumber: z.string().min(1).max(128),
	removed: z.boolean(),
});

type ProviderEventRow = {
	source_id: string;
	trigger: string;
	attempt_count: number;
	event_mode: "shadow" | "active";
	source_mode: "shadow" | "active";
	enabled: number;
	network: string;
};

type PaymentCandidate = {
	payment_asset_id: string;
	asset_code: string;
	target_value: string;
};

class RetryableProviderEventError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "RetryableProviderEventError";
	}
}

class PermanentProviderEventError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "PermanentProviderEventError";
	}
}

export async function handlePaymentProviderEvent(
	message: Message<PaymentProviderEventMessage>,
	env: Env,
	runtime?: RuntimeConfig,
) {
	const now = Date.now();
	const lease: ProviderEventLease = {
		eventId: message.body.eventId,
		token: crypto.randomUUID(),
		until: now + processingLeaseMs,
	};
	const claim = await env.DB.prepare(
		`UPDATE inbound_provider_events SET status = 'processing',
		 attempt_count = attempt_count + 1, lease_until = ?, lease_token = ?, next_attempt_at = NULL,
		 updated_at = ? WHERE id = ? AND (
		  (status IN ('received','queued','failed')
		   AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
		  OR (status = 'processing' AND lease_until <= ?)
		 )`,
	)
		.bind(lease.until, lease.token, now, lease.eventId, now, now)
		.run();
	if (claim.meta.changes !== 1) {
		message.ack();
		return;
	}
	const row = await env.DB.prepare(
		`SELECT event.source_id, event.trigger, event.attempt_count,
		 event.ingest_mode AS event_mode,
		 source.mode AS source_mode, source.enabled, source.network
		 FROM inbound_provider_events event
		 JOIN payment_ingresses source ON source.id = event.source_id
		 WHERE event.id = ? AND event.lease_token = ? LIMIT 1`,
	)
		.bind(lease.eventId, lease.token)
		.first<ProviderEventRow>();
	if (!row) {
		message.ack();
		return;
	}
	if (!row.enabled) {
		await completeProviderEvent(env.DB, lease, "ignored", "source_disabled");
		message.ack();
		return;
	}

	try {
		const trigger = triggerSchema.parse(JSON.parse(row.trigger));
		const candidates = await loadCandidates(env.DB, row.network, trigger);
		if (candidates.length === 21) throw new PaymentAttributionAmbiguousError();
		if (!candidates.length) {
			await completeProviderEvent(
				env.DB,
				lease,
				"ignored",
				"no_payment_candidate",
			);
			message.ack();
			return;
		}
		const transaction = await loadAuthoritativeTransaction(
			env.DB,
			candidates,
			trigger,
			lease.until - 30_000,
		);
		if (!transaction) {
			if (row.attempt_count < 3)
				throw new RetryableProviderEventError("transaction_not_found");
			await completeProviderEvent(
				env.DB,
				lease,
				"ignored",
				trigger.removed ? "reorg_hint" : "webhook_rpc_mismatch",
				trigger.removed ? undefined : row.source_id,
			);
			message.ack();
			return;
		}
		if (!providerTriggerMatchesTransaction(row.network, trigger, transaction)) {
			await completeProviderEvent(
				env.DB,
				lease,
				"ignored",
				"webhook_rpc_mismatch",
				row.source_id,
			);
			message.ack();
			return;
		}
		const attribution = await resolvePaymentTransactionOrder(
			env.DB,
			transaction,
		);
		const active = row.event_mode === "active" && row.source_mode === "active";
		if (active)
			await recordPaymentTransaction(
				env,
				attribution.orderId,
				transaction,
				runtime,
				{
					guard: env.DB.prepare(`SELECT CASE WHEN EXISTS (
				 SELECT 1 FROM inbound_provider_events WHERE id = ? AND status = 'processing'
				 AND lease_token = ? AND lease_until > unixepoch('subsec') * 1000
				) THEN 1 ELSE json_extract('provider event lease lost', '$') END`).bind(
						lease.eventId,
						lease.token,
					),
				},
			);
		await completeProviderEvent(
			env.DB,
			lease,
			active ? "succeeded" : "ignored",
			active ? null : "shadow_matched",
		);
		message.ack();
	} catch (error) {
		const owned = await env.DB.prepare(
			"SELECT 1 AS owned FROM inbound_provider_events WHERE id = ? AND status = 'processing' AND lease_token = ? AND lease_until > ?",
		)
			.bind(lease.eventId, lease.token, Date.now())
			.first();
		if (!owned) {
			message.ack();
			return;
		}
		if (error instanceof z.ZodError || error instanceof SyntaxError) {
			await failProviderEvent(
				env.DB,
				lease,
				"invalid_stored_trigger",
				true,
				now,
			);
			message.ack();
			return;
		}
		if (error instanceof PaymentAttributionAmbiguousError) {
			await completeProviderEvent(env.DB, lease, "ambiguous", error.code);
			message.ack();
			return;
		}
		if (error instanceof PaymentAttributionNotFoundError) {
			// The authoritative RPC confirmed the transfer; it only matches no
			// eligible order, which says nothing about the ingress health.
			await completeProviderEvent(env.DB, lease, "ignored", error.code);
			message.ack();
			return;
		}
		if (error instanceof PermanentProviderEventError) {
			await failProviderEvent(env.DB, lease, error.code, true, now);
			message.ack();
			return;
		}
		if (
			error instanceof DomainError &&
			!(error instanceof PaymentAttributionConflictError)
		) {
			await failProviderEvent(env.DB, lease, error.code, true, now);
			message.ack();
			return;
		}
		const retryableError =
			error instanceof PaymentAttributionConflictError
				? new RetryableProviderEventError(error.code)
				: error;
		if (!(retryableError instanceof RetryableProviderEventError)) throw error;
		const dead = row.attempt_count >= maximumAttempts;
		const delaySeconds = Math.min(300, 15 * 2 ** (row.attempt_count - 1));
		await failProviderEvent(
			env.DB,
			lease,
			retryableError.code,
			dead,
			Date.now() + delaySeconds * 1000,
		);
		if (dead) message.ack();
		else message.retry({ delaySeconds });
	}
}

async function loadCandidates(
	db: D1Database,
	network: string,
	trigger: z.infer<typeof triggerSchema>,
) {
	const rows = await db
		.prepare(
			`SELECT DISTINCT ops.asset_id AS payment_asset_id, ops.asset_code,
			 ops.target_value
			 FROM order_payment_snapshots ops
			 INDEXED BY order_payment_snapshots_target_nocase_idx
			 JOIN orders o ON o.id = ops.order_id
			 LEFT JOIN receiving_method_locks lock ON lock.order_id = o.id
			  AND lock.receiving_method_id = ops.receiving_method_id
			  AND lock.asset_id = ops.asset_id
			 WHERE ops.rail_code = ? AND LOWER(ops.target_value) = ?
			 AND o.status IN (
			  'pending','confirming','partially_paid','paid','overpaid','expired','cancelled'
			 ) AND (
			  ${immediateReleaseModeSql} = 1
			  OR lock.collision_key IS NOT NULL
			 ) AND (
			  (? IS NOT NULL AND LOWER(ops.contract_address) = ?)
			  OR (? IS NULL AND UPPER(ops.asset_code) = ?)
			 )
			 ORDER BY ops.asset_id LIMIT 21`,
		)
		.bind(
			network,
			trigger.toAddress.toLowerCase(),
			trigger.contractAddress,
			trigger.contractAddress,
			trigger.contractAddress,
			trigger.assetCode.toUpperCase(),
		)
		.all<PaymentCandidate>();
	return rows.results;
}

async function loadAuthoritativeTransaction(
	db: D1Database,
	candidates: readonly PaymentCandidate[],
	trigger: z.infer<typeof triggerSchema>,
	deadlineAt: number,
) {
	let attempts = 0;
	let retryableFailure = false;
	let permanentFailure: string | undefined;
	for (const candidate of candidates) {
		if (Date.now() >= deadlineAt)
			throw new RetryableProviderEventError("authoritative_lookup_deadline");
		const adapters = await createPaymentMethodAdapters(
			db,
			candidate.payment_asset_id,
			candidate.target_value,
		);
		for (const { adapter } of adapters) {
			if (attempts >= maximumAdapterAttempts) break;
			if (Date.now() >= deadlineAt)
				throw new RetryableProviderEventError("authoritative_lookup_deadline");
			attempts += 1;
			try {
				const transaction = await adapter.getTransaction(
					trigger.transactionHash,
					{
						address: candidate.target_value,
						assetCode: candidate.asset_code,
						eventIndex: trigger.eventIndex,
					},
				);
				if (Date.now() >= deadlineAt)
					throw new RetryableProviderEventError(
						"authoritative_lookup_deadline",
					);
				if (transaction) return transaction;
			} catch (error) {
				if (error instanceof RetryableProviderEventError) throw error;
				const kind = adapter.classifyError(error);
				if (adapter.isRetryable(kind)) retryableFailure = true;
				else permanentFailure ??= kind;
			}
		}
		if (attempts >= maximumAdapterAttempts) break;
	}
	if (retryableFailure)
		throw new RetryableProviderEventError("authoritative_lookup_failed");
	if (permanentFailure)
		throw new PermanentProviderEventError(
			`authoritative_lookup_${permanentFailure}`,
		);
	if (!attempts)
		throw new PermanentProviderEventError("authoritative_adapter_unavailable");
	return null;
}

function providerTriggerMatchesTransaction(
	network: string,
	trigger: z.infer<typeof triggerSchema>,
	transaction: NormalizedTransaction,
) {
	return (
		transaction.network === network &&
		transaction.hash.toLowerCase() === trigger.transactionHash.toLowerCase() &&
		transaction.eventIndex === trigger.eventIndex &&
		paymentTargetAddressMatches(network, transaction.to, trigger.toAddress) &&
		transaction.assetCode.toUpperCase() === trigger.assetCode.toUpperCase()
	);
}

async function completeProviderEvent(
	db: D1Database,
	lease: ProviderEventLease,
	status: "succeeded" | "ignored" | "ambiguous",
	errorCode: string | null,
	degradedSourceId?: string,
) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`UPDATE inbound_provider_events SET status = ?, processed_at = ?,
			 lease_until = NULL, next_attempt_at = NULL, last_error_code = ?,
			 updated_at = ? WHERE id = ? AND status = 'processing' AND lease_token = ? AND lease_until > ?`,
			)
			.bind(status, now, errorCode, now, lease.eventId, lease.token, now),
		...(degradedSourceId
			? [
					db
						.prepare(
							`UPDATE payment_ingresses SET health_status = 'degraded',
							 last_error_code = ?, updated_at = ? WHERE id = ? AND EXISTS (
							 SELECT 1 FROM inbound_provider_events WHERE id = ? AND lease_token = ? AND status = ? AND processed_at = ?)`,
						)
						.bind(
							"webhook_rpc_mismatch",
							now,
							degradedSourceId,
							lease.eventId,
							lease.token,
							status,
							now,
						),
				]
			: []),
	]);
}

async function failProviderEvent(
	db: D1Database,
	lease: ProviderEventLease,
	errorCode: string,
	dead: boolean,
	nextAttemptAt: number,
) {
	const now = Date.now();
	await db
		.prepare(
			`UPDATE inbound_provider_events SET status = ?, lease_until = NULL, lease_token = NULL,
			 next_attempt_at = ?, last_error_code = ?, processed_at = ?, updated_at = ?
			 WHERE id = ? AND status = 'processing' AND lease_token = ? AND lease_until > ?`,
		)
		.bind(
			dead ? "dead" : "failed",
			dead ? null : nextAttemptAt,
			errorCode,
			dead ? now : null,
			now,
			lease.eventId,
			lease.token,
			now,
		)
		.run();
}
