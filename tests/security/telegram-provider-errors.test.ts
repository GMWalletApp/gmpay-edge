import { GrammyError, HttpError } from "grammy";
import { describe, expect, it } from "vitest";
import {
	TelegramApiRequestError,
	telegramAdminError,
	telegramErrorCode,
} from "#/features/telegram/server/client";

function rejection(
	status: number,
	description: string,
	parameters?: { retry_after?: number },
) {
	return new GrammyError(
		`Call to 'sendMessage' failed! (${status}: ${description})`,
		{
			ok: false,
			error_code: status,
			description,
			...(parameters ? { parameters } : {}),
		},
		"sendMessage",
		{ chat_id: 1, text: "secret order body" },
	);
}

const transportFailure = () =>
	new HttpError(
		"Network request for 'sendMessage' failed!",
		new TypeError("fetch failed"),
	);

describe("Telegram provider errors", () => {
	it("does not retain an unknown provider message", () => {
		const error = new TelegramApiRequestError(
			new Error("HTTP 401 token=secret provider body"),
		);

		expect(error).toMatchObject({
			name: "TelegramApiRequestError",
			code: "request_failed",
			message: "Telegram Bot API request failed",
		});
		expect(error.permanent).toBe(false);
		expect(JSON.stringify(error)).not.toContain("secret");
	});

	it("classifies permanent rejections without retaining descriptions or payloads", () => {
		const error = new TelegramApiRequestError(
			rejection(403, "Forbidden: bot was blocked by the user"),
		);

		expect(error).toMatchObject({
			code: "api_rejected",
			status: 403,
			rejection: "blocked_by_user",
		});
		expect(error.permanent).toBe(true);
		expect(telegramErrorCode(error)).toBe("telegram_api_rejected_403");
		expect(JSON.stringify(error)).not.toMatch(
			/blocked by the user|secret order body|sendMessage/,
		);
		expect(error.message).toBe("Telegram Bot API request failed");
	});

	it("flags unparsable templates for a plain-text retry", () => {
		const error = new TelegramApiRequestError(
			rejection(
				400,
				"Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 3",
			),
		);

		expect(error).toMatchObject({ status: 400, rejection: "parse_entities" });
		expect(error.permanent).toBe(true);
	});

	it("keeps flood control, server errors, and transport failures retryable", () => {
		const flood = new TelegramApiRequestError(
			rejection(429, "Too Many Requests: retry after 7", { retry_after: 7 }),
		);
		expect(flood).toMatchObject({ status: 429, retryAfterMs: 7_000 });
		expect(flood.permanent).toBe(false);
		expect(telegramErrorCode(flood)).toBe("telegram_api_rejected_429");

		expect(
			new TelegramApiRequestError(rejection(502, "Bad Gateway")).permanent,
		).toBe(false);

		const transport = new TelegramApiRequestError(transportFailure());
		expect(transport).toMatchObject({ code: "transport_error" });
		expect(transport.permanent).toBe(false);
		expect(telegramErrorCode(transport)).toBe("telegram_transport_error");
		expect(telegramErrorCode(new Error("D1_ERROR"))).toBe(
			"telegram_processing_failed",
		);
	});

	it("maps administrative Telegram failures to stable domain codes", () => {
		expect(telegramAdminError(rejection(401, "Unauthorized"))).toMatchObject({
			code: "telegram_token_invalid",
			status: 400,
		});
		expect(
			telegramAdminError(
				rejection(
					400,
					"Bad Request: bad webhook: HTTPS url must be provided for webhook",
				),
			),
		).toMatchObject({ code: "telegram_api_rejected", status: 502 });
		expect(telegramAdminError(transportFailure())).toMatchObject({
			code: "telegram_unreachable",
			status: 504,
		});
		const unknown = new Error("D1_ERROR");
		expect(telegramAdminError(unknown)).toBe(unknown);
		expect(
			JSON.stringify(
				telegramAdminError(rejection(400, "token=secret-bot-token")),
			),
		).not.toContain("secret-bot-token");
	});
});
