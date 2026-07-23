import {
	signEpayParameters,
	signGmpayParameters,
} from "#/features/api-keys/server/gmpay-signature";
import type {
	WebhookDeliveryRequest,
	WebhookRequestSnapshot,
} from "#/features/webhooks/types";
export interface WebhookDeliveryResult {
	success: boolean;
	status?: number;
	durationMs: number;
	errorCode?: string;
	responseExcerpt?: string;
	requestSnapshot?: WebhookRequestSnapshot;
	/** Minimum delay requested by the receiver, capped to the local retry window. */
	retryAfterMs?: number;
}

export function retryDelayMs(attempt: number): number {
	return Math.min(3_600_000, 2 ** Math.max(0, attempt - 1) * 15_000);
}

export async function deliverWebhook(
	message: WebhookDeliveryRequest,
	fetcher: typeof fetch = fetch,
	timeoutMs = 10_000,
): Promise<WebhookDeliveryResult> {
	const bodyParameters =
		message.protocol === "gmpay"
			? {
					...message.gmpay,
					signature: signGmpayParameters(message.gmpay, message.secret),
				}
			: message.payload;
	const body = JSON.stringify(bodyParameters);
	const epay =
		message.protocol === "epay"
			? {
					...message.epay,
					sign: signEpayParameters(message.epay, message.secret),
					sign_type: "MD5",
				}
			: null;
	const started = Date.now();
	const headers = {
		"content-type": "application/json",
		"user-agent": "GMPay-Edge/1.0",
		"powered-by": "GMPay Edge",
		"x-gmpay-event-id": message.eventId,
		"x-gmpay-delivery-id": message.deliveryId,
	};
	const requestSnapshot: WebhookRequestSnapshot = epay
		? {
				method: "GET",
				url: message.url,
				headers,
				body: null,
				query: { ...epay, sign: "[REDACTED]" },
			}
		: {
				method: "POST",
				url: message.url,
				headers,
				body: { ...bodyParameters, signature: "[REDACTED]" },
				query: null,
			};
	try {
		const url = epay ? withSearchParameters(message.url, epay) : message.url;
		const response = await fetcher(url, {
			method: epay ? "GET" : "POST",
			headers,
			...(epay ? {} : { body }),
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
		const excerpt = await readResponseExcerpt(response, 512);
		const acknowledgement = excerpt.trim().toLowerCase();
		const success =
			response.status === 200 &&
			(acknowledgement === "ok" ||
				(message.protocol === "epay" && acknowledgement === "success"));
		const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
		return {
			success,
			status: response.status,
			durationMs: Date.now() - started,
			requestSnapshot,
			...(excerpt ? { responseExcerpt: excerpt } : {}),
			...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			...(success
				? {}
				: {
						errorCode: response.ok ? "invalid_acknowledgement" : "http_error",
					}),
		};
	} catch (error) {
		return {
			success: false,
			durationMs: Date.now() - started,
			requestSnapshot,
			errorCode:
				error instanceof DOMException && error.name === "TimeoutError"
					? "timeout"
					: "network_error",
		};
	}
}

export function parseRetryAfter(value: string | null, now = Date.now()) {
	if (!value) return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	const numeric = /^-?\d+(?:\.\d+)?$/.test(normalized);
	if (numeric && Number(normalized) < 0) return undefined;
	const milliseconds = numeric
		? Number(normalized) * 1_000
		: Date.parse(normalized) - now;
	if (!Number.isFinite(milliseconds)) return undefined;
	return Math.min(3_600_000, Math.max(0, Math.round(milliseconds)));
}

function withSearchParameters(url: string, parameters: Record<string, string>) {
	const target = new URL(url);
	for (const [key, value] of Object.entries(parameters))
		target.searchParams.set(key, value);
	return target.toString();
}

async function readResponseExcerpt(response: Response, maxBytes: number) {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (length < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			const remaining = maxBytes - length;
			const chunk = value.subarray(0, remaining);
			chunks.push(chunk);
			length += chunk.byteLength;
			if (chunk.byteLength < value.byteLength) break;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}
