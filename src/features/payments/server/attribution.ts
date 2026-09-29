import { paymentTransactionId } from "#/features/payments/server/reconciliation";
import type { NormalizedTransaction } from "#/integrations/chains/types";
import { DomainError } from "#/lib/domain-error";
import { immediateReleaseModeSql } from "#/server/operational-settings";

type AttributionCandidate = {
	order_id: string;
	expected_amount_units: string;
	received_amount_units: string;
};

const caseInsensitiveAddressNetworks = new Set([
	"ethereum",
	"base",
	"bsc",
	"polygon",
]);

export type PaymentAttribution = {
	orderId: string;
	alreadyAttributed: boolean;
};

export class PaymentAttributionAmbiguousError extends DomainError {
	constructor() {
		super(
			"payment_attribution_ambiguous",
			409,
			"Transaction cannot be attributed to one payment order",
		);
		this.name = "PaymentAttributionAmbiguousError";
	}
}

export class PaymentAttributionNotFoundError extends DomainError {
	constructor() {
		super(
			"payment_attribution_not_found",
			422,
			"Transaction does not match an eligible payment order",
		);
		this.name = "PaymentAttributionNotFoundError";
	}
}

/**
 * Resolves a chain transfer before accounting so concurrent orders sharing one
 * receiving address cannot race to claim it. The persisted transaction owner is
 * authoritative; otherwise an exact remaining balance must be unique whenever
 * more than one order can receive the transfer.
 */
export async function resolvePaymentTransactionOrder(
	db: D1Database,
	transaction: NormalizedTransaction,
	preferredOrderId?: string,
): Promise<PaymentAttribution> {
	const existing = await db
		.prepare(
			"SELECT order_id FROM order_payments WHERE transaction_id = ? LIMIT 1",
		)
		.bind(paymentTransactionId(transaction))
		.first<{ order_id: string }>();
	if (existing) return { orderId: existing.order_id, alreadyAttributed: true };

	const targetPredicate = caseInsensitiveAddressNetworks.has(
		transaction.network,
	)
		? "LOWER(ops.target_value) = LOWER(?)"
		: "ops.target_value = ?";
	const targetIndex = caseInsensitiveAddressNetworks.has(transaction.network)
		? "order_payment_snapshots_target_nocase_idx"
		: "order_payment_snapshots_target_idx";
	const observedAt = transaction.timestamp.getTime();
	const active = await db
		.prepare(
			`SELECT DISTINCT o.id AS order_id, o.received_amount_units,
			 ops.expected_amount_units
			 FROM order_payment_snapshots ops INDEXED BY ${targetIndex}
			 JOIN orders o ON o.id = ops.order_id
			 LEFT JOIN receiving_method_locks lock
			 ON lock.order_id = o.id
			 AND lock.receiving_method_id = ops.receiving_method_id
			 AND lock.asset_id = ops.asset_id
			 WHERE ops.rail_code = ? AND ops.asset_code = ?
			 AND ${targetPredicate}
			 AND o.status IN (
			  'pending','confirming','partially_paid','paid','overpaid','expired','cancelled'
			 )
			 AND (
			  (${immediateReleaseModeSql} = 0
			   AND lock.collision_key IS NOT NULL)
			  OR (${immediateReleaseModeSql} = 1
			   AND o.created_at <= ? AND o.expires_at >= ?)
			  OR o.id = ?
			 )
			 LIMIT 101`,
		)
		.bind(
			transaction.network,
			transaction.assetCode,
			transaction.to,
			observedAt,
			observedAt,
			preferredOrderId ?? "",
		)
		.all<AttributionCandidate>();
	// Immediate release keeps no lock after expiry, so a transfer observed after
	// every matching order closed is a late payment for one of them rather than
	// an unattributable transfer. The reorg-monitor window bounds how far back.
	const candidates = active.results.length
		? active
		: await db
				.prepare(
					`SELECT DISTINCT o.id AS order_id, o.received_amount_units,
					 ops.expected_amount_units
					 FROM order_payment_snapshots ops INDEXED BY ${targetIndex}
					 JOIN orders o ON o.id = ops.order_id
					 WHERE ops.rail_code = ? AND ops.asset_code = ?
					 AND ${targetPredicate}
					 AND ${immediateReleaseModeSql} = 1
					 AND o.status IN ('expired','cancelled')
					 AND o.created_at <= ? AND o.expires_at < ?
					 AND o.expires_at >= ? - COALESCE(
					  (SELECT json_extract(value, '$') FROM system_settings
					   WHERE key = 'payments.reorg_monitor_ms'), 86400000)
					 LIMIT 101`,
				)
				.bind(
					transaction.network,
					transaction.assetCode,
					transaction.to,
					observedAt,
					observedAt,
					observedAt,
				)
				.all<AttributionCandidate>();
	if (candidates.results.length === 101)
		throw new PaymentAttributionAmbiguousError();

	const exact = candidates.results.filter((candidate) => {
		const remainingUnits =
			BigInt(candidate.expected_amount_units) -
			BigInt(candidate.received_amount_units);
		return remainingUnits > 0n && remainingUnits === transaction.amountUnits;
	});
	if (exact.length > 1) throw new PaymentAttributionAmbiguousError();
	const [exactCandidate] = exact;
	if (exactCandidate)
		return { orderId: exactCandidate.order_id, alreadyAttributed: false };
	const [onlyCandidate] = candidates.results;
	if (onlyCandidate && candidates.results.length === 1)
		return {
			orderId: onlyCandidate.order_id,
			alreadyAttributed: false,
		};
	if (candidates.results.length > 1)
		throw new PaymentAttributionAmbiguousError();
	throw new PaymentAttributionNotFoundError();
}

export function paymentTargetAddressMatches(
	network: string,
	left: string,
	right: string,
) {
	return caseInsensitiveAddressNetworks.has(network)
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}
