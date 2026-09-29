import {
	createTelegramApi,
	telegramAdminError,
} from "#/features/telegram/server/client";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { redactAuditValue } from "#/server/audit-redaction";

export async function createTelegramBot(
	db: D1Database,
	input: {
		name: string;
		token: string;
		enabled: boolean;
		configSecret: string;
		baseUrl: string;
		actorUserId: string;
		requestId?: string | null;
		ipAddress?: string | null;
		id?: string;
		now?: number;
	},
) {
	const identity = await fetchTelegramIdentity(input.token);
	await requireTelegramUsernameAvailable(db, identity.username);
	const id = input.id ?? crypto.randomUUID();
	const webhookSecret = generateWebhookSecret();
	const now = input.now ?? Date.now();
	const [encryptedToken, encryptedWebhookSecret] = await Promise.all([
		encryptSecret(input.token, input.configSecret),
		encryptSecret(webhookSecret, input.configSecret),
	]);
	if (input.enabled)
		await configureTelegramWebhook(
			input.token,
			telegramWebhookUrl(input.baseUrl, id),
			webhookSecret,
		);
	try {
		await db.batch([
			db
				.prepare(
					"INSERT INTO telegram_bots (id, name, token_encrypted, webhook_secret_encrypted, username, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(
					id,
					input.name,
					encryptedToken,
					encryptedWebhookSecret,
					identity.username,
					input.enabled,
					now,
					now,
				),
			db
				.prepare(
					`INSERT INTO audit_logs
					 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
					 VALUES (?, ?, 'telegram_bot.created', 'telegram_bot', ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					input.actorUserId,
					id,
					input.requestId ?? null,
					input.ipAddress ?? null,
					JSON.stringify({
						name: input.name,
						username: identity.username,
						enabled: input.enabled,
					}),
					now,
				),
		]);
	} catch (error) {
		if (input.enabled)
			await configureTelegramWebhook(input.token, null, webhookSecret).catch(
				() => undefined,
			);
		throw error;
	}
	return { id, username: identity.username };
}

export async function updateTelegramBot(
	db: D1Database,
	input: {
		id: string;
		name: string;
		token?: string;
		configSecret: string;
		baseUrl: string;
		actorUserId: string;
		requestId?: string | null;
		ipAddress?: string | null;
		now?: number;
	},
) {
	const current = await db
		.prepare(
			"SELECT token_encrypted, webhook_secret_encrypted, username, enabled FROM telegram_bots WHERE id = ? LIMIT 1",
		)
		.bind(input.id)
		.first<{
			token_encrypted: string;
			webhook_secret_encrypted: string;
			username: string | null;
			enabled: number;
		}>();
	if (!current)
		throw new DomainError(
			"telegram_bot_not_found",
			404,
			"Telegram bot not found",
		);

	const tokenChanged = Boolean(input.token);
	let username = current.username;
	let encryptedToken = current.token_encrypted;
	let oldToken: string | null = null;
	let webhookSecret: string | null = null;
	if (input.token) {
		username = (await fetchTelegramIdentity(input.token)).username;
		await requireTelegramUsernameAvailable(db, username, input.id);
		[oldToken, webhookSecret] = await Promise.all([
			decryptSecret(current.token_encrypted, input.configSecret),
			decryptSecret(current.webhook_secret_encrypted, input.configSecret),
		]);
		if (current.enabled)
			await configureTelegramWebhook(
				input.token,
				telegramWebhookUrl(input.baseUrl, input.id),
				webhookSecret,
			);
		encryptedToken = await encryptSecret(input.token, input.configSecret);
	}

	const now = input.now ?? Date.now();
	try {
		await db.batch([
			db
				.prepare(
					"UPDATE telegram_bots SET name = ?, token_encrypted = ?, username = ?, updated_at = ? WHERE id = ?",
				)
				.bind(input.name, encryptedToken, username, now, input.id),
			db
				.prepare(
					`INSERT INTO audit_logs
					(id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
					VALUES (?, ?, 'telegram_bot.updated', 'telegram_bot', ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					input.actorUserId,
					input.id,
					input.requestId ?? null,
					input.ipAddress ?? null,
					JSON.stringify(
						redactAuditValue({
							name: input.name,
							username,
							tokenChanged,
						}),
					),
					now,
				),
		]);
	} catch (error) {
		if (input.token && current.enabled && webhookSecret)
			await configureTelegramWebhook(input.token, null, webhookSecret).catch(
				() => undefined,
			);
		throw error;
	}

	let oldWebhookRemoved = true;
	if (tokenChanged && current.enabled && oldToken && webhookSecret) {
		oldWebhookRemoved = await configureTelegramWebhook(
			oldToken,
			null,
			webhookSecret,
		).then(
			() => true,
			() => false,
		);
	}
	return {
		id: input.id,
		username,
		tokenChanged,
		oldWebhookRemoved,
	};
}

export async function setTelegramBotEnabled(
	db: D1Database,
	input: {
		id: string;
		enabled: boolean;
		configSecret: string;
		baseUrl: string;
		actorUserId: string;
		requestId?: string | null;
		ipAddress?: string | null;
		now?: number;
	},
) {
	const current = await db
		.prepare(
			"SELECT token_encrypted, webhook_secret_encrypted, enabled FROM telegram_bots WHERE id = ? LIMIT 1",
		)
		.bind(input.id)
		.first<{
			token_encrypted: string;
			webhook_secret_encrypted: string;
			enabled: number;
		}>();
	if (!current)
		throw new DomainError(
			"telegram_bot_not_found",
			404,
			"Telegram bot not found",
		);
	const wasEnabled = Boolean(current.enabled);
	if (wasEnabled === input.enabled)
		return { id: input.id, enabled: input.enabled, changed: false };
	const [token, webhookSecret] = await Promise.all([
		decryptSecret(current.token_encrypted, input.configSecret),
		decryptSecret(current.webhook_secret_encrypted, input.configSecret),
	]);
	await configureTelegramWebhook(
		token,
		input.enabled ? telegramWebhookUrl(input.baseUrl, input.id) : null,
		webhookSecret,
	);
	const now = input.now ?? Date.now();
	try {
		await db.batch([
			db
				.prepare(
					"UPDATE telegram_bots SET enabled = ?, updated_at = ? WHERE id = ? AND enabled = ?",
				)
				.bind(input.enabled, now, input.id, wasEnabled),
			db
				.prepare(
					`INSERT INTO audit_logs
					 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, before, after, created_at)
					 SELECT ?, ?, 'telegram_bot.enabled_changed', 'telegram_bot', ?, ?, ?, ?, ?, ?
					 WHERE EXISTS (SELECT 1 FROM telegram_bots WHERE id = ? AND enabled = ?)`,
				)
				.bind(
					crypto.randomUUID(),
					input.actorUserId,
					input.id,
					input.requestId ?? null,
					input.ipAddress ?? null,
					JSON.stringify({ enabled: wasEnabled }),
					JSON.stringify({ enabled: input.enabled }),
					now,
					input.id,
					input.enabled,
				),
		]);
	} catch (error) {
		await configureTelegramWebhook(
			token,
			wasEnabled ? telegramWebhookUrl(input.baseUrl, input.id) : null,
			webhookSecret,
		).catch(() => undefined);
		throw error;
	}
	return { id: input.id, enabled: input.enabled, changed: true };
}

export async function fetchTelegramIdentity(token: string) {
	try {
		const identity = await createTelegramApi(token).getMe();
		return { username: identity.username ?? null };
	} catch (error) {
		throw telegramAdminError(error);
	}
}

async function configureTelegramWebhook(
	token: string,
	url: string | null,
	secretToken: string,
) {
	const api = createTelegramApi(token);
	try {
		if (url) {
			await api.setWebhook(url, {
				secret_token: secretToken,
				allowed_updates: [
					"message",
					"inline_query",
					"chosen_inline_result",
					"callback_query",
					"my_chat_member",
				],
			});
			return;
		}
		await api.deleteWebhook({ drop_pending_updates: false });
	} catch (error) {
		throw telegramAdminError(error);
	}
}

/**
 * One Telegram Bot must map to one row: a second row for the same token would
 * silently take over its webhook. Usernames are Telegram-unique, so they stand
 * in for the never-stored plaintext token.
 */
async function requireTelegramUsernameAvailable(
	db: D1Database,
	username: string | null,
	excludeId?: string,
) {
	if (!username) return;
	const existing = await db
		.prepare(
			"SELECT id FROM telegram_bots WHERE username = ? AND id <> ? LIMIT 1",
		)
		.bind(username, excludeId ?? "")
		.first<{ id: string }>();
	if (existing)
		throw new DomainError(
			"telegram_bot_exists",
			409,
			"A Telegram bot with this username already exists",
		);
}

function telegramWebhookUrl(baseUrl: string, botId: string) {
	return new URL(`/api/telegram/${botId}/webhook`, baseUrl).toString();
}

function generateWebhookSecret() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}
