import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { telegramTemplateTranslationsInput } from "#/features/telegram/schema";
import {
	telegramAdminContext,
	telegramAuditStatement,
} from "#/features/telegram/server/admin-context";
import {
	requireTelegramResource,
	requireTelegramResourceAvailable,
} from "#/features/telegram/server/resource-errors";
import { syncAllTelegramCommandCatalogs } from "#/features/telegram/server/sync-commands";
import { parseTelegramTemplateTranslations } from "#/features/telegram/template-translations";
import type { SupportedLocale } from "#/lib/locales";

export type TelegramCommandRecord = {
	id: string;
	command: string;
	descriptionEnUs: string;
	descriptionJaJp: string;
	descriptionKoKr: string;
	descriptionRuRu: string;
	descriptionZhTw: string;
	descriptionZhCn: string;
	templateTranslations: Record<SupportedLocale, string>;
	scope: "default" | "private" | "group" | "admin";
	sortOrder: number;
	enabled: boolean;
	createdAt: string;
};

type TelegramCommandRow = {
	id: string;
	command: string;
	description_en_us: string;
	description_ja_jp: string;
	description_ko_kr: string;
	description_ru_ru: string;
	description_zh_tw: string;
	description_zh_cn: string;
	template_translations: unknown;
	scope: "default" | "private" | "group" | "admin";
	sort_order: number;
	enabled: number;
	created_at: number;
};

const listCommandsInput = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(100).default(10),
	search: z.string().trim().max(200).default(""),
	beforeCreatedAt: z.number().int().positive(),
});

export const listTelegramCommandsFn = createServerFn({ method: "GET" })
	.validator((input) => listCommandsInput.parse(input))
	.handler(async ({ data }) => {
		const { db } = await telegramAdminContext(
			systemPermission("telegram", "read"),
		);
		const search = data.search ? `%${data.search}%` : null;
		const where = search
			? "WHERE created_at <= ? AND command LIKE ?"
			: "WHERE created_at <= ?";
		const parameters = search
			? [data.beforeCreatedAt, search]
			: [data.beforeCreatedAt];
		const [countResult, commandsResult, botsResult] = await db.batch([
			db
				.prepare(`SELECT COUNT(*) AS total FROM telegram_bot_commands ${where}`)
				.bind(...parameters),
			db
				.prepare(`SELECT id, command, description_en_us, description_ja_jp,
						description_ko_kr, description_ru_ru, description_zh_tw,
						description_zh_cn, template_translations, scope, sort_order,
						enabled, created_at FROM telegram_bot_commands ${where}
						ORDER BY scope, sort_order, command LIMIT ? OFFSET ?`)
				.bind(...parameters, data.pageSize, data.pageIndex * data.pageSize),
			db.prepare("SELECT COUNT(*) AS total FROM telegram_bots"),
		]);
		return {
			data: (commandsResult as D1Result<TelegramCommandRow>).results.map(
				commandRecord,
			),
			total:
				(countResult?.results[0] as { total: number } | undefined)?.total ?? 0,
			botCount:
				(botsResult?.results[0] as { total: number } | undefined)?.total ?? 0,
		};
	});

const commandInput = z.object({
	command: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^[a-z0-9_]{1,32}$/),
	descriptionEnUs: z.string().trim().min(1).max(256),
	descriptionJaJp: z.string().trim().min(1).max(256),
	descriptionKoKr: z.string().trim().min(1).max(256),
	descriptionRuRu: z.string().trim().min(1).max(256),
	descriptionZhTw: z.string().trim().min(1).max(256),
	descriptionZhCn: z.string().trim().min(1).max(256),
	templateTranslations: telegramTemplateTranslationsInput,
	scope: z.enum(["default", "private", "group", "admin"]),
	sortOrder: z.number().int().min(0).max(10_000),
});

export const createTelegramCommandFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof commandInput>) => commandInput.parse(input))
	.handler(async ({ data }) => {
		const context = await telegramAdminContext(
			systemPermission("telegram", "create"),
		);
		await requireCommandAvailable(context.db, data.command, data.scope);
		const id = crypto.randomUUID();
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare(`INSERT INTO telegram_bot_commands
					(id, command, description_en_us, description_ja_jp,
					description_ko_kr, description_ru_ru, description_zh_tw,
					description_zh_cn, handler_type, template_translations, scope, sort_order,
					enabled, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'template', ?, ?, ?, 1, ?, ?)`)
				.bind(
					id,
					data.command,
					data.descriptionEnUs,
					data.descriptionJaJp,
					data.descriptionKoKr,
					data.descriptionRuRu,
					data.descriptionZhTw,
					data.descriptionZhCn,
					JSON.stringify(data.templateTranslations),
					data.scope,
					data.sortOrder,
					now,
					now,
				),
			telegramAuditStatement(
				context,
				"telegram_command.created",
				"telegram_bot_command",
				id,
				{ ...data, templateTranslations: "[REDACTED]" },
				now,
			),
		]);
		return {
			id,
			...(await syncAllTelegramCommandCatalogs(
				context.db,
				context.runtime.integrationConfigSecret,
			)),
		};
	});

