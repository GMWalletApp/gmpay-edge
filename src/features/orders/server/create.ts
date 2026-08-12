import { generateOrderId } from "#/features/orders/order-id";
import type { CreateOrderInput } from "#/features/orders/schema";
import type { ApiOrder } from "#/features/orders/server/query";
import { checkReceivingMethodReadiness } from "#/features/payment-settings/server/check-method-readiness";
import {
	quoteUsdAmountMinor,
	quoteWithExchangeRate,
} from "#/features/payment-settings/server/rates";
import {
	allocateUniqueReceivingMethodAndSnapshot,
	PaymentOrderConflictError,
	ReceivingMethodUnavailableError,
} from "#/features/payment-settings/server/receiving-method-locks";
import { decimalToUnits } from "#/lib/money";
import { currencyDecimals, decimalToMinor } from "#/lib/units";
import { loadOperationalSettings } from "#/server/operational-settings";

async function createOrderAwaitingReceivingMethod(
	db: D1Database,
	input: CreateOrderInput,
	requestUrl: string,
	context: OrderCreationContext = {},
): Promise<ApiOrder> {
	const settings = await loadOperationalSettings(db);
	const expiresInMs = resolveOrderExpiryMs(input.expiresInMs, settings);
	const id = generateOrderId();
	const now = Date.now();
	const expiresAt = now + expiresInMs;
	const fiatDecimals = currencyDecimals(input.currency);
	const amountMinor = decimalToMinor(input.amount, fiatDecimals).toString();
	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO orders
				 (id, external_order_id, status, amount_minor, currency, currency_decimals,
				  payment_asset_id, received_amount_units,
				  description, return_url, notify_url, api_key_id, api_protocol, metadata, expires_at, version, created_at, updated_at)
				 VALUES (?, ?, 'pending', ?, ?, ?, NULL, '0', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		)
		.bind(
			id,
			input.externalOrderId,
			amountMinor,
			input.currency,
			fiatDecimals,
			input.description ?? null,
			input.returnUrl ?? null,
			input.notifyUrl ?? null,
			context.apiKeyId ?? null,
			context.apiProtocol ?? null,
			input.metadata ? JSON.stringify(input.metadata) : null,
			expiresAt,
			now,
			now,
		)
		.run();
	if (result.meta.changes !== 1) {
		const existing = await db
			.prepare(
				"SELECT 1 AS value FROM orders WHERE external_order_id = ? AND api_key_id IS ? LIMIT 1",
			)
			.bind(input.externalOrderId, context.apiKeyId ?? null)
			.first<{ value: number }>();
		if (existing)
			throw new OrderServiceError(
				"external_order_exists",
				"External order ID already exists",
				409,
			);
		throw new Error("Order could not be created");
	}
	return {
		orderId: id,
		externalOrderId: input.externalOrderId,
		status: "pending",
		amount: input.amount,
		currency: input.currency,
		checkoutUrl: `${new URL(requestUrl).origin}/checkout/${id}`,
		expiresAt: new Date(expiresAt).toISOString(),
		...(input.notifyUrl ? { notifyUrl: input.notifyUrl } : {}),
	};
}
export async function createOrder(
	db: D1Database,
	input: CreateOrderInput,
	requestUrl: string,
	context: OrderCreationContext = {},
): Promise<ApiOrder> {
	const order = await createOrderRecord(db, input, requestUrl, context);
	if (order.paymentNetwork === "okpay") {
		const { initializeOkPayOrder } = await import(
			"#/features/orders/server/okpay-hosted"
		);
		await initializeOkPayOrder(db, order, input);
	}
	return order;
}

async function createOrderRecord(
	db: D1Database,
	input: CreateOrderInput,
	requestUrl: string,
	context: OrderCreationContext = {},
): Promise<ApiOrder> {
	if (input.receivingMethodId)
		return createOrderFromReceivingMethod(db, input, requestUrl, context);
	if (!(input.paymentAsset && input.paymentNetwork))
		return createOrderAwaitingReceivingMethod(db, input, requestUrl, context);
	const methods = await db
		.prepare(
			`SELECT rm.id FROM receiving_methods rm
			 JOIN receiving_method_assets link ON link.receiving_method_id = rm.id
			 JOIN payment_assets pa ON pa.id = link.payment_asset_id
			 WHERE pa.code = ?
			 AND pa.rail_code = ?
			 ORDER BY rm.sort_order, rm.created_at, rm.id`,
		)
		.bind(input.paymentAsset, input.paymentNetwork)
		.all<{ id: string }>();
	const readyMethodIds: string[] = [];
	for (const method of methods.results) {
		const readiness = await checkReceivingMethodReadiness(db, method.id);
		if (readiness.ready) readyMethodIds.push(method.id);
	}
	const [firstMethodId, ...fallbackMethodIds] = readyMethodIds;
	if (firstMethodId)
		return createOrderFromReceivingMethod(
			db,
			{ ...input, receivingMethodId: firstMethodId },
			requestUrl,
			context,
			fallbackMethodIds,
		);
	if (methods.results.length === 0)
		throw new OrderServiceError(
			"receiving_method_not_found",
			"No receiving method matches the requested asset and rail",
			422,
		);
	throw new OrderServiceError(
		"receiving_method_not_ready",
		"No matching receiving method is currently ready",
		422,
	);
}

