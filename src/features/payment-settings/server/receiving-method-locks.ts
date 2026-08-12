import { loadCheckoutAmountDecimals } from "#/features/settings/server/system-settings";
import { quantizeUnitsUp, unitsToDecimal } from "#/lib/money";

export type PaymentAllocationInput = {
	orderId: string;
	receivingMethodId: string;
	paymentMethodId: string;
	expectedAmountUnits: string;
	orderAmountUsdMinor?: string;
	expiresAt: number;
	reusableAt?: number;
	immediateReleaseMode?: boolean;
	rate?: {
		source?: string;
		raw?: string;
		adjustment?: string;
		final?: string;
		observedAt?: number;
	};
	now?: number;
	order?: {
		externalOrderId: string;
		amountMinor: string;
		currency: string;
		currencyDecimals: number;
		description?: string;
		returnUrl?: string;
		notifyUrl?: string;
		apiKeyId?: string;
		apiProtocol?: "gmpay" | "epay";
		metadata?: Record<string, string>;
	};
	existingOrder?: {
		expectedVersion: number;
	};
};

export class ReceivingMethodUnavailableError extends Error {
	readonly code = "PAYMENT_TARGET_UNAVAILABLE";

	constructor(
		message = "The receiving method is already reserved for this amount",
		readonly reason:
			| "collision"
			| "not_ready"
			| "limit_rate_unavailable"
			| "below_minimum"
			| "above_maximum" = "collision",
	) {
		super(message);
		this.name = "ReceivingMethodUnavailableError";
	}
}

export async function allocateUniqueReceivingMethodAndSnapshot(
	db: D1Database,
	input: PaymentAllocationInput & {
		decimals: number;
		maximumAttempts?: number;
		fallbackMethods?: Array<{
			receivingMethodId: string;
			paymentMethodId: string;
		}>;
	},
) {
	const configuredDecimals = await loadCheckoutAmountDecimals(db);
	const quantized = quantizeUnitsUp(
		parseAmountUnits(input.expectedAmountUnits),
		input.decimals,
		configuredDecimals,
	);
	const maximumAttempts = Math.max(
		1,
		Math.min(input.maximumAttempts ?? 100, 1_000),
	);
	const {
		decimals,
		maximumAttempts: _maximumAttempts,
		fallbackMethods,
		...allocationInput
	} = input;
	// Every candidate is tried at the requested amount before the amount is
	// stepped up, so concurrent equal-amount orders spread across methods first.
	const candidates = [
		{
			receivingMethodId: input.receivingMethodId,
			paymentMethodId: input.paymentMethodId,
		},
		...(fallbackMethods ?? []),
	];
	for (let offset = 0; offset < maximumAttempts; offset++) {
		const amountUnits =
			quantized.amountUnits + BigInt(offset) * quantized.stepUnits;
		const expectedAmountUnits = amountUnits.toString();
		const paymentAmount = unitsToDecimal(amountUnits, decimals);
		for (const candidate of [...candidates]) {
			try {
				const allocated = await allocateReceivingMethodAndSnapshot(db, {
					...allocationInput,
					receivingMethodId: candidate.receivingMethodId,
					paymentMethodId: candidate.paymentMethodId,
					expectedAmountUnits,
					...(input.order ? { order: input.order } : {}),
					...(input.existingOrder
						? { existingOrder: input.existingOrder }
						: {}),
				});
				return { ...allocated, expectedAmountUnits, paymentAmount };
			} catch (error) {
				if (!(error instanceof ReceivingMethodUnavailableError)) throw error;
				if (error.reason !== "collision") {
					candidates.splice(candidates.indexOf(candidate), 1);
					if (candidates.length === 0) throw error;
				}
			}
		}
	}
	throw new ReceivingMethodUnavailableError();
}

export class PaymentOrderConflictError extends Error {
	readonly code = "EXTERNAL_ORDER_EXISTS";
}

