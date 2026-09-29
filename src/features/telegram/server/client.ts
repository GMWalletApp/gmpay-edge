import { Api, GrammyError, HttpError } from "grammy";
import { DomainError } from "#/lib/domain-error";

export const telegramRequestTimeoutMs = 8_000;

export function createTelegramApi(
	token: string,
	request: typeof fetch = fetch,
	environment: "prod" | "test" = "prod",
) {
	return new Api(token, {
		fetch: request,
		timeoutSeconds: telegramRequestTimeoutMs / 1000,
		sensitiveLogs: false,
		environment,
	});
}

/**
 * Telegram rejections that have a defined recovery. Descriptions are matched
 * once here and never retained, so callers branch on stable codes only.
 */
type TelegramApiRejection = "blocked_by_user" | "parse_entities";

export class TelegramApiRequestError extends Error {
	readonly code: "api_rejected" | "transport_error" | "request_failed";
	/** Telegram `error_code` when the Bot API answered with `ok: false`. */
	readonly status?: number;
	/** Flood-control wait requested by Telegram on HTTP 429. */
	readonly retryAfterMs?: number;
	readonly rejection?: TelegramApiRejection;

	constructor(error: unknown) {
		super("Telegram Bot API request failed");
		this.name = "TelegramApiRequestError";
		if (error instanceof GrammyError) {
			this.code = "api_rejected";
			this.status = error.error_code;
			const retryAfter = error.parameters?.retry_after;
			if (error.error_code === 429 && typeof retryAfter === "number")
				this.retryAfterMs = retryAfter * 1000;
			const rejection = classifyRejection(error.error_code, error.description);
			if (rejection) this.rejection = rejection;
			return;
		}
		this.code =
			error instanceof HttpError ? "transport_error" : "request_failed";
	}

	/**
	 * A 4xx other than flood control never succeeds on redelivery; retrying it
	 * only queues the chat's later updates behind a failing one.
	 */
	get permanent() {
		return (
			this.code === "api_rejected" &&
			this.status !== undefined &&
			this.status >= 400 &&
			this.status < 500 &&
			this.status !== 429
		);
	}
}

export function telegramErrorCode(error: unknown) {
	if (!(error instanceof TelegramApiRequestError))
		return "telegram_processing_failed";
	return error.status === undefined
		? `telegram_${error.code}`
		: `telegram_${error.code}_${error.status}`;
}

/**
 * Raw Bot API call with the project timeout. A Markdown template that Telegram
 * cannot parse is re-sent once as plain text so operator typos never block a
 * notification or command reply.
 */
export async function callTelegramApi(
	token: string,
	method: string,
	payload: Record<string, unknown>,
) {
	const raw = createTelegramApi(token).raw[
		method as keyof Api["raw"]
	] as unknown as (
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<unknown>;
	try {
		return await raw(payload, AbortSignal.timeout(telegramRequestTimeoutMs));
	} catch (error) {
		const failure = new TelegramApiRequestError(error);
		if (failure.rejection !== "parse_entities" || !("parse_mode" in payload))
			throw failure;
		const { parse_mode: _parseMode, ...plain } = payload;
		try {
			return await raw(plain, AbortSignal.timeout(telegramRequestTimeoutMs));
		} catch (retryError) {
			throw new TelegramApiRequestError(retryError);
		}
	}
}

/**
 * Administrative flows (getMe, setWebhook, deleteWebhook) surface Telegram
 * outcomes as structured codes; grammY payloads never reach the client.
 */
export function telegramAdminError(error: unknown): unknown {
	if (error instanceof GrammyError)
		return error.error_code === 401 || error.error_code === 404
			? new DomainError(
					"telegram_token_invalid",
					400,
					"Telegram rejected the Bot token",
				)
			: new DomainError(
					"telegram_api_rejected",
					502,
					"Telegram rejected the request",
				);
	if (error instanceof HttpError)
		return new DomainError(
			"telegram_unreachable",
			504,
			"Telegram Bot API is unreachable",
		);
	return error;
}

function classifyRejection(
	status: number,
	description: string,
): TelegramApiRejection | undefined {
	if (
		status === 403 &&
		/bot was blocked by the user|user is deactivated/i.test(description)
	)
		return "blocked_by_user";
	if (status === 400 && /can't parse entities/i.test(description))
		return "parse_entities";
	return undefined;
}
