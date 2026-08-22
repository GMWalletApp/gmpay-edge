import { z } from "zod";
import { recordPaymentTransaction } from "#/features/payments/server/process";
import { recordInboundWebhookReceipt } from "#/features/webhooks/server/inbound-receipts";
import { OkPayAdapter } from "#/integrations/wallets/okpay";
import { decryptSecret } from "#/lib/secrets";
import { json, withRequestId } from "#/server/http";
import {
	RequestBodyTooLargeError,
	readLimitedRequestBytes,
} from "#/server/request-body";
import { loadRuntimeConfig } from "#/server/runtime-config";

const maximumBodyBytes = 64 * 1024;
const notificationEnvelopeSchema = z.looseObject({
	status: z.literal("success"),
	code: z.union([z.literal(200), z.literal("200")]),
	id: z.union([z.string(), z.number()]),
	sign: z.string().min(1),
});
const depositNotificationSchema = z.looseObject({
	coin: z.string().min(1),
	order_id: z.union([z.string(), z.number()]),
	status: z.union([z.literal(1), z.literal("1")]),
	type: z.literal("deposit"),
	unique_id: z.union([z.string(), z.number()]),
});

export async function handleOkPayNotification(request: Request, env: Env) {
	const startedAt = Date.now();
	const finish = async (
		response: Response,
		signatureStatus: "valid" | "invalid" | "not_applicable" | "unknown",
		errorCode?: string,
	) => {
		await recordInboundWebhookReceipt(env.DB, {
			endpointCode: "okpay.notify",
			request,
			startedAt,
			responseStatus: response.status,
			signatureStatus,
			...(errorCode ? { errorCode } : {}),
		});
		return response;
	};
	let parsed: Awaited<ReturnType<typeof parseNotification>>;
	try {
		parsed = await parseNotification(request);
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError)
			return finish(
				errorResponse(request, "payload_too_large", 413),
				"unknown",
				"payload_too_large",
			);
		throw error;
	}
	if (!parsed)
		return finish(
			errorResponse(request, "invalid_notification", 400),
			"unknown",
			"invalid_notification",
		);
	const envelope = notificationEnvelopeSchema.safeParse(parsed.input);
	const notification = depositNotificationSchema.safeParse(parsed.source);
	if (!envelope.success || !notification.success)
		return finish(
			errorResponse(request, "invalid_notification", 400),
			"unknown",
			"invalid_notification",
		);
	const { input } = parsed;
	const source = notification.data;
	const orderId = String(source.unique_id).trim();
	if (!orderId)
		return finish(
			errorResponse(request, "invalid_notification", 400),
			"unknown",
			"invalid_notification",
		);
	const row = await env.DB.prepare(
		`SELECT o.provider_order_id, rm.config_encrypted,
		 ops.target_value AS address, ops.asset_code AS code, ops.decimals
		 FROM orders o
		 JOIN order_payment_snapshots ops ON ops.order_id = o.id
		 JOIN receiving_methods rm ON rm.id = ops.receiving_method_id
		 JOIN payment_ingresses connection ON connection.id = ops.connection_id
		 WHERE o.id = ? AND ops.rail_code = 'okpay' LIMIT 1`,
	)
		.bind(orderId)
		.first<{
			provider_order_id: string | null;
			config_encrypted: string | null;
			address: string;
			code: string;
			decimals: number;
		}>();
	if (!row?.provider_order_id || !row.config_encrypted)
		return finish(
			errorResponse(request, "order_not_found", 404),
			"unknown",
			"order_not_found",
		);
	const runtime = await loadRuntimeConfig(env.DB);
	const config = JSON.parse(
		await decryptSecret(row.config_encrypted, runtime.integrationConfigSecret),
	) as Record<string, unknown>;
	const adapter = new OkPayAdapter({
		...config,
		shopId: config.shopId ?? row.address,
		assetDecimals: { [row.code]: row.decimals },
	});
	if (!adapter.verifyCallback(input))
		return finish(
			errorResponse(request, "invalid_signature", 401),
			"invalid",
			"invalid_signature",
		);
	const callback = {
		assetCode: source.coin.toUpperCase(),
		providerOrderId: String(source.order_id),
	};
	if (
		callback.providerOrderId !== row.provider_order_id ||
		callback.assetCode !== row.code
	)
		return finish(
			errorResponse(request, "payment_mismatch", 422),
			"valid",
			"payment_mismatch",
		);
	const transaction = await adapter.checkHostedPayment(row.provider_order_id);
	if (!transaction)
		return finish(
			errorResponse(request, "payment_pending", 409),
			"valid",
			"payment_pending",
		);
	await recordPaymentTransaction(env, orderId, transaction, runtime);
	return finish(withRequestId(request, json({ success: true })), "valid");
}

function errorResponse(request: Request, error: string, status: number) {
	return withRequestId(request, json({ error }, { status }));
}

async function parseNotification(request: Request): Promise<{
	input: Record<string, unknown>;
	source: Record<string, unknown>;
} | null> {
	try {
		const bytes = await readLimitedRequestBytes(request, maximumBodyBytes);
		const contentType = request.headers.get("content-type") ?? "";
		const input = request.headers
			.get("content-type")
			?.includes("application/json")
			? JSON.parse(new TextDecoder().decode(bytes))
			: parseFormData(
					await new Response(bytes.buffer, {
						headers: { "content-type": contentType },
					}).formData(),
				);
		if (!isRecord(input)) return null;
		if (!("data" in input)) return { input, source: input };
		const nested: unknown =
			typeof input.data === "string" ? JSON.parse(input.data) : input.data;
		return isRecord(nested) ? { input, source: nested } : null;
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError) throw error;
		return null;
	}
}

function parseFormData(formData: FormData) {
	const input: Record<string, string> = {};
	for (const [key, value] of formData) {
		if (typeof value !== "string") return null;
		input[key] = value;
	}
	return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
