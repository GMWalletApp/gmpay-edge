import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listSystemSettings } from "#/features/settings/server/system-settings";
import { applyMigrations } from "../integration/migrations";

const secrets = {
	"runtime.better_auth_secret":
		"better-auth-secret-value-that-must-stay-server-side",
	"runtime.api_key_pepper": "api-key-pepper-value-that-must-stay-server-side",
	"runtime.integration_config_secret":
		"integration-secret-value-that-must-stay-server-side",
} as const;

describe("runtime secret exposure through the settings listing", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-runtime-secret-exposure" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db.batch([
			...Object.entries(secrets).map(([key, value]) =>
				db
					.prepare(
						"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES (?, ?, 1, 1, 1)",
					)
					.bind(key, JSON.stringify(value)),
			),
			db.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('runtime.better_auth_url', '"https://pay.example"', 0, 1, 1)`,
			),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it("returns only a configured flag for every runtime secret", async () => {
		const listing = await listSystemSettings(db);
		const serialized = JSON.stringify(listing);
		for (const [key, value] of Object.entries(secrets)) {
			expect(listing.find((item) => item.key === key)).toMatchObject({
				value: "",
				configured: true,
				isDefault: false,
			});
			expect(serialized).not.toContain(value);
		}
		expect(
			listing.find((item) => item.key === "runtime.better_auth_url"),
		).toMatchObject({ value: "https://pay.example", configured: undefined });
	});

	it("reports an uninitialized secret as not configured without a value", async () => {
		await db
			.prepare(
				"DELETE FROM system_settings WHERE key = 'runtime.api_key_pepper'",
			)
			.run();
		expect(
			(await listSystemSettings(db)).find(
				(item) => item.key === "runtime.api_key_pepper",
			),
		).toMatchObject({ value: "", configured: false, isDefault: true });
	});
});
