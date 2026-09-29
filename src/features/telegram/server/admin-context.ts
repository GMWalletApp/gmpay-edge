import { getRequest } from "@tanstack/react-start/server";
import { requireAdmin } from "#/features/access/server/require-admin";
import type { SystemPermission } from "#/features/access/system-rbac";
import { DomainError } from "#/lib/domain-error";
import { redactAuditValue } from "#/server/audit-redaction";
import { getCloudflareEnv } from "#/server/db.server";
import { requestId } from "#/server/http";
import { loadRequestRuntimeConfig } from "#/server/runtime-config";

export async function telegramAdminContext(permission: SystemPermission) {
	const request = getRequest();
	const user = await requireAdmin(request, permission);
	const env = getCloudflareEnv(request);
	if (!env.DB) throw new Error("D1 binding DB is unavailable");
	const runtime = await loadRequestRuntimeConfig(
		request,
		env.DB,
		new URL(request.url).origin,
	);
	if (!runtime.integrationConfigSecret) {
		throw new DomainError(
			"telegram_config_unavailable",
			503,
			"Telegram configuration is unavailable",
		);
	}
	return { db: env.DB, request, runtime, user };
}

export type TelegramAdminContext = Awaited<
	ReturnType<typeof telegramAdminContext>
>;

export function telegramAuditStatement(
	context: Pick<TelegramAdminContext, "db" | "user" | "request">,
	action: string,
	targetType: string,
	targetId: string,
	after: unknown,
	now = Date.now(),
) {
	return context.db
		.prepare(
			"INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			crypto.randomUUID(),
			context.user.id,
			action,
			targetType,
			targetId,
			requestId(context.request),
			context.request.headers.get("cf-connecting-ip"),
			after == null ? null : JSON.stringify(redactAuditValue(after)),
			now,
		);
}

export function telegramSettingUpsert(
	db: D1Database,
	key: string,
	value: unknown,
	userId: string,
	now: number,
) {
	return db
		.prepare(`INSERT INTO system_settings
			(key, value, is_secret, updated_by, created_at, updated_at)
			VALUES (?, ?, 0, ?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
		.bind(key, JSON.stringify(value), userId, now, now);
}
