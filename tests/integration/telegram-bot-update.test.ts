import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	defaultTelegramNotificationTranslations,
	reconcileTelegramDefaults,
} from "#/features/telegram/defaults";
import { deleteTelegramBot } from "#/features/telegram/server/delete";
import {
	syncAllTelegramCommandCatalogs,
	syncTelegramCommandCatalog,
} from "#/features/telegram/server/sync-commands";
import {
	createTelegramBot,
	setTelegramBotEnabled,
	updateTelegramBot,
} from "#/features/telegram/server/update-bot";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

describe("Telegram bot updates", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const configSecret = "telegram-config-secret-with-enough-entropy";

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-telegram-bot-update" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await reconcileTelegramDefaults(db, 1);
		await db.batch([
			db.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at) VALUES ('actor', 'Root', 'root@example.com', 1, 1, 1, 1)",
			),
			db
				.prepare(
					"INSERT INTO telegram_bots (id, name, token_encrypted, webhook_secret_encrypted, username, enabled, created_at, updated_at) VALUES ('bot', 'Primary', ?, ?, 'old_bot', 1, 1, 1)",
				)
				.bind(
					await encryptSecret(
						"100:old-token-value-with-enough-length",
						configSecret,
					),
					await encryptSecret("telegram-webhook-secret", configSecret),
				),
			db
				.prepare(
					"INSERT INTO telegram_notification_bindings (id, bot_id, template_translations, name, target_type, target_id, locale, events, enabled, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 'bot', ?, 'User', 'private', '100', 'en-US', '[]', 1, 1, 1)",
				)
				.bind(JSON.stringify(defaultTelegramNotificationTranslations)),
		]);
	});

	afterEach(() => vi.unstubAllGlobals());
	afterAll(async () => miniflare.dispose());

	it("reconciles missing public defaults without overwriting edits", async () => {
		await db
			.prepare(
				`UPDATE system_settings
				 SET value = json_set(value, '$."en-US"', 'Operator template')
				 WHERE key = 'telegram.default_template_translations'`,
			)
			.run();
		await db
			.prepare(
				`UPDATE system_settings
				 SET value = json_remove(value, '$."ja-JP"')
				 WHERE key = 'telegram.default_template_translations'`,
			)
			.run();
		await db
			.prepare(
				"UPDATE telegram_bot_commands SET description_en_us = 'Operator command' WHERE command = 'start' AND scope = 'default'",
			)
			.run();
		await reconcileTelegramDefaults(db, 2);
		await reconcileTelegramDefaults(db, 3);
		const state = await db
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM telegram_bot_commands) AS commands,
				 (SELECT COUNT(*) FROM telegram_bot_commands, json_each(template_translations)) AS translations,
				 (SELECT json_extract(value, '$."en-US"') FROM system_settings WHERE key='telegram.default_template_translations') AS content,
				 (SELECT json_extract(value, '$."ja-JP"') FROM system_settings WHERE key='telegram.default_template_translations') AS japanese_content,
				 (SELECT description_en_us FROM telegram_bot_commands WHERE command='start' AND scope='default') AS description`,
			)
			.first<{
				commands: number;
				translations: number;
				content: string;
				japanese_content: string;
				description: string;
			}>();
		expect(state).toEqual({
			commands: 4,
			translations: 24,
			content: "Operator template",
			japanese_content: defaultTelegramNotificationTranslations["ja-JP"],
			description: "Operator command",
		});
	});

	it("renames a bot without reading or replacing its token", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const before = await readBot(db);
		await expect(
			updateTelegramBot(db, {
				id: "bot",
				name: "Renamed",
				configSecret,
				baseUrl: "https://pay.example",
				actorUserId: "actor",
				now: 2,
			}),
		).resolves.toMatchObject({ tokenChanged: false });
		const after = await readBot(db);
		expect(after).toMatchObject({ name: "Renamed", username: "old_bot" });
		expect(after?.token_encrypted).toBe(before?.token_encrypted);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("validates and switches an enabled bot before persisting the token", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ ok: true, result: { username: "new_bot" } }),
			)
			.mockResolvedValueOnce(Response.json({ ok: true, result: true }))
			.mockResolvedValueOnce(Response.json({ ok: true, result: true }));
		vi.stubGlobal("fetch", fetchMock);
		const token = "200:new-token-value-with-enough-length";
		await expect(
			updateTelegramBot(db, {
				id: "bot",
				name: "Replacement",
				token,
				configSecret,
				baseUrl: "https://pay.example",
				actorUserId: "actor",
				requestId: "telegram-update-request",
				ipAddress: "203.0.113.40",
				now: 3,
			}),
		).resolves.toMatchObject({
			username: "new_bot",
			tokenChanged: true,
			oldWebhookRemoved: true,
		});
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			`/bot${token}/getMe`,
		);
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
			`/bot${token}/setWebhook`,
		);
		expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
			"/bot100:old-token-value-with-enough-length/deleteWebhook",
		);
		const bot = await readBot(db);
		await expect(
			decryptSecret(bot?.token_encrypted ?? "", configSecret),
		).resolves.toBe(token);
		expect(bot).toMatchObject({ name: "Replacement", username: "new_bot" });
		const binding = await db
			.prepare(
				"SELECT bot_id FROM telegram_notification_bindings WHERE target_id = '100'",
			)
			.first<{ bot_id: string }>();
		expect(binding?.bot_id).toBe("bot");

		const audit = await db
			.prepare(
				"SELECT request_id, ip_address, after FROM audit_logs WHERE action = 'telegram_bot.updated' AND created_at = 3",
			)
			.first<{ request_id: string; ip_address: string; after: string }>();
		expect(audit).toMatchObject({
			request_id: "telegram-update-request",
			ip_address: "203.0.113.40",
		});
		expect(JSON.parse(audit?.after ?? "null")).toMatchObject({
			username: "new_bot",
			tokenChanged: true,
		});
		expect(audit?.after).not.toContain(token);
	});

	it("does not mutate D1 when Telegram rejects the replacement token", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve(
						Response.json(
							{ ok: false, error_code: 401, description: "Unauthorized" },
							{ status: 401 },
						),
					),
				),
		);
		const before = await readBot(db);
		await expect(
			updateTelegramBot(db, {
				id: "bot",
				name: "Must not persist",
				token: "300:invalid-token-value-with-enough-length",
				configSecret,
				baseUrl: "https://pay.example",
				actorUserId: "actor",
			}),
		).rejects.toMatchObject({ code: "telegram_token_invalid", status: 400 });
		expect(await readBot(db)).toEqual(before);
	});

	it("does not persist an enabled bot when Telegram rejects its webhook", async () => {
		const token = "400:create-token-value-with-enough-length";
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ ok: true, result: { username: "create_bot" } }),
			)
			.mockResolvedValueOnce(
				Response.json(
					{ ok: false, description: "Webhook rejected" },
					{ status: 400 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createTelegramBot(db, {
				id: "create-failed",
				name: "Failed create",
				token,
				enabled: true,
				configSecret,
				baseUrl: "https://pay.example",
				actorUserId: "actor",
			}),
		).rejects.toMatchObject({ code: "telegram_api_rejected", status: 502 });
		const persisted = await db
			.prepare(
				"SELECT (SELECT COUNT(*) FROM telegram_bots WHERE id = 'create-failed') AS bots, (SELECT COUNT(*) FROM audit_logs WHERE target_id = 'create-failed') AS audits",
			)
			.first<{ bots: number; audits: number }>();
		expect(persisted).toEqual({ bots: 0, audits: 0 });
	});

	it("rejects a second row for a Bot username that is already configured", async () => {
		const configured = (await readBot(db))?.username;
		expect(configured).toBeTruthy();
		const fetchMock = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(
					Response.json({ ok: true, result: { username: configured } }),
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createTelegramBot(db, {
				id: "duplicate-username",
				name: "Duplicate username",
				token: "600:duplicate-username-token-with-enough-length",
				enabled: true,
				configSecret,
				baseUrl: "https://pay.example",
				actorUserId: "actor",
			}),
		).rejects.toMatchObject({ code: "telegram_bot_exists", status: 409 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/getMe");
		await expect(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM telegram_bots WHERE username = ?",
				)
				.bind(configured)
				.first<{ count: number }>(),
		).resolves.toEqual({ count: 1 });
	});

	it("reports an unreachable Telegram Bot API with a stable code", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("fetch failed")),
		);
		await expect(
			createTelegramBot(db, {
				id: "unreachable",
				name: "Unreachable",
				token: "700:unreachable-token-value-with-enough-length",
				enabled: false,
				configSecret,
				baseUrl: "https://pay.example",
				actorUserId: "actor",
			}),
		).rejects.toMatchObject({ code: "telegram_unreachable", status: 504 });
	});

	it("does not copy or modify the public catalogs when creating a bot", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json({ ok: true, result: { username: "defaults_bot" } }),
				),
		);
		await createTelegramBot(db, {
			id: "bot-with-defaults",
			name: "Defaults",
			token: "450:create-token-value-with-enough-length",
			enabled: false,
			configSecret,
			baseUrl: "https://pay.example",
			actorUserId: "actor",
		});
		const defaults = await db
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM telegram_bot_commands) AS commands,
				 (SELECT COUNT(*) FROM telegram_bot_commands, json_each(template_translations)) AS translations,
				 (SELECT COUNT(DISTINCT key) FROM telegram_bot_commands, json_each(template_translations)) AS locales`,
			)
			.first<{
				commands: number;
				translations: number;
				locales: number;
			}>();
		expect(defaults).toEqual({
			commands: 4,
			translations: 24,
			locales: 6,
		});
	});

	it("synchronizes enabled commands for every Telegram scope and locale", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockImplementation(() =>
				Promise.resolve(Response.json({ ok: true, result: true })),
			);
		await expect(
			syncTelegramCommandCatalog(
				db,
				"bot-with-defaults",
				configSecret,
				request,
			),
		).resolves.toEqual({ synced: 24 });
		expect(request).toHaveBeenCalledTimes(24);
		const bodies = request.mock.calls.map(([, init]) =>
			JSON.parse(String(init?.body)),
		);
		expect(bodies).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					scope: { type: "default" },
					commands: expect.arrayContaining([
						expect.objectContaining({ command: "start" }),
					]),
				}),
				expect.objectContaining({
					language_code: "en",
					scope: { type: "default" },
					commands: expect.arrayContaining([
						expect.objectContaining({ command: "start" }),
					]),
				}),
				expect.objectContaining({ language_code: "zh" }),
				expect.objectContaining({ language_code: "ja" }),
				expect.objectContaining({ language_code: "ko" }),
				expect.objectContaining({ language_code: "ru" }),
			]),
		);
		expect(
			bodies.some(
				(body) => body.scope?.type === "default" && !("language_code" in body),
			),
		).toBe(true);
	});

	it("synchronizes the same public command catalog to every bot", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockImplementation(() =>
				Promise.resolve(Response.json({ ok: true, result: true })),
			);
		const result = await syncAllTelegramCommandCatalogs(
			db,
			configSecret,
			request,
		);
		expect(result.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ botId: "bot", ok: true, synced: 24 }),
				expect.objectContaining({
					botId: "bot-with-defaults",
					ok: true,
					synced: 24,
				}),
			]),
		);
		expect(request).toHaveBeenCalledTimes(result.results.length * 24);
	});

	it("reports each Bot independently when one command sync fails", async () => {
		const request = vi.fn<typeof fetch>((input) =>
			String(input).includes("450:create-token")
				? Promise.reject(new TypeError("first bot unavailable"))
				: Promise.resolve(Response.json({ ok: true, result: true })),
		);
		const result = await syncAllTelegramCommandCatalogs(
			db,
			configSecret,
			request,
		);
		expect(result.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					botId: "bot-with-defaults",
					ok: false,
					errorCode: "telegram_command_sync_failed",
				}),
				expect.objectContaining({ botId: "bot", ok: true, synced: 24 }),
			]),
		);
		expect(request).toHaveBeenCalledTimes(25);
	});

	it("does not return Telegram API error details from bulk synchronization", async () => {
		const result = await syncAllTelegramCommandCatalogs(
			db,
			configSecret,
			vi
				.fn<typeof fetch>()
				.mockRejectedValue(
					new Error("GrammyError: token=secret-bot-token HTTP 401"),
				),
		);

		expect(result.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ok: false,
					errorCode: "telegram_command_sync_failed",
				}),
			]),
		);
		expect(JSON.stringify(result)).not.toMatch(
			/secret-bot-token|GrammyError|401/,
		);
	});

	it("returns a stable code when the Bot no longer exists", async () => {
		await expect(
			updateTelegramBot(db, {
				id: "missing",
				name: "Missing",
				configSecret,
				baseUrl: "https://pay.example",
				actorUserId: "actor",
			}),
		).rejects.toMatchObject({ code: "telegram_bot_not_found", status: 404 });
	});

	it("keeps instance command and default notification content when a bot is deleted", async () => {
		const audit = (actorUserId: string) =>
			db
				.prepare(
					"INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, 'telegram_bot.deleted', 'telegram_bot', 'bot-with-defaults', 5)",
				)
				.bind(crypto.randomUUID(), actorUserId);
		// The delete and its audit commit together: a failing audit keeps the row.
		await expect(
			deleteTelegramBot(db, "bot-with-defaults", audit("missing-actor")),
		).rejects.toThrow();
		await expect(
			db
				.prepare("SELECT id FROM telegram_bots WHERE id = 'bot-with-defaults'")
				.first(),
		).resolves.toEqual({ id: "bot-with-defaults" });
		await expect(
			deleteTelegramBot(db, "bot-with-defaults", audit("actor")),
		).resolves.toEqual({ id: "bot-with-defaults" });
		await expect(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'telegram_bot.deleted' AND target_id = 'bot-with-defaults'",
				)
				.first<{ count: number }>(),
		).resolves.toEqual({ count: 1 });
		const catalogs = await db
			.prepare(
				"SELECT (SELECT COUNT(*) FROM telegram_bot_commands) AS commands, (SELECT COUNT(*) FROM system_settings WHERE key = 'telegram.default_template_translations') AS defaults",
			)
			.first<{ commands: number; defaults: number }>();
		expect(catalogs).toEqual({ commands: 4, defaults: 1 });
	});

	it("removes the external webhook if the atomic D1 create fails", async () => {
		const token = "500:duplicate-create-token-with-enough-length";
		const before = await readBot(db);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ ok: true, result: { username: "duplicate_bot" } }),
			)
			.mockResolvedValueOnce(Response.json({ ok: true, result: true }))
			.mockResolvedValueOnce(Response.json({ ok: true, result: true }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createTelegramBot(db, {
				id: "bot",
				name: "Duplicate",
				token,
				enabled: true,
				configSecret,
				baseUrl: "https://pay.example",
				actorUserId: "actor",
			}),
		).rejects.toThrow();
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
			`bot${token}/setWebhook`,
		);
		expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
			`bot${token}/deleteWebhook`,
		);
		expect(await readBot(db)).toEqual(before);
	});

	it("does not call Telegram or audit an idempotent enabled-state request", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			setTelegramBotEnabled(db, {
				id: "bot",
				enabled: true,
				configSecret,
				baseUrl: "https://pay.example",
				actorUserId: "actor",
			}),
		).resolves.toEqual({ id: "bot", enabled: true, changed: false });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("restores the external webhook when the D1 enabled-state commit fails", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ ok: true, result: true }))
			.mockResolvedValueOnce(Response.json({ ok: true, result: true }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			setTelegramBotEnabled(db, {
				id: "bot",
				enabled: false,
				configSecret,
				baseUrl: "https://pay.example",
				actorUserId: "missing-actor",
			}),
		).rejects.toThrow();
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/deleteWebhook");
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/setWebhook");
		expect(await readBot(db)).toMatchObject({ enabled: 1 });
	});

	it("commits a Webhook disable and its audit together", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(Response.json({ ok: true, result: true }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			setTelegramBotEnabled(db, {
				id: "bot",
				enabled: false,
				configSecret,
				baseUrl: "https://pay.example",
				actorUserId: "actor",
				requestId: "disable-request",
				ipAddress: "203.0.113.41",
				now: 4,
			}),
		).resolves.toEqual({ id: "bot", enabled: false, changed: true });
		expect(await readBot(db)).toMatchObject({ enabled: 0, updated_at: 4 });
		const audit = await db
			.prepare(
				"SELECT request_id, ip_address, before, after FROM audit_logs WHERE action = 'telegram_bot.enabled_changed' AND created_at = 4",
			)
			.first<{
				request_id: string;
				ip_address: string;
				before: string;
				after: string;
			}>();
		expect(audit).toMatchObject({
			request_id: "disable-request",
			ip_address: "203.0.113.41",
		});
		expect(JSON.parse(audit?.before ?? "null")).toEqual({ enabled: true });
		expect(JSON.parse(audit?.after ?? "null")).toEqual({ enabled: false });
	});
});

function readBot(db: D1Database) {
	return db
		.prepare(
			"SELECT name, username, token_encrypted, enabled, updated_at FROM telegram_bots WHERE id = 'bot'",
		)
		.first<{
			name: string;
			username: string | null;
			token_encrypted: string;
			enabled: number;
			updated_at: number;
		}>();
}