async function createOrderFromReceivingMethod(
	db: D1Database,
	input: CreateOrderInput,
	requestUrl: string,
	context: OrderCreationContext = {},
	fallbackMethodIds: string[] = [],
): Promise<ApiOrder> {
	const methodId = input.receivingMethodId;
	if (!methodId) throw new Error("Receiving method is required");
	const readiness = await checkReceivingMethodReadiness(db, methodId);
	if (!readiness.ready)
		throw new OrderServiceError(
			"receiving_method_not_ready",
			readiness.reasons[0]?.message ?? "Receiving method is not ready",
			422,
		);
	const methods = await db
		.prepare(
			`SELECT rm.id, rm.target_value, rm.min_amount_minor, rm.max_amount_minor,
			 pa.id AS payment_method_id,
			 pa.code, pa.decimals,
			 pa.rail_code
			 FROM receiving_methods rm
			 JOIN receiving_method_assets link ON link.receiving_method_id = rm.id
			 JOIN payment_assets pa ON pa.id = link.payment_asset_id
			 WHERE rm.id = ? ORDER BY pa.code`,
		)
		.bind(methodId)
		.all<{
			id: string;
			target_value: string;
			min_amount_minor: string | null;
			max_amount_minor: string | null;
			payment_method_id: string;
			code: string;
			decimals: number;
			rail_code: string;
		}>();
	const method =
		input.paymentAsset || input.paymentNetwork
			? methods.results.find(
					(candidate) =>
						(!input.paymentAsset || candidate.code === input.paymentAsset) &&
						(!input.paymentNetwork ||
							candidate.rail_code === input.paymentNetwork),
				)
			: methods.results.length === 1
				? methods.results[0]
				: undefined;
	if (!method)
		throw new OrderServiceError(
			"receiving_method_not_found",
			methods.results.length > 1
				? "Select a currency supported by this receiving method"
				: "Receiving method does not exist",
			422,
		);
	const paymentInput = {
		...input,
		paymentAsset: method.code,
		paymentNetwork: method.rail_code,
	};
	const fallbackRows =
		fallbackMethodIds.length === 0
			? []
			: (
					await db
						.prepare(
							`SELECT rm.id, rm.target_value, rm.min_amount_minor, rm.max_amount_minor,
							 pa.id AS payment_method_id
							 FROM receiving_methods rm
							 JOIN receiving_method_assets link ON link.receiving_method_id = rm.id
							 JOIN payment_assets pa ON pa.id = link.payment_asset_id
							 WHERE rm.id IN (${fallbackMethodIds.map(() => "?").join(", ")})
							 AND pa.code = ? AND pa.rail_code = ?
							 ORDER BY rm.sort_order, rm.created_at, rm.id`,
						)
						.bind(...fallbackMethodIds, method.code, method.rail_code)
						.all<{
							id: string;
							target_value: string;
							min_amount_minor: string | null;
							max_amount_minor: string | null;
							payment_method_id: string;
						}>()
				).results;
	const exchangeRateQuote = await quoteWithExchangeRate(db, {
		amount: input.amount,
		currency: input.currency,
		paymentAsset: method.code,
		assetDecimals: method.decimals,
	});
	let paymentAmount =
		exchangeRateQuote?.paymentAmount ??
		(await quotePaymentAmount(db, paymentInput, method.decimals));
	const expectedAmountUnits = decimalToUnits(
		paymentAmount,
		method.decimals,
		"up",
	).toString();
	const orderAmountUsdMinor = [method, ...fallbackRows].some(
		(candidate) =>
			candidate.min_amount_minor !== null ||
			candidate.max_amount_minor !== null,
	)
		? await quoteUsdAmountMinor(db, {
				amount: input.amount,
				currency: input.currency,
			})
		: null;
	const settings = await loadOperationalSettings(db);
	const expiresInMs = resolveOrderExpiryMs(input.expiresInMs, settings);
	const now = Date.now();
	const expiresAt = now + expiresInMs;
	const fiatDecimals = currencyDecimals(input.currency);
	const amountMinor = decimalToMinor(input.amount, fiatDecimals).toString();
	const orderId = generateOrderId();
	let allocatedMethodId = methodId;
	let allocatedTarget = method.target_value;
	try {
		const allocation = await allocateUniqueReceivingMethodAndSnapshot(db, {
			orderId,
			receivingMethodId: methodId,
			paymentMethodId: method.payment_method_id,
			expectedAmountUnits,
			...(orderAmountUsdMinor ? { orderAmountUsdMinor } : {}),
			...(fallbackRows.length
				? {
						fallbackMethods: fallbackRows.map((row) => ({
							receivingMethodId: row.id,
							paymentMethodId: row.payment_method_id,
						})),
					}
				: {}),
			decimals: method.decimals,
			expiresAt,
			reusableAt: settings.immediateReleaseMode
				? expiresAt
				: expiresAt + settings.reorgMonitorMs,
			immediateReleaseMode: settings.immediateReleaseMode,
			now,
			...(exchangeRateQuote
				? {
						rate: {
							source: exchangeRateQuote.source,
							raw: exchangeRateQuote.rawRate,
							adjustment: String(exchangeRateQuote.adjustmentBps),
							final: exchangeRateQuote.finalRate,
							observedAt: exchangeRateQuote.observedAt,
						},
					}
				: {}),
			order: {
				externalOrderId: input.externalOrderId,
				amountMinor,
				currency: input.currency,
				currencyDecimals: fiatDecimals,
				...(input.description ? { description: input.description } : {}),
				...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
				...(input.notifyUrl ? { notifyUrl: input.notifyUrl } : {}),
				...(context.apiKeyId ? { apiKeyId: context.apiKeyId } : {}),
				...(context.apiProtocol ? { apiProtocol: context.apiProtocol } : {}),
				...(input.metadata ? { metadata: input.metadata } : {}),
			},
		});
		paymentAmount = allocation.paymentAmount;
		const fallback = fallbackRows.find(
			(row) => row.id === allocation.receivingMethodId,
		);
		if (fallback) {
			allocatedMethodId = fallback.id;
			allocatedTarget = fallback.target_value;
		}
	} catch (error) {
		if (error instanceof PaymentOrderConflictError)
			throw new OrderServiceError(
				"external_order_exists",
				"External order ID already exists",
				409,
			);
		if (error instanceof ReceivingMethodUnavailableError)
			throw new OrderServiceError(
				"payment_target_unavailable",
				error.message,
				503,
			);
		throw error;
	}
	return {
		orderId,
		externalOrderId: input.externalOrderId,
		status: "pending",
		amount: input.amount,
		currency: input.currency,
		paymentAmount,
		paymentAsset: method.code,
		paymentNetwork: method.rail_code,
		receivingMethodId: allocatedMethodId,
		receiveAddress: allocatedTarget,
		checkoutUrl: `${new URL(requestUrl).origin}/checkout/${orderId}`,
		expiresAt: new Date(expiresAt).toISOString(),
		...(input.notifyUrl ? { notifyUrl: input.notifyUrl } : {}),
	};
}

