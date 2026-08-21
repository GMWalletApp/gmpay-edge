import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import {
	emailChannelEnabledSchema,
	emailChannelOrderSchema,
	emailChannelSchema,
} from "#/features/settings/email-channels";
import { settingsAdminContext } from "#/features/settings/server/admin-context";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { createAuditStatement } from "#/server/audit";
import { getRuntimeEnv } from "#/server/db.server";
import { sendConfiguredEmail } from "#/server/runtime/email-mail";
import { loadRuntimeConfig } from "#/server/runtime-config";

type EmailChannelRow = {
	id: string;
	name: string;
	provider: z.infer<typeof emailChannelSchema>["provider"];
	credential_encrypted: string | null;
	domain: string | null;
	region: "us" | "eu";
	smtp_host: string | null;
	smtp_port: number | null;
	smtp_user: string | null;
	from_address: string;
	reply_to: string | null;
	sort_order: number;
	enabled: number;
	created_at: number;
	updated_at: number;
};

export const listEmailChannelsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const context = await settingsAdminContext(
			systemPermission("settings", "read"),
		);
		const { db } = context;
		const rows = await db
			.prepare(
				`SELECT id, name, provider, credential_encrypted, domain, region,
				 smtp_host, smtp_port, smtp_user, from_address, reply_to, sort_order,
				 enabled, created_at, updated_at
				 FROM email_channel_configs ORDER BY sort_order, id`,
			)
			.all<EmailChannelRow>();
		const encrypted = rows.results.some((row) => row.credential_encrypted);
		const secret = encrypted
			? (await loadRuntimeConfig(db)).integrationConfigSecret
			: "";
		const channels = await Promise.all(
			rows.results.map(async (row) => ({
				id: row.id,
				name: row.name,
				provider: row.provider,
				credential:
					row.credential_encrypted && secret
						? await decryptSecret(row.credential_encrypted, secret)
						: "",
				domain: row.domain ?? "",
				region: row.region,
				smtpHost: row.smtp_host ?? "",
				smtpPort: row.smtp_port ?? 587,
				smtpUser: row.smtp_user ?? "",
				fromAddress: row.from_address,
				replyTo: row.reply_to ?? "",
				sortOrder: row.sort_order,
				enabled: Boolean(row.enabled),
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			})),
		);
		return {
			channels,
		};
	},
);

