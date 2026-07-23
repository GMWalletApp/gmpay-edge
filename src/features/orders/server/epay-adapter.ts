import { z } from "zod";
import {
	authenticateEpayParameters,
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
import {
	gmpayCreateResponse,
	gmpayError,
	gmpayOrderError,
	gmpayOrderMessage,
	logMerchantApiFailure,
} from "#/features/orders/server/gmpay-api";
import { type ApiOrder, getOrder } from "#/features/orders/server/query";
import { requestId as getRequestId } from "#/server/http";

const epayAssetNetworkType = /^([a-z0-9_-]{2,20})\.([a-z0-9-]{2,32})$/;

const epayInputSchema = z
	.object({
		pid: z.union([z.string(), z.number()]).transform(String),
		money: z.union([z.string(), z.number()]).transform(String),
		out_trade_no: z.string().trim().min(1).max(128),
		notify_url: z.string().trim().url(),
		return_url: z.string().trim().url().optional(),
		name: z.string().trim().max(500).optional(),
		type: z
			.string()
			.trim()
			.toLowerCase()
			.refine((value) => value === "alipay" || epayAssetNetworkType.test(value))
			.optional(),
		param: z.string().max(500).optional(),
		clientip: z.string().max(64).optional(),
		device: z.string().max(64).optional(),
		sign: z
			.string()
			.trim()
			.regex(/^[0-9a-f]{32}$/),
		sign_type: z.string().trim().toUpperCase().optional(),
	})
	.catchall(z.string().max(500));

const epayQuerySchema = z
	.object({
		act: z.literal("order"),
		pid: z.string().trim().min(1).max(128),
		trade_no: z.string().trim().min(1).max(128).optional(),
		out_trade_no: z.string().trim().min(1).max(128).optional(),
		sign: z
			.string()
			.trim()
			.regex(/^[0-9a-f]{32}$/),
		sign_type: z.string().trim().toUpperCase().optional(),
	})
	.catchall(z.string().max(500))
	.refine(
		(value) => Boolean(value.trade_no) !== Boolean(value.out_trade_no),
		"Exactly one order selector is required",
	);

export type EpayInput = z.infer<typeof epayInputSchema>;

export async function readEpayParameters(request: Request) {
	const parameters = Object.fromEntries(new URL(request.url).searchParams);
	if (request.method === "POST") {
		const contentType =
			request.headers.get("content-type")?.toLowerCase() ?? "";
		if (!contentType.includes("application/x-www-form-urlencoded"))
			return undefined;
		for (const [key, value] of new URLSearchParams(await request.text()))
			parameters[key] = value;
	}
	return parameters;
}

export function parseEpayInput(value: unknown) {
	return epayInputSchema.safeParse(value);
}

export async function authenticateEpayInput(db: D1Database, input: EpayInput) {
	return authenticateEpayParameters(db, input, "orders:create");
}

export function toEpayOrderInput(input: EpayInput): CreateOrderInput {
	const selection = epaySelection(input.type);
	return createOrderSchema.parse({
		externalOrderId: input.out_trade_no,
		amount: input.money,
		currency: "CNY",
		paymentAsset: selection?.asset,
		paymentNetwork: selection?.network,
		description: input.name || undefined,
		returnUrl: epayReturnUrl(input.return_url, input.param),
		notifyUrl: input.notify_url,
		metadata: {
			integration: "epay",
			epayType: input.type || "alipay",
			...(input.param ? { epayParam: input.param } : {}),
		},
	});
}

export function epaySelection(value: string | undefined) {
	if (!value || value === "alipay") return null;
	const match = value.match(epayAssetNetworkType);
	if (!match) throw new Error("Unsupported EPay payment type");
	const [, asset, network] = match;
	if (!(asset && network)) throw new Error("Unsupported EPay payment type");
	return { asset: asset.toUpperCase(), network: network.toLowerCase() };
}

function epayReturnUrl(value: string | undefined, param: string | undefined) {
	if (!value) return undefined;
	if (!param) return value;
	const url = new URL(value);
	url.searchParams.set("param", param);
	return url.toString();
}

type OrderCreator = (
	db: D1Database,
	input: CreateOrderInput,
	requestUrl: string,
	context: OrderCreationContext,
) => Promise<ApiOrder>;

export async function handleEpayCreateRequest(
	request: Request,
	env: Pick<Env, "DB">,
	create: OrderCreator = createOrder,
	responseMode: "gateway" | "mapi" = "gateway",
) {
	const requestId = getRequestId(request);
	try {
		const parsed = parseEpayInput(await readEpayParameters(request));
		if (!parsed.success)
			return epayErrorResponse(
				gmpayError(requestId, 10009, "invalid parameters"),
				400,
				responseMode,
			);
		const principal = await authenticateEpayInput(env.DB, parsed.data);
		if (!principal)
			return epayErrorResponse(
				gmpayError(requestId, 401, "signature verification failed"),
				401,
				responseMode,
			);
		const order = await create(
			env.DB,
			toEpayOrderInput(parsed.data),
			request.url,
			{
				apiKeyId: principal.apiKeyId,
				apiProtocol: "epay",
			},
		);
		return epayCreateResponse(order, parsed.data, requestId, responseMode);
	} catch (error) {
		if (error instanceof GmpayRateLimitError)
			return epayErrorResponse(
				gmpayError(requestId, 429, "API rate limit exceeded"),
				429,
				responseMode,
			);
		if (error instanceof OrderServiceError)
			return epayErrorResponse(
				gmpayError(requestId, gmpayOrderError(error), gmpayOrderMessage(error)),
				error.status >= 500 ? error.status : 400,
				responseMode,
			);
		logMerchantApiFailure("epay.create", requestId);
		return epayErrorResponse(
			gmpayError(requestId, 500, "system error"),
			500,
			responseMode,
		);
	}
}

export function handleEpayMApiRequest(request: Request, env: Pick<Env, "DB">) {
	return handleEpayCreateRequest(request, env, createOrder, "mapi");
}

export async function handleEpayQueryRequest(
	request: Request,
	env: Pick<Env, "DB">,
	findOrder = getOrder,
) {
	const requestId = getRequestId(request);
	try {
		const parsed = epayQuerySchema.safeParse(
			Object.fromEntries(new URL(request.url).searchParams),
		);
		if (!parsed.success)
			return epayJson({ code: -1, msg: "invalid parameters" }, 400, requestId);
		const principal = await authenticateEpayParameters(
			env.DB,
			parsed.data,
			"orders:read",
		);
		if (!principal)
			return epayJson(
				{ code: -1, msg: "signature verification failed" },
				401,
				requestId,
			);
		const order = await findOrder(
			env.DB,
			parsed.data.trade_no
				? { id: parsed.data.trade_no, apiKeyId: principal.apiKeyId }
				: {
						externalOrderId: parsed.data.out_trade_no as string,
						apiKeyId: principal.apiKeyId,
					},
			request.url,
		);
		if (!order)
			return epayJson({ code: -1, msg: "order not found" }, 404, requestId);
		const tradeStatus = epayTradeStatus(order.status);
		return epayJson(
			{
				code: 1,
				msg: "success",
				trade_no: order.orderId,
				out_trade_no: order.externalOrderId,
				type: order.metadata?.epayType ?? "alipay",
				name: order.description ?? order.externalOrderId,
				money: order.amount,
				status: tradeStatus === "TRADE_SUCCESS" ? 1 : 0,
				trade_status: tradeStatus,
				param: order.metadata?.epayParam ?? "",
			},
			200,
			requestId,
		);
	} catch (error) {
		if (error instanceof GmpayRateLimitError)
			return epayJson(
				{ code: -1, msg: "API rate limit exceeded" },
				429,
				requestId,
			);
		logMerchantApiFailure("epay.query", requestId);
		return epayJson({ code: -1, msg: "system error" }, 500, requestId);
	}
}

function epayCreateResponse(
	order: ApiOrder,
	input: EpayInput,
	requestId: string,
	mode: "gateway" | "mapi",
) {
	if (mode === "gateway")
		return epayJson(gmpayCreateResponse(order, requestId), 200, requestId);
	return epayJson(
		{
			code: 1,
			msg: "success",
			trade_no: order.orderId,
			payurl: order.checkoutUrl,
			qrcode: order.checkoutUrl,
			img: order.checkoutUrl,
			param: input.param ?? "",
		},
		200,
		requestId,
	);
}

function epayErrorResponse(
	body: ReturnType<typeof gmpayError>,
	status: number,
	mode: "gateway" | "mapi",
) {
	return mode === "gateway"
		? epayJson(body, status, body.request_id)
		: epayJson({ code: -1, msg: body.message }, status, body.request_id);
}

function epayJson(body: object, status: number, requestId: string) {
	return Response.json(body, {
		status,
		headers: {
			"cache-control": "no-store",
			"x-request-id": requestId,
		},
	});
}

function epayTradeStatus(status: string) {
	if (status === "paid" || status === "overpaid") return "TRADE_SUCCESS";
	if (status === "refunded") return "TRADE_REFUNDED";
	if (status === "cancelled" || status === "expired" || status === "failed")
		return "TRADE_CLOSED";
	return "WAIT_BUYER_PAY";
}
