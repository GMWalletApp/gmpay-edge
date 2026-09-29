import { requestId } from "#/server/http";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";

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

export type InboundWebhookRateLimit = Awaited<
	ReturnType<typeof claimFixedWindowRateLimit>
>;

const INBOUND_REQUESTS_PER_MINUTE = 600;
// Unauthenticated rejections are stored only for the first requests of a
// client window; later ones are visible through the rate-limit counter alone.
const REJECTED_RECEIPTS_PER_WINDOW = 20;

/**
 * Claims the per-endpoint, per-client budget before any receipt write or
 * expensive work. The client address header is authoritative on Cloudflare and
 * set by the Bun request adapter.
 */
export function claimInboundWebhookRateLimit(
	db: D1Database,
	endpointCode: string,
	request: Request,
	now?: number,
) {
	const address = request.headers.get("cf-connecting-ip");
	const client =
		address && /^[0-9A-Fa-f.:]{1,45}$/.test(address) ? address : "unknown";
	return claimFixedWindowRateLimit(db, {
		bucketKey: `inbound:${endpointCode}:${client}`,
		limit: INBOUND_REQUESTS_PER_MINUTE,
		windowMs: 60_000,
		...(now === undefined ? {} : { now }),
	});
}

export async function recordInboundWebhookReceipt(
	db: D1Database,
	input: {
		endpointCode: string;
		request: Request;
		startedAt: number;
		responseStatus: number;
		signatureStatus: InboundSignatureStatus;
		errorCode?: string;
		/** When present, unauthenticated 4xx outcomes are sampled per client window. */
		rate?: InboundWebhookRateLimit;
	},
) {
	const endpoint = inboundWebhookEndpoints.find(
		(candidate) => candidate.code === input.endpointCode,
	);
	if (!endpoint) return;
	const authenticated = input.signatureStatus === "valid";
	if (
		input.rate &&
		!authenticated &&
		input.responseStatus < 500 &&
		(!input.rate.allowed || input.rate.count > REJECTED_RECEIPTS_PER_WINDOW)
	)
		return;
	const now = Date.now();
	const receiptId = crypto.randomUUID();
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
			// The validated identifier echoed in the `x-request-id` response header.
			requestId(input.request),
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
