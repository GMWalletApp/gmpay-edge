import {
	type TelegramAdminContext,
	telegramAuditStatement,
} from "#/features/telegram/server/admin-context";
import { requireTelegramResource } from "#/features/telegram/server/resource-errors";

export async function setTelegramNotificationEnabled(
	context: Pick<TelegramAdminContext, "db" | "user" | "request">,
	input: { id: string; enabled: boolean; now?: number },
) {
	const current = await context.db
		.prepare(
			"SELECT id FROM telegram_notification_bindings WHERE id = ? LIMIT 1",
		)
		.bind(input.id)
		.first<{ id: string }>();
	requireTelegramResource(current, "notification");
	const now = input.now ?? Date.now();
	await context.db.batch([
		context.db
			.prepare(
				"UPDATE telegram_notification_bindings SET enabled = ?, updated_at = ? WHERE id = ?",
			)
			.bind(input.enabled, now, input.id),
		telegramAuditStatement(
			context,
			"telegram_target.enabled_changed",
			"telegram_notification_target",
			input.id,
			{ enabled: input.enabled },
			now,
		),
	]);
	return { id: input.id, enabled: input.enabled };
}

/**
 * A private chat that blocked the Bot can never receive messages again until
 * the user unblocks it, so its enabled binding is switched off once. The audit
 * row is written in the same batch and only when a binding actually changes.
 */
export async function disableBlockedTelegramTarget(
	db: D1Database,
	input: { botId: string; targetId: string; now?: number },
) {
	const now = input.now ?? Date.now();
	const [audit] = await db.batch([
		db
			.prepare(
				`INSERT INTO audit_logs (id, action, target_type, target_id, after, created_at)
				 SELECT ?, 'telegram_target.auto_disabled', 'telegram_notification_target', id, ?, ?
				 FROM telegram_notification_bindings
				 WHERE bot_id = ? AND target_type = 'private' AND target_id = ? AND enabled = 1`,
			)
			.bind(
				crypto.randomUUID(),
				JSON.stringify({ targetType: "private", reason: "blocked_by_user" }),
				now,
				input.botId,
				input.targetId,
			),
		db
			.prepare(
				"UPDATE telegram_notification_bindings SET enabled = 0, updated_at = ? WHERE bot_id = ? AND target_type = 'private' AND target_id = ? AND enabled = 1",
			)
			.bind(now, input.botId, input.targetId),
	]);
	return { disabled: (audit?.meta.changes ?? 0) > 0 };
}
