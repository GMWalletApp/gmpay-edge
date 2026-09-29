import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveSystemSettings } from "#/features/settings/server/system-settings";
import { applyMigrations } from "./migrations";

describe("runtime master secret rotation guard", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-secret-rotation" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db.batch([
			db.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled, two_factor_enabled, created_at, updated_at) VALUES ('root-user', 'Root', 'rotation-root@example.com', 1, 1, 0, 1, 1)",
			),
			db.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES
				 ('runtime.api_key_pepper', '"initial-pepper-value-0000"', 1, 1, 1),
				 ('runtime.integration_config_secret', '"initial-integration-secret-00"', 1, 1, 1),
				 ('runtime.better_auth_secret', '"${"a".repeat(64)}"', 1, 1, 1)`,
			),
		]);
	});

	afterAll(async () => miniflare.dispose());

	const dependencies = () => ({
		db,
		userId: "root-user",
		requestId: "rotation-request",
		ipAddress: "192.0.2.9",
	});
	async function setting(key: string) {
		const row = await db
			.prepare("SELECT value FROM system_settings WHERE key = ?")
			.bind(key)
			.first<{ value: string }>();
		return row?.value;
	}
	async function auditCount() {
		const row = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'system_settings.updated'",
			)
			.first<{ count: number }>();
		return row?.count ?? 0;
	}

	it("rotates a secret that protects nothing yet", async () => {
		await expect(
			saveSystemSettings(
				[
					{
						key: "runtime.api_key_pepper",
						value: "replacement-pepper-value-1",
					},
				],
				dependencies(),
			),
		).resolves.toEqual({ updated: ["runtime.api_key_pepper"] });
		await expect(setting("runtime.api_key_pepper")).resolves.toBe(
			'"replacement-pepper-value-1"',
		);
	});

	it("refuses to replace the API credential pepper while encrypted API credentials exist", async () => {
		await db
			.prepare(
				"INSERT INTO api_keys (id, name, pid, secret_encrypted, scopes, enabled, created_at, updated_at) VALUES ('key-1', 'Merchant', '100000000001', 'aXY=.Y2lwaGVy', '[\"orders:create\"]', 1, 1, 1)",
			)
			.run();
		const audits = await auditCount();
		await expect(
			saveSystemSettings(
				[{ key: "runtime.api_key_pepper", value: "another-pepper-value-2222" }],
				dependencies(),
			),
		).rejects.toMatchObject({ code: "runtime_secret_in_use", status: 409 });
		await expect(setting("runtime.api_key_pepper")).resolves.toBe(
			'"replacement-pepper-value-1"',
		);
		expect(await auditCount()).toBe(audits);
	});

	it("refuses to replace the integration secret while any dependent ciphertext exists", async () => {
		const attempt = () =>
			saveSystemSettings(
				[
					{
						key: "runtime.integration_config_secret",
						value: "another-integration-secret-2",
					},
				],
				dependencies(),
			);
		await db
			.prepare(
				"INSERT INTO email_channel_configs (id, name, provider, credential_encrypted, from_address, created_at, updated_at) VALUES ('channel-1', 'Resend', 'resend', 'aXY=.Y2lwaGVy', 'noreply@example.com', 1, 1)",
			)
			.run();
		await expect(attempt()).rejects.toMatchObject({
			code: "runtime_secret_in_use",
			status: 409,
		});
		await db.prepare("DELETE FROM email_channel_configs").run();
		await db
			.prepare(
				"INSERT INTO telegram_bots (id, name, token_encrypted, webhook_secret_encrypted, username, enabled, created_at, updated_at) VALUES ('bot-1', 'Alerts', 'aXY=.dG9rZW4=', 'aXY=.c2VjcmV0', 'alerts_bot', 0, 1, 1)",
			)
			.run();
		await expect(attempt()).rejects.toMatchObject({
			code: "runtime_secret_in_use",
			status: 409,
		});
		await expect(setting("runtime.integration_config_secret")).resolves.toBe(
			'"initial-integration-secret-00"',
		);
		await db.prepare("DELETE FROM telegram_bots").run();
		await expect(attempt()).resolves.toEqual({
			updated: ["runtime.integration_config_secret"],
		});
	});

	it("still rotates the Better Auth secret and preserves blank submissions", async () => {
		const replacement = "b".repeat(64);
		await expect(
			saveSystemSettings(
				[
					{ key: "runtime.better_auth_secret", value: replacement },
					{ key: "runtime.api_key_pepper", value: "" },
				],
				dependencies(),
			),
		).resolves.toEqual({ updated: ["runtime.better_auth_secret"] });
		await expect(setting("runtime.better_auth_secret")).resolves.toBe(
			JSON.stringify(replacement),
		);
		await expect(setting("runtime.api_key_pepper")).resolves.toBe(
			'"replacement-pepper-value-1"',
		);
	});
});
