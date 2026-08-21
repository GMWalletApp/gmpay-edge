import { z } from "zod";
import { orderIdPathSchema } from "#/features/orders/schema";
import { initializeOkPayOrder } from "#/features/orders/server/okpay-hosted";
import { checkReceivingMethodReadiness } from "#/features/payment-settings/server/check-method-readiness";
import {
	quoteUsdAmountMinor,
	quoteWithExchangeRate,
} from "#/features/payment-settings/server/rates";
import { allocateUniqueReceivingMethodAndSnapshot } from "#/features/payment-settings/server/receiving-method-locks";
import { DomainError } from "#/lib/domain-error";
import { decimalToUnits, unitsToDecimal } from "#/lib/money";
import { minorToDecimal } from "#/lib/units";
import { loadOperationalSettings } from "#/server/operational-settings";

export const paymentOptionInput = z.object({
	orderId: orderIdPathSchema,
	receivingMethodId: z.string().trim().min(1).max(100),
	paymentMethodId: z.string().trim().min(1).max(100),
});

type OrderForSelection = {
	id: string;
	external_order_id: string;
	status: string;
	amount: string;
	currency: string;
	paymentAmount: string | null;
	description: string | null;
	return_url: string | null;
	expires_at: number;
	received_amount_units: string;
	payment_asset_id: string | null;
	provider_order_id: string | null;
	payment_url: string | null;
	version: number;
	current_asset_code: string;
	current_network: string;
	current_network_name: string;
	current_receiving_method_name: string;
	current_rail_kind: "chain" | "exchange" | "wallet" | "";
	receiving_method_id: string | null;
	payment_count: number;
	pending_review_count: number;
};

export async function listCheckoutPaymentOptions(
	db: D1Database,
	orderId: string,
) {
	const id = orderIdPathSchema.parse(orderId);
	const order = await readOrder(db, id);
	if (!order) return null;
	if (order.receiving_method_id)
		return {
			selectable: false,
			options: [
				{
					receivingMethodId: order.receiving_method_id,
					receivingMethodName: order.current_receiving_method_name,
					paymentMethodId: "",
					asset: order.current_asset_code,
					network: order.current_network,
					networkName: order.current_network_name,
					railKind: order.current_rail_kind,
					amount: order.paymentAmount ?? "",
					current: true,
				},
			],
		};
	const rows = await db
		.prepare(
			`SELECT rm.id AS receiving_method_id, rm.name AS receiving_method_name,
			 a.id AS payment_method_id,
			 a.code, a.decimals, rm.min_amount_minor, rm.max_amount_minor,
			 a.rail_code AS network, pr.name AS network_name, pr.kind AS rail_kind
			 FROM receiving_methods rm
			 JOIN receiving_method_assets link ON link.receiving_method_id = rm.id
			 JOIN payment_assets a ON a.id = link.payment_asset_id
			 JOIN payment_rails pr ON pr.code = a.rail_code
			 WHERE rm.enabled = 1
			 AND rm.target_value != ''
			 AND EXISTS (SELECT 1 FROM payment_ingresses pc WHERE pc.rail_code = a.rail_code
			  AND pc.enabled = 1
			  AND (pr.kind IN ('exchange', 'wallet') OR pc.health_status = 'healthy'))
			 ORDER BY rm.sort_order, rm.name`,
		)
		.all<{
			receiving_method_id: string;
			receiving_method_name: string;
			payment_method_id: string;
			code: string;
			decimals: number;
			network: string;
			network_name: string;
			rail_kind: "chain" | "exchange" | "wallet";
			min_amount_minor: string | null;
			max_amount_minor: string | null;
		}>();
	const limitsRequireRate = rows.results.some(
		(method) =>
			method.min_amount_minor !== null || method.max_amount_minor !== null,
	);
	const orderAmountUsdMinor = limitsRequireRate
		? await quoteUsdAmountMinor(db, {
				amount: order.amount,
				currency: order.currency,
			})
		: null;
	const options = [];
	let quoteUnavailable = false;
	for (const asset of rows.results) {
		if (
			!isWithinReceivingLimits(
				orderAmountUsdMinor,
				asset.min_amount_minor,
				asset.max_amount_minor,
			)
		)
			continue;
		try {
			const quote = await quoteWithExchangeRate(db, {
				amount: order.amount,
				currency: order.currency,
				paymentAsset: asset.code,
				assetDecimals: asset.decimals,
			});
			if (!quote) {
				quoteUnavailable = true;
				continue;
			}
			options.push({
				receivingMethodId: asset.receiving_method_id,
				receivingMethodName: asset.receiving_method_name,
				paymentMethodId: asset.payment_method_id,
				asset: asset.code,
				network: asset.network,
				networkName: asset.network_name,
				railKind: asset.rail_kind,
				amount: quote.paymentAmount,
				current: false,
			});
		} catch {
			quoteUnavailable = true;
			// A malformed or unavailable quote excludes only this receiving method.
		}
	}
	return {
		selectable:
			order.status === "pending" &&
			order.received_amount_units === "0" &&
			order.expires_at > Date.now() &&
			!order.provider_order_id &&
			order.payment_count === 0 &&
			order.pending_review_count === 0,
		options,
		unavailableReason:
			options.length > 0
				? null
				: quoteUnavailable ||
						(limitsRequireRate && orderAmountUsdMinor === null)
					? ("rate_unavailable" as const)
					: ("payment_method_unavailable" as const),
	};
}