export async function allocateReceivingMethodAndSnapshot(
	db: D1Database,
	input: PaymentAllocationInput,
) {
	parseAmountUnits(input.expectedAmountUnits);
	const now = input.now ?? Date.now();
	const reusableAt = Math.max(
		input.expiresAt,
		input.reusableAt ?? input.expiresAt + 24 * 3_600_000,
	);
	await releaseExpiredReceivingMethodLocks(
		db,
		now,
		input.immediateReleaseMode ?? false,
	);
	await clearReusableReceivingMethodLockKeys(db, now);
	const method = await db
		.prepare(
			`SELECT rm.id, rm.min_amount_minor, rm.max_amount_minor,
			 rm.target_value, asset.id AS payment_method_id,
			 asset.default_confirmations,
			 asset.id AS asset_id, asset.rail_code, connection.id AS connection_id
			 FROM receiving_methods rm
			 JOIN receiving_method_assets link ON link.receiving_method_id = rm.id
			 JOIN payment_assets asset ON asset.id = link.payment_asset_id
			 JOIN payment_rails rail ON rail.code = asset.rail_code
			 JOIN payment_ingresses connection ON connection.rail_code = asset.rail_code
			 WHERE rm.id = ? AND asset.id = ? AND rm.enabled = 1 AND rm.target_value != ''
				 AND connection.enabled = 1
				 AND (rail.kind IN ('exchange', 'wallet') OR connection.health_status = 'healthy')
			 ORDER BY connection.priority, connection.id LIMIT 1`,
		)
		.bind(input.receivingMethodId, input.paymentMethodId)
		.first<{
			id: string;
			min_amount_minor: string | null;
			max_amount_minor: string | null;
			target_value: string;
			payment_method_id: string;
			default_confirmations: number;
			asset_id: string;
			rail_code: string;
			connection_id: string;
		}>();
	if (!method)
		throw new ReceivingMethodUnavailableError(
			"Receiving method is not ready",
			"not_ready",
		);
	if (method.min_amount_minor !== null || method.max_amount_minor !== null) {
		if (input.orderAmountUsdMinor === undefined)
			throw new ReceivingMethodUnavailableError(
				"The USD amount required for receiving limits is unavailable",
				"limit_rate_unavailable",
			);
		assertAmountLimits(
			parseAmountUnits(input.orderAmountUsdMinor),
			method.min_amount_minor,
			method.max_amount_minor,
		);
	}

	const lockId = crypto.randomUUID();
	const collisionKey = `${input.receivingMethodId}:${method.asset_id}:${input.expectedAmountUnits}`;
	const statements: D1PreparedStatement[] = [];
	let orderMutationIndex: number | undefined;
	if (input.order) {
		orderMutationIndex = statements.length;
		statements.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO orders
						(id, external_order_id, status, amount_minor, currency, currency_decimals,
						 payment_asset_id, received_amount_units, description, return_url,
						 notify_url, api_key_id, api_protocol, metadata, expires_at, version, created_at, updated_at)
						SELECT ?, ?, 'pending', ?, ?, ?, asset.id, '0', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?
						FROM receiving_methods receiving
						JOIN receiving_method_assets link ON link.receiving_method_id = receiving.id
						JOIN payment_assets asset ON asset.id = link.payment_asset_id
						WHERE receiving.id = ? AND asset.id = ? AND receiving.enabled = 1`,
				)
				.bind(
					input.orderId,
					input.order.externalOrderId,
					input.order.amountMinor,
					input.order.currency,
					input.order.currencyDecimals,
					input.order.description ?? null,
					input.order.returnUrl ?? null,
					input.order.notifyUrl ?? null,
					input.order.apiKeyId ?? null,
					input.order.apiProtocol ?? null,
					input.order.metadata ? JSON.stringify(input.order.metadata) : null,
					input.expiresAt,
					now,
					now,
					input.receivingMethodId,
					input.paymentMethodId,
				),
		);
	}
	const lockIndex = statements.length;
	statements.push(
		db
			.prepare(
				`INSERT OR IGNORE INTO receiving_method_locks
					(id, receiving_method_id, asset_id, order_id, expected_amount_units, collision_key,
					 expires_at, reusable_at, released_at, created_at)
					SELECT ?, receiving.id, asset.id, ?, ?, ?, ?, ?, NULL, ?
					FROM receiving_methods receiving
					JOIN receiving_method_assets link ON link.receiving_method_id = receiving.id
					JOIN payment_assets asset ON asset.id = link.payment_asset_id
					WHERE receiving.id = ? AND asset.id = ? AND receiving.enabled = 1
					AND (? = 0 OR changes() = 1)
					`,
			)
			.bind(
				lockId,
				input.orderId,
				input.expectedAmountUnits,
				collisionKey,
				input.expiresAt,
				reusableAt,
				now,
				input.receivingMethodId,
				input.paymentMethodId,
				input.order ? 1 : 0,
			),
	);
	if (input.existingOrder) {
		orderMutationIndex = statements.length;
		statements.push(
			db
				.prepare(
					`UPDATE orders SET payment_asset_id = asset.id,
					 provider_order_id = NULL, payment_url = NULL,
					 version = version + 1, updated_at = ?
					 FROM receiving_methods receiving
					 JOIN receiving_method_assets link ON link.receiving_method_id = receiving.id
					 JOIN payment_assets asset ON asset.id = link.payment_asset_id
					 WHERE orders.id = ? AND receiving.id = ? AND asset.id = ? AND orders.version = ?
					 AND receiving.enabled = 1
					 AND orders.status = 'pending' AND orders.received_amount_units = '0'
					 AND NOT EXISTS (SELECT 1 FROM order_payment_snapshots WHERE order_id = orders.id)
					 AND NOT EXISTS (SELECT 1 FROM order_payments WHERE order_id = orders.id)
					 AND EXISTS (SELECT 1 FROM receiving_method_locks WHERE id = ?)`,
				)
				.bind(
					now,
					input.orderId,
					input.receivingMethodId,
					input.paymentMethodId,
					input.existingOrder.expectedVersion,
					lockId,
				),
		);
	}
	const snapshotIndex = statements.length;
	statements.push(
		db
			.prepare(
				`INSERT OR IGNORE INTO order_payment_snapshots
					(order_id, receiving_method_id, receiving_method_name,
					 rail_code, rail_kind, asset_id, asset_code, decimals,
					 contract_address, target_value, connection_id, adapter,
					 required_confirmations, expected_amount_units, rate_source, raw_rate,
					 rate_adjustment, final_rate, rate_observed_at, created_at)
					SELECT ?, receiving.id, receiving.name,
					 rail.code, rail.kind, asset.id, asset.code, asset.decimals,
					 asset.contract_address, receiving.target_value, connection.id, rail.adapter,
					 asset.default_confirmations, ?, ?, ?, ?, ?, ?, ?
					FROM receiving_methods receiving
					JOIN receiving_method_assets link ON link.receiving_method_id = receiving.id
					JOIN payment_assets asset ON asset.id = link.payment_asset_id
					JOIN payment_rails rail ON rail.code = asset.rail_code
					JOIN payment_ingresses connection ON connection.id = ?
					WHERE receiving.id = ? AND asset.id = ? AND changes() = 1`,
			)
			.bind(
				input.orderId,
				input.expectedAmountUnits,
				input.rate?.source ?? null,
				input.rate?.raw ?? null,
				input.rate?.adjustment ?? null,
				input.rate?.final ?? null,
				input.rate?.observedAt ?? null,
				now,
				method.connection_id,
				input.receivingMethodId,
				input.paymentMethodId,
			),
	);
	statements.push(
		db
			.prepare(
				`DELETE FROM receiving_method_locks WHERE id = ?
				 AND NOT EXISTS (SELECT 1 FROM order_payment_snapshots WHERE order_id = ?)`,
			)
			.bind(lockId, input.orderId),
	);
	if (input.order)
		statements.push(
			db
				.prepare(
					`DELETE FROM orders WHERE id = ?
					 AND NOT EXISTS (SELECT 1 FROM order_payment_snapshots WHERE order_id = ?)`,
				)
				.bind(input.orderId, input.orderId),
		);
	const results = await db.batch(statements);
	const orderChanged =
		orderMutationIndex === undefined ||
		(results[orderMutationIndex]?.meta.changes ?? 0) === 1;
	if (
		orderChanged &&
		(results[lockIndex]?.meta.changes ?? 0) === 1 &&
		(results[snapshotIndex]?.meta.changes ?? 0) === 1
	)
		return { lockId, receivingMethodId: input.receivingMethodId };
	if (input.order) {
		const existing = await db
			.prepare(
				"SELECT 1 AS value FROM orders WHERE external_order_id = ? AND api_key_id IS ? LIMIT 1",
			)
			.bind(input.order.externalOrderId, input.order.apiKeyId ?? null)
			.first<{ value: number }>();
		if (existing) throw new PaymentOrderConflictError();
	}
	throw new ReceivingMethodUnavailableError();
}

export async function releaseReceivingMethodLock(
	db: D1Database,
	orderId: string,
	now = Date.now(),
) {
	const result = await db
		.prepare(
			"UPDATE receiving_method_locks SET released_at = ? WHERE order_id = ? AND released_at IS NULL",
		)
		.bind(now, orderId)
		.run();
	return (result.meta.changes ?? 0) > 0 ? 1 : 0;
}

async function releaseExpiredReceivingMethodLocks(
	db: D1Database,
	now = Date.now(),
	immediateReleaseMode = false,
) {
	const result = await db
		.prepare(
			immediateReleaseMode
				? "DELETE FROM receiving_method_locks WHERE expires_at <= ?"
				: "UPDATE receiving_method_locks SET released_at = ? WHERE released_at IS NULL AND expires_at <= ?",
		)
		.bind(...(immediateReleaseMode ? [now] : [now, now]))
		.run();
	return result.meta.changes ?? 0;
}

export async function clearReusableReceivingMethodLockKeys(
	db: D1Database,
	now = Date.now(),
) {
	const [, result] = await db.batch([
		db
			.prepare(
				`UPDATE payment_ingresses
				 SET reconcile_required_at = COALESCE(reconcile_required_at, ?),
				 updated_at = ? WHERE enabled = 1 AND EXISTS (
				  SELECT 1 FROM receiving_method_locks lock
				  JOIN receiving_methods method ON method.id = lock.receiving_method_id
				  WHERE method.rail_code = payment_ingresses.network
				  AND lock.collision_key IS NOT NULL AND lock.reusable_at <= ?
				 )`,
			)
			.bind(now, now, now),
		db
			.prepare(
				"UPDATE receiving_method_locks SET collision_key = NULL WHERE collision_key IS NOT NULL AND reusable_at <= ?",
			)
			.bind(now),
	]);
	return result?.meta.changes ?? 0;
}

export function receivingMethodLockModeSwitchStatements(
	db: D1Database,
	immediateReleaseMode: boolean,
	now: number,
) {
	if (immediateReleaseMode)
		return [
			db
				.prepare(
					"DELETE FROM receiving_method_locks WHERE released_at IS NOT NULL OR expires_at <= ?",
				)
				.bind(now),
			db.prepare(
				"UPDATE receiving_method_locks SET reusable_at = expires_at WHERE released_at IS NULL",
			),
		];
	return [
		db.prepare(
			`UPDATE receiving_method_locks
			 SET reusable_at = expires_at + COALESCE(
			  (SELECT json_extract(value, '$') FROM system_settings
			   WHERE key = 'payments.reorg_monitor_ms'), 86400000)
			 WHERE released_at IS NULL`,
		),
	];
}

function parseAmountUnits(value: string) {
	if (!/^(0|[1-9]\d*)$/.test(value))
		throw new Error("Expected amount must be a non-negative integer");
	return BigInt(value);
}

function assertAmountLimits(
	value: bigint,
	minimum: string | null,
	maximum: string | null,
) {
	if (minimum !== null && value < parseAmountUnits(minimum))
		throw new ReceivingMethodUnavailableError(
			"Amount is below the method minimum",
			"below_minimum",
		);
	if (maximum !== null && value > parseAmountUnits(maximum))
		throw new ReceivingMethodUnavailableError(
			"Amount exceeds the method maximum",
			"above_maximum",
		);
}
