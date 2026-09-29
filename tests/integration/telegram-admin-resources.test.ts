import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TelegramAdminContext } from "#/features/telegram/server/admin-context";
import { setTelegramNotificationEnabled } from "#/features/telegram/server/notification-bindings";
import { applyMigrations } from "./migrations";

describe("Telegram admin resources", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const context = () => ({
		db,
		user: { id: "actor" } as TelegramAdminContext["user"],
		request: new Request("https://pay.example/admin/telegram/notifications", {
			headers: {
				"x-request-id": "toggle-request",
				"cf-connecting-ip": "203.0.113.5",
			},
		}),
	});

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-telegram-admin-resources" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db.batch([
			db.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at) VALUES ('actor', 'Root', 'root@example.com', 1, 1, 1, 1)",
			),
			db.prepare(
				"INSERT INTO telegram_bots (id, name, token_encrypted, webhook_secret_encrypted, enabled, created_at, updated_at) VALUES ('bot', 'Bot', 'token', 'secret', 0, 1, 1)",
			),
			db.prepare(
				"INSERT INTO telegram_notification_bindings (id, bot_id, template_translations, name, target_type, target_id, locale, events, enabled, created_at, updated_at) VALUES ('target', 'bot', '{}', 'Target', 'private', '100', 'en-US', '[\"order.paid\"]', 1, 1, 1)",
			),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it("updates an existing notification target and audits it in the same batch", async () => {
		await expect(
			setTelegramNotificationEnabled(context(), {
				id: "target",
				enabled: false,
				now: 10,
			}),
		).resolves.toEqual({ id: "target", enabled: false });
		await expect(
			db
				.prepare(
					"SELECT enabled, updated_at FROM telegram_notification_bindings WHERE id = 'target'",
				)
				.first(),
		).resolves.toEqual({ enabled: 0, updated_at: 10 });
		const audit = await db
			.prepare(
				"SELECT actor_user_id, request_id, ip_address, after FROM audit_logs WHERE action = 'telegram_target.enabled_changed' AND target_id = 'target'",
			)
			.first<{
				actor_user_id: string;
				request_id: string;
				ip_address: string;
				after: string;
			}>();
		expect(audit).toMatchObject({
			actor_user_id: "actor",
			request_id: "toggle-request",
			ip_address: "203.0.113.5",
		});
		expect(JSON.parse(audit?.after ?? "null")).toEqual({ enabled: false });
	});

	it("rejects a notification target that no longer exists without auditing", async () => {
		await expect(
			setTelegramNotificationEnabled(context(), {
				id: "missing",
				enabled: true,
			}),
		).rejects.toMatchObject({
			code: "telegram_notification_not_found",
			status: 404,
		});
		await expect(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = 'missing'",
				)
				.first<{ count: number }>(),
		).resolves.toEqual({ count: 0 });
	});
});