export async function selectCheckoutPaymentOption(
	db: D1Database,
	input: z.infer<typeof paymentOptionInput>,
) {
	const data = paymentOptionInput.parse(input);
	const order = await readOrder(db, data.orderId);
	if (!order) throw new PaymentOptionError("order_not_found", 404);
	if (order.receiving_method_id) {
		if (order.receiving_method_id === data.receivingMethodId)
			return selectedResult(
				order,
				order.current_asset_code,
				order.current_network,
				order.paymentAmount ?? "",
			);
		throw new PaymentOptionError("payment_snapshot_immutable", 409);
	}
	if (
		order.status !== "pending" ||
		order.received_amount_units !== "0" ||
		order.expires_at <= Date.now() ||
		order.provider_order_id ||
		order.payment_count > 0 ||
		order.pending_review_count > 0
	)
		throw new PaymentOptionError("order_unavailable", 409);
	const readiness = await checkReceivingMethodReadiness(
		db,
		data.receivingMethodId,
	);
	if (!readiness.ready)
		throw new PaymentOptionError("receiving_method_not_ready", 409);
	const method = await db
		.prepare(
			`SELECT rm.id, a.id AS payment_method_id, a.code, a.decimals,
		 rm.min_amount_minor, rm.max_amount_minor,
		 a.rail_code AS network
		 FROM receiving_methods rm
		 JOIN receiving_method_assets link ON link.receiving_method_id = rm.id
		 JOIN payment_assets a ON a.id = link.payment_asset_id
		 WHERE rm.id = ? AND a.id = ? LIMIT 1`,
		)
		.bind(data.receivingMethodId, data.paymentMethodId)
		.first<{
			id: string;
			payment_method_id: string;
			code: string;
			decimals: number;
			network: string;
			min_amount_minor: string | null;
			max_amount_minor: string | null;
		}>();
	if (!method) throw new PaymentOptionError("payment_option_unavailable", 409);
	const quote = await quoteWithExchangeRate(db, {
		amount: order.amount,
		currency: order.currency,
		paymentAsset: method.code,
		assetDecimals: method.decimals,
	});
	if (!quote) throw new PaymentOptionError("rate_unavailable", 409);
	const orderAmountUsdMinor =
		method.min_amount_minor !== null || method.max_amount_minor !== null
			? await quoteUsdAmountMinor(db, {
					amount: order.amount,
					currency: order.currency,
				})
			: null;
	if (
		!isWithinReceivingLimits(
			orderAmountUsdMinor,
			method.min_amount_minor,
			method.max_amount_minor,
		)
	)
		throw new PaymentOptionError("payment_option_unavailable", 409);
	let paymentAmount = quote.paymentAmount;
	const now = Date.now();
	const settings = await loadOperationalSettings(db);
	const allocation = await allocateUniqueReceivingMethodAndSnapshot(db, {
		orderId: order.id,
		receivingMethodId: method.id,
		paymentMethodId: method.payment_method_id,
		decimals: method.decimals,
		expectedAmountUnits: decimalToUnits(
			paymentAmount,
			method.decimals,
			"up",
		).toString(),
		...(orderAmountUsdMinor ? { orderAmountUsdMinor } : {}),
		expiresAt: order.expires_at,
		reusableAt: settings.immediateReleaseMode
			? order.expires_at
			: order.expires_at + settings.reorgMonitorMs,
		immediateReleaseMode: settings.immediateReleaseMode,
		now,
		rate: {
			source: quote.source,
			raw: quote.rawRate,
			adjustment: String(quote.adjustmentBps),
			final: quote.finalRate,
			observedAt: quote.observedAt,
		},
		existingOrder: {
			expectedVersion: order.version,
		},
	});
	paymentAmount = allocation.paymentAmount;
	await db
		.prepare(
			`INSERT INTO audit_logs (id, action, target_type, target_id, before, after, created_at)
		 VALUES (?, 'checkout.receiving_method_selected', 'order', ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			order.id,
			JSON.stringify({ receivingMethodId: null }),
			JSON.stringify({ receivingMethodId: method.id }),
			now,
		)
		.run();

	const result = {
		orderId: order.id,
		externalOrderId: order.external_order_id,
		status: "pending" as const,
		amount: order.amount,
		currency: order.currency,
		paymentAmount,
		paymentAsset: method.code,
		paymentNetwork: method.network,
		checkoutUrl: "",
		expiresAt: new Date(order.expires_at).toISOString(),
	};
	if (method.network === "okpay") {
		await initializeOkPayOrder(db, result, {
			externalOrderId: order.external_order_id,
			amount: order.amount,
			currency: order.currency,
			paymentAsset: method.code,
			paymentNetwork: method.network,
			description: order.description ?? undefined,
			returnUrl: order.return_url ?? undefined,
		});
	}
	return selectedResult(order, method.code, method.network, paymentAmount);
}

function isWithinReceivingLimits(
	amountUsdMinor: string | null,
	minimumMinor: string | null,
	maximumMinor: string | null,
) {
	if (minimumMinor === null && maximumMinor === null) return true;
	if (amountUsdMinor === null) return false;
	const amount = BigInt(amountUsdMinor);
	return (
		(minimumMinor === null || amount >= BigInt(minimumMinor)) &&
		(maximumMinor === null || amount <= BigInt(maximumMinor))
	);
}

function selectedResult(
	order: OrderForSelection,
	asset: string,
	network: string,
	paymentAmount: string,
) {
	return {
		orderId: order.id,
		asset,
		network,
		paymentAmount,
		expiresAt: new Date(order.expires_at).toISOString(),
	};
}

async function readOrder(db: D1Database, id: string) {
	const row = await db
		.prepare(
			`SELECT o.id, o.external_order_id, o.status, o.amount_minor,
			 o.currency, o.currency_decimals, o.description, o.return_url, o.expires_at,
			 o.received_amount_units, o.payment_asset_id,
			 o.provider_order_id, o.payment_url, o.version,
			 ops.expected_amount_units, ops.decimals AS payment_decimals,
			 COALESCE(ops.asset_code, a.code, '') AS current_asset_code,
			 COALESCE(ops.rail_code, a.rail_code, '') AS current_network,
			 COALESCE(rail.name, ops.rail_code, a.rail_code, '') AS current_network_name,
			 COALESCE(ops.receiving_method_name, '') AS current_receiving_method_name,
			 COALESCE(ops.rail_kind, rail.kind, '') AS current_rail_kind,
			 ops.receiving_method_id,
			 (SELECT COUNT(*) FROM order_payments op WHERE op.order_id = o.id) AS payment_count,
			 (SELECT COUNT(*) FROM payment_reviews pr WHERE pr.order_id = o.id
			  AND pr.status = 'pending') AS pending_review_count
			 FROM orders o LEFT JOIN payment_assets a ON a.id = o.payment_asset_id
			 LEFT JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 LEFT JOIN payment_rails rail ON rail.code = COALESCE(ops.rail_code, a.rail_code)
			 WHERE o.id = ? LIMIT 1`,
		)
		.bind(id)
		.first<
			Omit<OrderForSelection, "amount" | "paymentAmount"> & {
				amount_minor: string;
				currency_decimals: number;
				expected_amount_units: string | null;
				payment_decimals: number | null;
			}
		>();
	if (!row) return null;
	return {
		...row,
		amount: minorToDecimal(row.amount_minor, row.currency_decimals),
		paymentAmount:
			row.expected_amount_units !== null && row.payment_decimals !== null
				? unitsToDecimal(
						BigInt(row.expected_amount_units),
						row.payment_decimals,
					)
				: null,
	};
}

export class PaymentOptionError extends DomainError {
	constructor(
		code:
			| "order_not_found"
			| "payment_snapshot_immutable"
			| "order_unavailable"
			| "receiving_method_not_ready"
			| "payment_option_unavailable"
			| "rate_unavailable",
		status: number,
	) {
		super(code, status, code);
		this.name = "PaymentOptionError";
	}
}
