import { z } from "zod";
import { TelegramApiRequestError } from "#/features/telegram/server/client";
import { processTelegramUpdate } from "#/features/telegram/server/inline";
import {
	parseTelegramUpdate,
	type TelegramUpdateInput,
} from "#/features/telegram/server/update-schema";
import { recordInboundWebhookReceipt } from "#/features/webhooks/server/inbound-receipts";
import { constantTimeEqual } from "#/lib/crypto";
import { decryptSecret } from "#/lib/secrets";
import { json, withRequestId } from "#/server/http";
import { loadRuntimeConfig } from "#/server/runtime-config";

export async function handleTelegramWebhookRequest(
	request: Request,
	botIdInput: string,
	env: Env,
) {
	const startedAt = Date.now();
	const finish = async (
		response: Response,
		signatureStatus: "valid" | "invalid" | "unknown",
		errorCode?: string,
	) => {
		await recordInboundWebhookReceipt(env.DB, {
			endpointCode: "telegram.update",
			request,
			startedAt,
			responseStatus: response.status,
			signatureStatus,
			...(errorCode ? { errorCode } : {}),
		});
		return response;
	};
	const parsedBotId = z.uuid().safeParse(botIdInput);
	if (!parsedBotId.success)
		return finish(
			withRequestId(
				request,
				json({ error: "invalid_bot_id" }, { status: 400 }),
			),
			"unknown",
			"invalid_bot_id",
		);
	const botId = parsedBotId.data;
	const bot = await env.DB.prepare(
		"SELECT token_encrypted, webhook_secret_encrypted FROM telegram_bots WHERE id = ? AND enabled = 1 LIMIT 1",
	)
		.bind(botId)
		.first<{
			token_encrypted: string;
			webhook_secret_encrypted: string;
		}>();
	if (!bot)
		return finish(
			withRequestId(request, json({ error: "not_found" }, { status: 404 })),
			"unknown",
			"bot_not_found",
		);
	const runtime = await loadRuntimeConfig(env.DB);
	const [token, expectedSecret] = await Promise.all([
		decryptSecret(bot.token_encrypted, runtime.integrationConfigSecret),
		decryptSecret(
			bot.webhook_secret_encrypted,
			runtime.integrationConfigSecret,
		),
	]);
	if (
		!constantTimeEqual(
			request.headers.get("x-telegram-bot-api-secret-token") ?? "",
			expectedSecret,
		)
	)
		return finish(
			withRequestId(
				request,
				json({ error: "invalid_secret" }, { status: 401 }),
			),
			"invalid",
			"invalid_secret",
		);
	let update: TelegramUpdateInput;
	try {
		const value: unknown = await request.json();
		const parsed = parseTelegramUpdate(value);
		if (!parsed.success) throw parsed.error;
		update = parsed.data;
	} catch {
		return finish(
			withRequestId(
				request,
				json({ error: "invalid_update" }, { status: 400 }),
			),
			"valid",
			"invalid_update",
		);
	}
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
		const errorCode =
			error instanceof TelegramApiRequestError
				? `telegram_${error.code}`
				: "telegram_processing_failed";
		console.error(
			JSON.stringify({ event: "telegram_update_failed", botId, errorCode }),
		);
		return finish(
			withRequestId(
				request,
				json(
					{ error: "telegram_processing_failed" },
					{ status: error instanceof TelegramApiRequestError ? 502 : 500 },
				),
			),
			"valid",
			errorCode,
		);
	}
	return finish(withRequestId(request, json({ ok: true })), "valid");
}
