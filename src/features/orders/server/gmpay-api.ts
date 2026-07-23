import { z } from "zod";
import {
	authenticateGmpayParameters,
	GmpayRateLimitError,
} from "#/features/api-keys/server/gmpay-signature";
import {
	type CreateOrderInput,
	createOrderSchema,
} from "#/features/orders/schema";
import {
	createOrder,
	type OrderCreationContext,
	OrderServiceError,
} from "#/features/orders/server/create";
import { type ApiOrder, getOrder } from "#/features/orders/server/query";
import { requestId as getRequestId } from "#/server/http";

const gmpayQuerySchema = z
	.object({
		pid: z.string().trim().min(1).max(128),
		trade_id: z.string().trim().min(1).max(128).optional(),
		order_id: z.string().trim().min(1).max(128).optional(),
		signature: z
			.string()
			.trim()
			.regex(/^[0-9a-f]{64}$/),
	})
	.refine((value) => Boolean(value.trade_id) !== Boolean(value.order_id), {
		message: "Exactly one order selector is required",
	});

const gmpayCreateSchema = z.object({
	pid: z.string().trim().min(1).max(128),
	order_id: z.string().trim().min(1).max(128),
	currency: z.string().trim().length(3),
	token: z.string().trim().max(20).optional(),
	network: z.string().trim().max(32).optional(),
	// GMPay JSON clients must send decimal strings. Coercing a JSON number here
	// could silently lose precision before the order's minor-unit conversion.
	amount: z.string(),
	notify_url: z.string().trim().url(),
	signature: z
		.string()
		.trim()
		.regex(/^[0-9a-f]{64}$/),
	redirect_url: z.string().trim().url().optional(),
	name: z.string().trim().max(500).optional(),
	payment_type: z.string().trim().max(32).optional(),
});

export type GmpayCreateInput = z.infer<typeof gmpayCreateSchema>;

