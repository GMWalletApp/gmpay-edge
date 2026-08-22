import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import {
	telegramAdminContext,
	telegramAuditStatement,
} from "#/features/telegram/server/admin-context";
import { deleteTelegramBot } from "#/features/telegram/server/delete";
import { syncTelegramCommandCatalog } from "#/features/telegram/server/sync-commands";
import {
	createTelegramBot,
	fetchTelegramIdentity,
	setTelegramBotEnabled,
	updateTelegramBot,
} from "#/features/telegram/server/update-bot";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret } from "#/lib/secrets";

export type TelegramBotRecord = {
	id: string;
	name: string;
	username: string | null;
	enabled: boolean;
	createdAt: string;
};

type TelegramBotRow = {
	id: string;
	name: string;
	username: string | null;
	enabled: number;
	created_at: number;
};

const listBotsInput = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(100).default(10),
	search: z.string().trim().max(200).default(""),
	beforeCreatedAt: z.number().int().positive(),
});

export const listTelegramBotsFn = createServerFn({ method: "GET" })
	.validator((input) => listBotsInput.parse(input))
	.handler(async ({ data }) => {
		const { db } = await telegramAdminContext(
			systemPermission("telegram", "read"),
		);
		const search = data.search ? `%${data.search}%` : null;
		const where = search
			? "WHERE created_at <= ? AND (name LIKE ? OR username LIKE ?)"
			: "WHERE created_at <= ?";
		const parameters = search
			? [data.beforeCreatedAt, search, search]
			: [data.beforeCreatedAt];
		const [countResult, rowsResult] = await db.batch([
			db
				.prepare(`SELECT COUNT(*) AS total FROM telegram_bots ${where}`)
				.bind(...parameters),
			db
				.prepare(`SELECT id, name, username, enabled, created_at
					FROM telegram_bots ${where}
					ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
				.bind(...parameters, data.pageSize, data.pageIndex * data.pageSize),
		]);
		return {
			data: (rowsResult as D1Result<TelegramBotRow>).results.map(
				(row): TelegramBotRecord => ({
					id: row.id,
					name: row.name,
					username: row.username,
					enabled: Boolean(row.enabled),
					createdAt: new Date(row.created_at).toISOString(),
				}),
			),
			total:
				(countResult?.results[0] as { total: number } | undefined)?.total ?? 0,
		};
	});

const botInput = z.object({
	name: z.string().trim().min(2).max(80),
	token: z
		.string()
		.trim()
		.regex(/^\d+:[A-Za-z0-9_-]{20,}$/),
	enabled: z.boolean().default(false),
});

export const createTelegramBotFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof botInput>) => botInput.parse(input))
	.handler(async ({ data }) => {
		const context = await telegramAdminContext(
			systemPermission("telegram", "create"),
		);
		const bot = await createTelegramBot(context.db, {
			...data,
			configSecret: context.runtime.integrationConfigSecret,
			baseUrl: context.runtime.betterAuthUrl,
			actorUserId: context.user.id,
			requestId: context.request.headers.get("x-request-id"),
			ipAddress: context.request.headers.get("cf-connecting-ip"),
		});
		const synchronization = await syncTelegramCommandCatalog(
			context.db,
			bot.id,
			context.runtime.integrationConfigSecret,
		);
		return { ...bot, ...synchronization };
	});

const botUpdateInput = z.object({
	id: z.uuid(),
	name: z.string().trim().min(2).max(80),
	token: z
		.string()
		.trim()
		.regex(/^\d+:[A-Za-z0-9_-]{20,}$/)
		.optional(),
});

export const updateTelegramBotFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof botUpdateInput>) =>
		botUpdateInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await telegramAdminContext(
			systemPermission("telegram", "update"),
		);
		return updateTelegramBot(context.db, {
			...data,
			configSecret: context.runtime.integrationConfigSecret,
			baseUrl: context.runtime.betterAuthUrl,
			actorUserId: context.user.id,
			requestId: context.request.headers.get("x-request-id"),
			ipAddress: context.request.headers.get("cf-connecting-ip"),
		});
	});

const botAction = z.object({ id: z.uuid(), enabled: z.boolean() });

export const setTelegramBotEnabledFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof botAction>) => botAction.parse(input))
	.handler(async ({ data }) => {
		const context = await telegramAdminContext(
			systemPermission("telegram", "update"),
		);
		return setTelegramBotEnabled(context.db, {
			...data,
			configSecret: context.runtime.integrationConfigSecret,
			baseUrl: context.runtime.betterAuthUrl,
			actorUserId: context.user.id,
			requestId: context.request.headers.get("x-request-id"),
			ipAddress: context.request.headers.get("cf-connecting-ip"),
		});
	});

const botIdInput = z.object({ id: z.uuid() });

export const testTelegramBotFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof botIdInput>) => botIdInput.parse(input))
	.handler(async ({ data }) => {
		const context = await telegramAdminContext(
			systemPermission("telegram", "update"),
		);
		const bot = await context.db
			.prepare("SELECT token_encrypted FROM telegram_bots WHERE id = ?")
			.bind(data.id)
			.first<{ token_encrypted: string }>();
		if (!bot) {
			throw new DomainError(
				"telegram_bot_not_found",
				404,
				"Telegram bot not found",
			);
		}
		const identity = await fetchTelegramIdentity(
			await decryptSecret(
				bot.token_encrypted,
				context.runtime.integrationConfigSecret,
			),
		);
		return { healthy: true, username: identity.username };
	});

export const deleteTelegramBotFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof botIdInput>) => botIdInput.parse(input))
	.handler(async ({ data }) => {
		const context = await telegramAdminContext(
			systemPermission("telegram", "delete"),
		);
		await deleteTelegramBot(context.db, data.id);
		await telegramAuditStatement(
			context,
			"telegram_bot.deleted",
			"telegram_bot",
			data.id,
			null,
		).run();
		return data;
	});
