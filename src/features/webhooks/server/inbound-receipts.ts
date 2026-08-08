export const inboundWebhookEndpoints = [
	{
		id: "inbound-okpay-notify",
		code: "okpay.notify",
		name: "OKPay payment notification",
		path: "/api/providers/okpay/notify",
		handler: "okpay.notify",
		kind: "provider" as const,
	},
	{
		id: "inbound-alchemy-address-activity",
		code: "alchemy.address_activity",
		name: "Alchemy address activity",
		path: "/api/providers/alchemy/:sourceId",
		handler: "alchemy.address_activity",
		kind: "provider" as const,
	},
	{
		id: "inbound-telegram-webhook",
		code: "telegram.update",
		name: "Telegram bot update",
		path: "/api/telegram/:botId/webhook",
		handler: "telegram.update",
		kind: "telegram" as const,
	},
] as const;

export const inboundWebhookCatalogEndpoints = inboundWebhookEndpoints;

export type InboundSignatureStatus =
	| "valid"
	| "invalid"
	| "not_applicable"
	| "unknown";

export async function recordInboundWebhookReceipt(
	db: D1Database,
	input: {
		endpointCode: string;
		request: Request;
		startedAt: number;
		responseStatus: number;
		signatureStatus: InboundSignatureStatus;
		errorCode?: string;
	},
) {
	const endpoint = inboundWebhookEndpoints.find(
		(candidate) => candidate.code === input.endpointCode,
	);
	if (!endpoint) return;
	const now = Date.now();
	const receiptId = crypto.randomUUID();
	const externalRequestId = input.request.headers.get("x-request-id");
	const processingStatus =
		input.responseStatus >= 500
			? "failed"
			: input.responseStatus >= 400
				? "rejected"
				: "succeeded";
	await db
		.prepare(
			`INSERT INTO inbound_webhook_receipts
			(id, endpoint_code, request_id, external_request_id, method, request_path, signature_status,
			 processing_status, response_status, duration_ms, error_code, received_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			receiptId,
			endpoint.code,
			receiptId,
			externalRequestId,
			input.request.method,
			new URL(input.request.url).pathname,
			input.signatureStatus,
			processingStatus,
			input.responseStatus,
			Math.max(0, now - input.startedAt),
			input.errorCode ?? null,
			now,
		)
		.run();
}