export function parseGmpayRequestBody(contentType: string, rawBody: string) {
	if (contentType.toLowerCase().includes("application/x-www-form-urlencoded"))
		return Object.fromEntries(new URLSearchParams(rawBody));
	try {
		const value: unknown = JSON.parse(rawBody);
		return value && typeof value === "object" && !Array.isArray(value)
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

export function parseGmpayCreateInput(value: unknown) {
	return gmpayCreateSchema.safeParse(value);
}

export function parseGmpayQueryInput(value: unknown) {
	return gmpayQuerySchema.safeParse(value);
}

export function toCreateOrderInput(input: GmpayCreateInput): CreateOrderInput {
	return createOrderSchema.parse({
		externalOrderId: input.order_id,
		amount: input.amount,
		currency: input.currency,
		paymentAsset: input.token || undefined,
		paymentNetwork: input.network || undefined,
		description: input.name || undefined,
		returnUrl: input.redirect_url || undefined,
		notifyUrl: input.notify_url,
		metadata: { integration: "gmpay" },
	});
}

export async function authenticateGmpayCreate(
	db: D1Database,
	input: GmpayCreateInput,
) {
	return authenticateGmpayParameters(db, input, "orders:create");
}

export async function authenticateGmpayQuery(
	db: D1Database,
	input: z.infer<typeof gmpayQuerySchema>,
) {
	return authenticateGmpayParameters(db, input, "orders:read");
}

export function gmpayCreateResponse(order: ApiOrder, requestId: string) {
	return {
		status_code: 200,
		message: "success",
		data: {
			trade_id: order.orderId,
			order_id: order.externalOrderId,
			amount: order.amount,
			currency: order.currency,
			actual_amount: order.paymentAmount ?? "0",
			receive_address: order.receiveAddress ?? "",
			token: order.paymentAsset ?? "",
			network: order.paymentNetwork ?? "",
			status: order.status,
			expiration_time: Math.floor(new Date(order.expiresAt).getTime() / 1000),
			payment_url: order.checkoutUrl,
		},
		request_id: requestId,
	};
}

export function gmpayQueryResponse(order: ApiOrder, requestId: string) {
	return gmpayCreateResponse(order, requestId);
}

export function gmpayError(
	requestId: string,
	statusCode: number,
	message: string,
) {
	return {
		status_code: statusCode,
		message,
		data: null,
		request_id: requestId,
	};
}

export function gmpayOrderError(error: OrderServiceError) {
	const codes: Record<string, number> = {
		external_order_exists: 10002,
		invalid_amount: 10004,
		expiry_exceeds_limit: 10009,
		receiving_method_not_found: 10003,
		receiving_method_not_ready: 10003,
		receiving_method_required: 10003,
		payment_target_unavailable: 10003,
		provider_configuration_missing: 10003,
		provider_unavailable: 10003,
		payment_asset_required: 10016,
		payment_asset_unavailable: 10016,
		exchange_rate_unavailable: 10016,
		order_not_found: 10001,
	};
	return codes[error.code] ?? 400;
}

export function gmpayOrderMessage(error: OrderServiceError) {
	const messages: Record<string, string> = {
		external_order_exists: "External order ID already exists",
		invalid_amount: "Invalid order amount",
		expiry_exceeds_limit: "Order expiry exceeds the configured maximum",
		receiving_method_not_found: "No receiving method matches the request",
		receiving_method_not_ready: "No receiving method is currently available",
		receiving_method_required: "Select a receiving method",
		payment_target_unavailable: "No payment target is currently available",
		payment_asset_required: "Payment asset is required",
		payment_asset_unavailable: "Payment asset is unavailable",
		exchange_rate_unavailable: "Exchange rate is unavailable",
		provider_configuration_missing: "Payment provider is unavailable",
		provider_unavailable: "Payment provider is unavailable",
		order_not_found: "Order not found",
	};
	return messages[error.code] ?? "Order request failed";
}

export async function handleGmpayQueryRequest(
	request: Request,
	env: Pick<Env, "DB">,
	findOrder = getOrder,
) {
	const requestId = getRequestId(request);
	try {
		const url = new URL(request.url);
		const parsed = parseGmpayQueryInput(Object.fromEntries(url.searchParams));
		if (!parsed.success)
			return gatewayResponse(
				gmpayError(requestId, 10009, "invalid parameters"),
				400,
			);
		const principal = await authenticateGmpayQuery(env.DB, parsed.data);
		if (!principal)
			return gatewayResponse(
				gmpayError(requestId, 401, "signature verification failed"),
				401,
			);
		const order = await findOrder(
			env.DB,
			parsed.data.trade_id
				? { id: parsed.data.trade_id, apiKeyId: principal.apiKeyId }
				: {
						externalOrderId: parsed.data.order_id as string,
						apiKeyId: principal.apiKeyId,
					},
			request.url,
		);
		if (!order)
			return gatewayResponse(
				gmpayError(requestId, 10001, "order not found"),
				404,
			);
		return gatewayResponse(gmpayQueryResponse(order, requestId), 200);
	} catch (error) {
		if (error instanceof GmpayRateLimitError)
			return gatewayResponse(
				gmpayError(requestId, 429, "API rate limit exceeded"),
				429,
			);
		logMerchantApiFailure("gmpay.query", requestId);
		return gatewayResponse(gmpayError(requestId, 500, "system error"), 500);
	}
}

type OrderCreator = (
	db: D1Database,
	input: CreateOrderInput,
	requestUrl: string,
	context: OrderCreationContext,
) => Promise<ApiOrder>;

export async function handleGmpayCreateRequest(
	request: Request,
	env: Pick<Env, "DB">,
	create: OrderCreator = createOrder,
) {
	const requestId = getRequestId(request);
	try {
		const parsed = parseGmpayCreateInput(
			parseGmpayRequestBody(
				request.headers.get("content-type") ?? "",
				await request.text(),
			),
		);
		if (!parsed.success)
			return gatewayResponse(
				gmpayError(requestId, 10009, "invalid parameters"),
				400,
			);
		const principal = await authenticateGmpayCreate(env.DB, parsed.data);
		if (!principal)
			return gatewayResponse(
				gmpayError(requestId, 401, "signature verification failed"),
				401,
			);
		const order = await create(
			env.DB,
			toCreateOrderInput(parsed.data),
			request.url,
			{
				apiKeyId: principal.apiKeyId,
				apiProtocol: "gmpay",
			},
		);
		return gatewayResponse(gmpayCreateResponse(order, requestId), 200);
	} catch (error) {
		if (error instanceof GmpayRateLimitError)
			return gatewayResponse(
				gmpayError(requestId, 429, "API rate limit exceeded"),
				429,
			);
		if (error instanceof OrderServiceError)
			return gatewayResponse(
				gmpayError(requestId, gmpayOrderError(error), gmpayOrderMessage(error)),
				error.status >= 500 ? error.status : 400,
			);
		logMerchantApiFailure("gmpay.create", requestId);
		return gatewayResponse(gmpayError(requestId, 500, "system error"), 500);
	}
}

export function logMerchantApiFailure(
	operation: "gmpay.create" | "gmpay.query" | "epay.create" | "epay.query",
	requestId: string,
) {
	console.error("merchant_api_failure", { operation, requestId });
}

function gatewayResponse(body: { request_id: string }, status: number) {
	return Response.json(body, {
		status,
		headers: {
			"cache-control": "no-store",
			"x-request-id": body.request_id,
		},
	});
}
