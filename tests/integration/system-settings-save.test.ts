import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadSiteBrand } from "#/features/settings/server/site-brand";
import { saveSystemSettings } from "#/features/settings/server/system-settings";
import { loadOperationalSettings } from "#/server/operational-settings";
import { applyMigrations } from "./migrations";

describe("system settings persistence", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let cache: KVNamespace;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-system-settings-save" },
			kvNamespaces: ["CACHE"],
		});
		db = await miniflare.getD1Database("DB");
		cache = (await miniflare.getKVNamespace("CACHE")) as unknown as KVNamespace;
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT OR IGNORE INTO users (id, name, email, email_verified, enabled, two_factor_enabled) VALUES ('root-user', 'Root', 'settings-root@example.com', 1, 1, 0)",
			)
			.run();
	});

	beforeEach(async () => {
		await db.batch([
			db.prepare(
				"DELETE FROM system_settings WHERE key IN ('site.name', 'site.default_locale', 'orders.default_expiry_ms', 'runtime.api_key_pepper', 'runtime.integration_config_secret')",
			),
			db.prepare(
				"DELETE FROM audit_logs WHERE action = 'system_settings.updated'",
			),
		]);
		await cache.delete("site-brand:v1");
	});

	afterAll(async () => miniflare.dispose());

	it("makes an ordinary setting authoritative without KV invalidation", async () => {
		await Promise.all([loadSiteBrand(db, cache), loadOperationalSettings(db)]);
		await expect(
			saveSystemSettings(
				[{ key: "orders.default_expiry_ms", value: 1_800_000 }],
				dependencies(),
			),
		).resolves.toEqual({ updated: ["orders.default_expiry_ms"] });

		await expect(setting("orders.default_expiry_ms")).resolves.toBe("1800000");
		expect(await cache.get("site-brand:v1")).not.toBeNull();
		await expect(loadOperationalSettings(db)).resolves.toMatchObject({
			defaultExpiryMs: 1_800_000,
		});
		expect(
			(await cache.list({ prefix: "operational-settings:" })).keys,
		).toHaveLength(0);
		await expect(latestAudit()).resolves.toMatchObject({
			actor_user_id: "root-user",
			request_id: "request-settings",
		});
	});

	it("invalidates only the public brand snapshot for a Brand form save", async () => {
		await loadSiteBrand(db, cache);
		await saveSystemSettings(
			[
				{ key: "site.name", value: "Updated Edge" },
				{ key: "site.default_locale", value: "zh-CN" },
			],
			dependencies(),
		);

		expect(await cache.get("site-brand:v1")).toBeNull();
		expect(
			(await cache.list({ prefix: "operational-settings:" })).keys,
		).toHaveLength(0);
		await expect(loadSiteBrand(db, cache)).resolves.toMatchObject({
			name: "Updated Edge",
			defaultLocale: "zh-CN",
		});
	});

	it("preserves configured secrets and rejects unknown or duplicate keys", async () => {
		await db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.api_key_pepper', '\"configured-secret\"', 1, 0, 0)",
			)
			.run();
		await expect(
			saveSystemSettings(
				[{ key: "runtime.api_key_pepper", value: "" }],
				dependencies(),
			),
		).resolves.toEqual({ updated: [] });
		await expect(setting("runtime.api_key_pepper")).resolves.toBe(
			'"configured-secret"',
		);
		await expect(
			saveSystemSettings([{ key: "unknown", value: true }], dependencies()),
		).rejects.toMatchObject({ code: "invalid_settings", status: 400 });
		await expect(
			saveSystemSettings(
				[{ key: "site.default_locale", value: "invalid" }],
				dependencies(),
			),
		).rejects.toBeInstanceOf(Error);
		await expect(
			saveSystemSettings(
				[
					{ key: "site.name", value: "First" },
					{ key: "site.name", value: "Second" },
				],
				dependencies(),
			),
		).rejects.toMatchObject({ code: "invalid_settings", status: 400 });
	});

	function dependencies() {
		return {
			db,
			cache,
			userId: "root-user",
			requestId: "request-settings",
			ipAddress: "192.0.2.2",
		};
	}

	async function setting(key: string) {
		return (
			await db
				.prepare("SELECT value FROM system_settings WHERE key = ?")
				.bind(key)
				.first<{ value: string }>()
		)?.value;
	}

	function latestAudit() {
		return db
			.prepare(
				"SELECT actor_user_id, request_id, ip_address, after FROM audit_logs WHERE action = 'system_settings.updated' ORDER BY created_at DESC, rowid DESC LIMIT 1",
			)
			.first();
	}
});