const commandUpdateInput = commandInput.extend({ id: z.uuid() });

export const updateTelegramCommandFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof commandUpdateInput>) =>
		commandUpdateInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await telegramAdminContext(
			systemPermission("telegram", "update"),
		);
		await requireCommand(context.db, data.id);
		await requireCommandAvailable(
			context.db,
			data.command,
			data.scope,
			data.id,
		);
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare(`UPDATE telegram_bot_commands SET
					command = ?, description_en_us = ?, description_ja_jp = ?,
					description_ko_kr = ?, description_ru_ru = ?, description_zh_tw = ?,
					description_zh_cn = ?, template_translations = ?, scope = ?,
					sort_order = ?, updated_at = ? WHERE id = ?`)
				.bind(
					data.command,
					data.descriptionEnUs,
					data.descriptionJaJp,
					data.descriptionKoKr,
					data.descriptionRuRu,
					data.descriptionZhTw,
					data.descriptionZhCn,
					JSON.stringify(data.templateTranslations),
					data.scope,
					data.sortOrder,
					now,
					data.id,
				),
			telegramAuditStatement(
				context,
				"telegram_command.updated",
				"telegram_bot_command",
				data.id,
				{ ...data, templateTranslations: "[REDACTED]" },
				now,
			),
		]);
		return {
			id: data.id,
			...(await syncAllTelegramCommandCatalogs(
				context.db,
				context.runtime.integrationConfigSecret,
			)),
		};
	});

const commandStateInput = z.object({
	id: z.uuid(),
	enabled: z.boolean(),
});

export const setTelegramCommandEnabledFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof commandStateInput>) =>
		commandStateInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await telegramAdminContext(
			systemPermission("telegram", "update"),
		);
		await requireCommand(context.db, data.id);
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare(
					"UPDATE telegram_bot_commands SET enabled = ?, updated_at = ? WHERE id = ?",
				)
				.bind(data.enabled, now, data.id),
			telegramAuditStatement(
				context,
				"telegram_command.enabled_changed",
				"telegram_command",
				data.id,
				{ enabled: data.enabled },
				now,
			),
		]);
		return data;
	});

const commandIdInput = z.object({ id: z.uuid() });

export const deleteTelegramCommandFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof commandIdInput>) =>
		commandIdInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await telegramAdminContext(
			systemPermission("telegram", "delete"),
		);
		await requireCommand(context.db, data.id);
		await context.db.batch([
			context.db
				.prepare("DELETE FROM telegram_bot_commands WHERE id = ?")
				.bind(data.id),
			telegramAuditStatement(
				context,
				"telegram_command.deleted",
				"telegram_bot_command",
				data.id,
				null,
			),
		]);
		return data;
	});

export const syncTelegramCommandsFn = createServerFn({
	method: "POST",
}).handler(async () => {
	const context = await telegramAdminContext(
		systemPermission("telegram", "update"),
	);
	return syncAllTelegramCommandCatalogs(
		context.db,
		context.runtime.integrationConfigSecret,
	);
});

function commandRecord(row: TelegramCommandRow): TelegramCommandRecord {
	return {
		id: row.id,
		command: row.command,
		descriptionEnUs: row.description_en_us,
		descriptionJaJp: row.description_ja_jp,
		descriptionKoKr: row.description_ko_kr,
		descriptionRuRu: row.description_ru_ru,
		descriptionZhTw: row.description_zh_tw,
		descriptionZhCn: row.description_zh_cn,
		templateTranslations: parseTelegramTemplateTranslations(
			row.template_translations,
		),
		scope: row.scope,
		sortOrder: row.sort_order,
		enabled: Boolean(row.enabled),
		createdAt: new Date(row.created_at).toISOString(),
	};
}

async function requireCommand(db: D1Database, id: string) {
	const command = await db
		.prepare("SELECT id FROM telegram_bot_commands WHERE id = ? LIMIT 1")
		.bind(id)
		.first<{ id: string }>();
	return requireTelegramResource(command, "command");
}

async function requireCommandAvailable(
	db: D1Database,
	command: string,
	scope: string,
	excludeId?: string,
) {
	const existing = await db
		.prepare(
			excludeId
				? "SELECT id FROM telegram_bot_commands WHERE command = ? AND scope = ? AND id <> ? LIMIT 1"
				: "SELECT id FROM telegram_bot_commands WHERE command = ? AND scope = ? LIMIT 1",
		)
		.bind(...(excludeId ? [command, scope, excludeId] : [command, scope]))
		.first<{ id: string }>();
	requireTelegramResourceAvailable(existing, "command");
}
