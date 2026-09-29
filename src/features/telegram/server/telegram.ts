import {
	callTelegramApi,
	TelegramApiRequestError,
	telegramErrorCode,
	telegramRequestTimeoutMs,
} from "#/features/telegram/server/client";
import { disableBlockedTelegramTarget } from "#/features/telegram/server/notification-bindings";
import {
	renderTelegramTemplate,
	telegramTemplateParseMode,
} from "#/features/telegram/template";
import { parseTelegramTemplateTranslations } from "#/features/telegram/template-translations";
import { isRecord } from "#/lib/is-record";
import type { SupportedLocale } from "#/lib/locales";
import { decryptSecret } from "#/lib/secrets";
import { m } from "#/paraglide/messages";
import { loadRuntimeConfig } from "#/server/runtime-config";

type TelegramTarget = {
	target_id: string;
	bot_id: string;
	template_translations: unknown;
	recipient_id: string;
	target_type: "private" | "group" | "channel";
	token_encrypted: string;
	locale: SupportedLocale;
	events: string;
};

type TelegramDeliveryFailure = { targetId: string; errorCode: string };

type NotifyTelegramOptions = {
	delay?: (ms: number) => Promise<void>;
	/** Flood-control retries are skipped once they could not finish by this time. */
	deadlineAt?: number;
};

const deliveryConcurrency = 4;
const maximumFloodControlRetries = 2;
/** Fits inside the Worker `waitUntil` budget together with one final request. */
const deliveryBudgetMs = 25_000;

export async function notifyTelegram(
	db: D1Database,
	eventType: string,
	payload: Record<string, unknown>,
	options: NotifyTelegramOptions = {},
) {
	const deadlineAt = options.deadlineAt ?? Date.now() + deliveryBudgetMs;
	const delay = options.delay ?? waitMs;
	const targets = await db
		.prepare(
			`SELECT target.id AS target_id, target.bot_id, target.template_translations, target.target_id AS recipient_id,
		 target.target_type, target.locale, target.events, b.token_encrypted
		 FROM telegram_notification_bindings target
		 JOIN telegram_bots b ON b.id = target.bot_id
		 WHERE b.enabled = 1 AND target.enabled = 1`,
		)
		.all<TelegramTarget>();
	const selected = targets.results.filter((target) => {
		const events = parseEvents(target.events);
		return events.includes("*") || events.includes(eventType);
	});
	if (!selected.length) return { delivered: 0, failed: 0 };
	const configSecret = (await loadRuntimeConfig(db)).integrationConfigSecret;
	if (!configSecret) return { delivered: 0, failed: 0 };
	const tokens = new Map<string, Promise<string>>();
	const tokenFor = (target: TelegramTarget) => {
		const cached = tokens.get(target.bot_id);
		if (cached) return cached;
		const token = decryptSecret(target.token_encrypted, configSecret);
		tokens.set(target.bot_id, token);
		return token;
	};
	const failures: TelegramDeliveryFailure[] = [];
	const blocked: TelegramTarget[] = [];
	await forEachWithConcurrency(
		selected,
		deliveryConcurrency,
		async (target) => {
			try {
				const template = selectTelegramTemplate(
					target.template_translations,
					target.locale,
				);
				await sendWithFloodControl(
					await tokenFor(target),
					{
						chat_id: target.recipient_id,
						text: template
							? renderTelegramTemplate(template.content, payload)
							: formatNotification(eventType, payload, target.locale),
						...(template ? { parse_mode: telegramTemplateParseMode } : {}),
					},
					{ deadlineAt, delay },
				);
			} catch (error) {
				failures.push({
					targetId: target.target_id,
					errorCode: telegramErrorCode(error),
				});
				if (
					target.target_type === "private" &&
					error instanceof TelegramApiRequestError &&
					error.rejection === "blocked_by_user"
				)
					blocked.push(target);
			}
		},
	);
	for (const target of blocked)
		await disableBlockedTelegramTarget(db, {
			botId: target.bot_id,
			targetId: target.recipient_id,
		});
	await persistTelegramDeliveryFailures(db, eventType, failures);
	return {
		delivered: selected.length - failures.length,
		failed: failures.length,
	};
}

export async function persistTelegramDeliveryFailures(
	db: D1Database,
	eventType: string,
	failures: readonly TelegramDeliveryFailure[],
) {
	if (!failures.length) return 0;
	const now = Date.now();
	await db.batch(
		failures.map(({ targetId, errorCode }) =>
			db
				.prepare(
					"INSERT INTO audit_logs (id, action, target_type, target_id, after, created_at) VALUES (?, 'telegram.delivery_failed', 'telegram_notification_target', ?, ?, ?)",
				)
				.bind(
					crypto.randomUUID(),
					targetId,
					JSON.stringify({ eventType, errorCode }),
					now,
				),
		),
	);
	return failures.length;
}

async function sendWithFloodControl(
	token: string,
	message: Record<string, unknown>,
	budget: { deadlineAt: number; delay: (ms: number) => Promise<void> },
) {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await callTelegramApi(token, "sendMessage", message);
			return;
		} catch (error) {
			const retryAfterMs =
				error instanceof TelegramApiRequestError
					? error.retryAfterMs
					: undefined;
			if (
				retryAfterMs === undefined ||
				attempt >= maximumFloodControlRetries ||
				Date.now() + retryAfterMs + telegramRequestTimeoutMs > budget.deadlineAt
			)
				throw error;
			await budget.delay(retryAfterMs);
		}
	}
}

async function forEachWithConcurrency<T>(
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<void>,
) {
	const queue = [...items];
	await Promise.all(
		Array.from({ length: Math.min(limit, queue.length) }, async () => {
			for (let item = queue.shift(); item; item = queue.shift())
				await worker(item);
		}),
	);
}

function waitMs(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function formatNotification(
	eventType: string,
	payload: Record<string, unknown>,
	locale: TelegramTarget["locale"],
) {
	const payment = isRecord(payload.payment) ? payload.payment : {};
	const options = { locale };
	return [
		`GMPay Edge · ${eventType}`,
		m.telegram_notification_order(
			{ order: String(payload.externalOrderId ?? payload.orderId ?? "—") },
			options,
		),
		m.telegram_notification_status(
			{ status: String(payload.status ?? "—") },
			options,
		),
		m.telegram_notification_amount(
			{
				amount:
					`${String(payload.amount ?? "—")} ${String(payload.currency ?? "")}`.trim(),
			},
			options,
		),
		m.telegram_notification_payment(
			{
				payment:
					`${String(payment.amount ?? "—")} ${String(payment.asset ?? "")}`.trim(),
			},
			options,
		),
	].join("\n");
}

export function selectTelegramTemplate(
	value: unknown,
	locale: TelegramTarget["locale"],
) {
	const translations = parseTelegramTemplateTranslations(value);
	const content = translations[locale] || translations["en-US"];
	return content ? { content } : undefined;
}

function parseEvents(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) &&
			parsed.every((item) => typeof item === "string")
			? parsed
			: [];
	} catch {
		return [];
	}
}