export const saveEmailChannelFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof emailChannelSchema>) =>
		emailChannelSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await settingsAdminContext(
			systemPermission("settings", "update"),
		);
		const existing = await context.db
			.prepare(
				"SELECT id, name, provider, enabled FROM email_channel_configs WHERE id = ? LIMIT 1",
			)
			.bind(data.id ?? "")
			.first<{ id: string; name: string; provider: string; enabled: number }>();
		const conflict = await context.db
			.prepare(
				"SELECT id FROM email_channel_configs WHERE name = ? AND (? IS NULL OR id <> ?) LIMIT 1",
			)
			.bind(data.name, data.id ?? null, data.id ?? null)
			.first<{ id: string }>();
		if (conflict)
			throw new DomainError(
				"email_channel_conflict",
				409,
				"Email channel name already exists",
			);
		const credentialEncrypted = await encryptedCredential(context.db, data);
		const id = data.id ?? crypto.randomUUID();
		const now = Date.now();
		const values = [
			data.name,
			data.provider,
			credentialEncrypted,
			data.provider === "mailgun" ? data.domain : null,
			data.provider === "mailgun" ? data.region : "us",
			data.provider === "smtp" ? data.smtpHost : null,
			data.provider === "smtp" ? data.smtpPort : null,
			data.provider === "smtp" ? data.smtpUser || null : null,
			data.fromAddress,
			data.replyTo || null,
			data.sortOrder,
			data.enabled ? 1 : 0,
		] as const;
		const mutation = existing
			? context.db
					.prepare(
						`UPDATE email_channel_configs SET name = ?, provider = ?,
						 credential_encrypted = ?, domain = ?, region = ?, smtp_host = ?,
						 smtp_port = ?, smtp_user = ?, from_address = ?, reply_to = ?,
						 sort_order = ?, enabled = ?, updated_at = ? WHERE id = ?`,
					)
					.bind(...values, now, id)
			: context.db
					.prepare(
						`INSERT INTO email_channel_configs
						 (id, name, provider, credential_encrypted, domain, region, smtp_host,
						  smtp_port, smtp_user, from_address, reply_to, sort_order, enabled,
						  created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(id, ...values, now, now);
		await context.db.batch([
			mutation,
			createAuditStatement(context.db, context.request, context.user.id, {
				action: "email_channel.saved",
				targetType: "email_channel",
				targetId: id,
				before: existing
					? {
							name: existing.name,
							provider: existing.provider,
							enabled: Boolean(existing.enabled),
						}
					: null,
				after: {
					name: data.name,
					provider: data.provider,
					enabled: data.enabled,
					credentialChanged: Boolean(data.credential),
				},
			}),
		]);
		return { id };
	});

export const setEmailChannelEnabledFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof emailChannelEnabledSchema>) =>
		emailChannelEnabledSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await settingsAdminContext(
			systemPermission("settings", "update"),
		);
		const channel = await context.db
			.prepare(
				"SELECT name, provider, enabled FROM email_channel_configs WHERE id = ? LIMIT 1",
			)
			.bind(data.id)
			.first<{ name: string; provider: string; enabled: number }>();
		if (!channel) throw emailChannelNotFound();
		await context.db.batch([
			context.db
				.prepare(
					"UPDATE email_channel_configs SET enabled = ?, updated_at = ? WHERE id = ?",
				)
				.bind(data.enabled ? 1 : 0, Date.now(), data.id),
			createAuditStatement(context.db, context.request, context.user.id, {
				action: "email_channel.enabled",
				targetType: "email_channel",
				targetId: data.id,
				before: { enabled: Boolean(channel.enabled) },
				after: {
					name: channel.name,
					provider: channel.provider,
					enabled: data.enabled,
				},
			}),
		]);
		return { id: data.id, enabled: data.enabled };
	});

export const reorderEmailChannelsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof emailChannelOrderSchema>) =>
		emailChannelOrderSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await settingsAdminContext(
			systemPermission("settings", "update"),
		);
		const rows = await context.db
			.prepare("SELECT id FROM email_channel_configs")
			.all<{ id: string }>();
		if (
			rows.results.length !== data.ids.length ||
			rows.results.some((row) => !data.ids.includes(row.id))
		)
			throw new DomainError(
				"email_channel_order_invalid",
				400,
				"Email channel order must include every channel",
			);
		const now = Date.now();
		await context.db.batch([
			...data.ids.map((id, index) =>
				context.db
					.prepare(
						"UPDATE email_channel_configs SET sort_order = ?, updated_at = ? WHERE id = ?",
					)
					.bind((index + 1) * 100, now, id),
			),
			createAuditStatement(context.db, context.request, context.user.id, {
				action: "email_channel.reordered",
				targetType: "email_channel",
				before: null,
				after: { ids: data.ids },
			}),
		]);
		return { reordered: data.ids };
	});

const testEmailSchema = z.object({
	channelId: z.string().uuid().nullable(),
	recipient: z.email().max(320),
});

export const sendTestEmailFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof testEmailSchema>) =>
		testEmailSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await settingsAdminContext(
			systemPermission("settings", "update"),
		);
		const runtime = getRuntimeEnv(context.request);
		if (data.channelId) await assertChannelExists(context.db, data.channelId);
		await sendConfiguredEmail(
			context.db,
			runtime.EMAIL,
			{
				to: data.recipient,
				subject: "GMPay Edge email delivery test",
				text: "This message confirms that the selected email channel can deliver mail.",
			},
			data.channelId ?? undefined,
		);
		await createAuditStatement(context.db, context.request, context.user.id, {
			action: "email_channel.tested",
			targetType: "email_channel",
			targetId: data.channelId ?? undefined,
			before: null,
			after: { fallback: data.channelId === null },
		}).run();
		return { sent: true };
	});

async function encryptedCredential(
	db: D1Database,
	data: z.infer<typeof emailChannelSchema>,
) {
	if (data.provider === "cloudflare_email" || !data.credential) return null;
	const secret = (await loadRuntimeConfig(db)).integrationConfigSecret;
	if (!secret)
		throw new DomainError(
			"email_credential_encryption_unavailable",
			503,
			"Email credential encryption is unavailable",
		);
	return encryptSecret(data.credential, secret);
}

async function assertChannelExists(db: D1Database, id: string) {
	const row = await db
		.prepare("SELECT provider FROM email_channel_configs WHERE id = ? LIMIT 1")
		.bind(id)
		.first<{ provider: string }>();
	if (!row) throw emailChannelNotFound();
}

function emailChannelNotFound() {
	return new DomainError(
		"email_channel_not_found",
		404,
		"Email channel not found",
	);
}