function resolveOrderExpiryMs(
	requestedExpiryMs: number | undefined,
	settings: Awaited<ReturnType<typeof loadOperationalSettings>>,
) {
	if (settings.immediateReleaseMode) return settings.fixedExpiryMs;
	const expiresInMs = requestedExpiryMs ?? settings.defaultExpiryMs;
	if (expiresInMs > settings.maxExpiryMs)
		throw new OrderServiceError(
			"expiry_exceeds_limit",
			"Order expiry exceeds the configured maximum",
			422,
		);
	return expiresInMs;
}

export interface OrderCreationContext {
	apiKeyId?: string;
	apiProtocol?: "gmpay" | "epay";
}

async function quotePaymentAmount(
	db: D1Database,
	input: CreateOrderInput,
	assetDecimals: number,
) {
	if (!input.paymentAsset)
		throw new OrderServiceError(
			"payment_asset_required",
			"Payment asset is required for quoting",
			422,
		);
	const quote = await quoteWithExchangeRate(db, {
		amount: input.amount,
		currency: input.currency,
		paymentAsset: input.paymentAsset,
		assetDecimals,
	});
	if (quote) return quote.paymentAmount;
	throw new OrderServiceError(
		"exchange_rate_unavailable",
		"No current exchange rate is available for the requested pair",
		503,
	);
}
export class OrderServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}
