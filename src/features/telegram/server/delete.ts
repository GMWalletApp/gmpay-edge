import { DomainError } from "#/lib/domain-error";

export async function deleteTelegramBot(
	db: D1Database,
	id: string,
	audit?: D1PreparedStatement,
) {
	const bot = await db
		.prepare("SELECT enabled FROM telegram_bots WHERE id = ? LIMIT 1")
		.bind(id)
		.first<{ enabled: number }>();
	if (!bot)
		throw new DomainError(
			"telegram_bot_not_found",
			404,
			"Telegram bot not found",
		);
	if (bot.enabled)
		throw new DomainError(
			"telegram_bot_enabled",
			409,
			"Disable the Telegram bot before deleting it",
		);
	await db.batch([
		db.prepare("DELETE FROM telegram_bots WHERE id = ?").bind(id),
		...(audit ? [audit] : []),
	]);
	return { id };
}
