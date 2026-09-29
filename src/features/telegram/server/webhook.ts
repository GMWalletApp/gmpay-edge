import { z } from "zod";
import {
	TelegramApiRequestError,
	telegramErrorCode,
} from "#/features/telegram/server/client";
import { processTelegramUpdate } from "#/features/telegram/server/inline";
import {
	parseTelegramUpdate,
	type TelegramUpdateInput,
} from "#/features/telegram/server/update-schema";
import { recordInboundWebhookReceipt } from "#/features/webhooks/server/inbound-receipts";
import { constantTimeEqual, sha256Hex } from "#/lib/crypto";
import { decryptSecret } from "#/lib/secrets";
import { json, withRequestId } from "#/server/http";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import {
	RequestBodyTooLargeError,
	readLimitedRequestBytes,
} from "#/server/request-body";
import { loadRuntimeConfig } from "#/server/runtime-config";

const maximumUpdateBytes = 256 * 1024;
const maximumUpdatesPerBotPerMinute = 600;
const maximumRequestsPerAddressPerMinute = 1_800;
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function handleTelegramWebhookRequest(
	request: Request,
	botIdInput: string,
	env: Env,
) {
	const startedAt = Date.now();
	const respond = (body: unknown, status = 200) =>
		withRequestId(request, json(body, { status }));
	// Malformed, unknown, and disabled Bot ids share one answer and persist
	// nothing: receipts and existence are reserved for rate-limited callers.
	const parsedBotId = z.uuid().safeParse(botIdInput);
	if (!parsedBotId.success) return respond({ error: "not_found" }, 404);
	const botId = parsedBotId.data;
	const [addressRate, bot] = await Promise.all([
		claimFixedWindowRateLimit(env.DB, {
			bucketKey: `telegram:address:${await sha256Hex(
				request.headers.get("cf-connecting-ip") ?? "unknown",
			)}`,
			limit: maximumRequestsPerAddressPerMinute,
			windowMs: 60_000,
		}),
		env.DB.prepare(
			"SELECT token_encrypted, webhook_secret_encrypted FROM telegram_bots WHERE id = ? AND enabled = 1 LIMIT 1",
		)
			.bind(botId)
			.first<{
				token_encrypted: string;
				webhook_secret_encrypted: string;
			}>(),
	]);
	if (!addressRate.allowed) return respond({ error: "rate_limited" }, 429);
	if (!bot) return respond({ error: "not_found" }, 404);
	// Receipts for secret mismatches are sampled per client window like the
	// other inbound endpoints; authenticated outcomes are always recorded.
	const finish = async (
		response: Response,
		signatureStatus: "valid" | "invalid",
		errorCode?: string,
	) => {
		await recordInboundWebhookReceipt(env.DB, {
			endpointCode: "telegram.update",
			request,
			startedAt,
			responseStatus: response.status,
			signatureStatus,
			rate: addressRate,
			...(errorCode ? { errorCode } : {}),
		});
		return response;
	};
	const [botRate, runtime] = await Promise.all([
		claimFixedWindowRateLimit(env.DB, {
			bucketKey: `telegram:bot:${botId}`,
			limit: maximumUpdatesPerBotPerMinute,
			windowMs: 60_000,
		}),
		loadRuntimeConfig(env.DB),
	]);
	if (!botRate.allowed) return respond({ error: "rate_limited" }, 429);
	const expectedSecret = await decryptSecret(
		bot.webhook_secret_encrypted,
		runtime.integrationConfigSecret,
	);
	if (
		!constantTimeEqual(
			request.headers.get("x-telegram-bot-api-secret-token") ?? "",
			expectedSecret,
		)
	)
		return finish(
			respond({ error: "invalid_secret" }, 401),
			"invalid",
			"invalid_secret",
		);
	let update: TelegramUpdateInput;
	try {
		const body = await readLimitedRequestBytes(request, maximumUpdateBytes);
		const parsed = parseTelegramUpdate(JSON.parse(decoder.decode(body)));
		if (!parsed.success) throw parsed.error;
		update = parsed.data;
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError)
			return finish(
				respond({ error: "payload_too_large" }, 413),
				"valid",
				"payload_too_large",
			);
		return finish(
			respond({ error: "invalid_update" }, 400),
			"valid",
			"invalid_update",
		);
	}
	const token = await decryptSecret(
		bot.token_encrypted,
		runtime.integrationConfigSecret,
	);
	try {
		await processTelegramUpdate({
			db: env.DB,
			botId,
			token,
			baseUrl: runtime.betterAuthUrl || new URL(request.url).origin,
			paymentQueue: env.PAYMENT_QUEUE,
			update,
		});
	} catch (error) {
		const errorCode = telegramErrorCode(error);
		console.error(
			JSON.stringify({ event: "telegram_update_failed", botId, errorCode }),
		);
		// Telegram redelivers every non-2xx answer; a permanent rejection is
		// acknowledged so it cannot queue the chat's later updates behind it.
		if (error instanceof TelegramApiRequestError && error.permanent)
			return finish(respond({ ok: true }), "valid", errorCode);
		return finish(
			respond(
				{ error: "telegram_processing_failed" },
				error instanceof TelegramApiRequestError ? 502 : 500,
			),
			"valid",
			errorCode,
		);
	}
	return finish(respond({ ok: true }), "valid");
}
