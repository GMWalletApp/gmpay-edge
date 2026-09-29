import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	removeSiteAsset,
	uploadSiteAsset,
} from "#/features/settings/server/site-asset";
import { loadSiteBrand } from "#/features/settings/server/site-brand";
import { applyMigrations } from "./migrations";

describe("site asset storage", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let bucket: R2Bucket;
	let cache: KVNamespace;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-site-assets" },
			r2Buckets: ["FILES"],
			kvNamespaces: ["CACHE"],
		});
		db = await miniflare.getD1Database("DB");
		// Miniflare's Node-mapped bucket type resolves differently per platform;
		// the Workers binding type is what the code under test consumes.
		bucket = (await miniflare.getR2Bucket("FILES")) as unknown as R2Bucket;
		cache = (await miniflare.getKVNamespace("CACHE")) as unknown as KVNamespace;
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT OR IGNORE INTO users (id, name, email, email_verified, enabled, two_factor_enabled) VALUES ('root-user', 'Root', 'brand-root@example.com', 1, 1, 0)",
			)
			.run();
	});

	beforeEach(async () => {
		await db.batch([
			db.prepare(
				"DELETE FROM system_settings WHERE key IN ('site.logo_url', 'site.background_image_url')",
			),
			db.prepare(
				"DELETE FROM audit_logs WHERE action IN ('site_asset.uploaded', 'site_asset.removed')",
			),
		]);
		await Promise.all([
			bucket.delete("branding/site-logo"),
			bucket.delete("branding/site-background"),
			cache.delete("site-brand:v1"),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it("uploads an inspected asset, updates D1, audits it, and invalidates the brand cache", async () => {
		await loadSiteBrand(db, cache);
		const result = await uploadSiteAsset(
			"logo",
			{ contentType: "image/png", base64: toBase64(png(2, 2)) },
			dependencies(),
		);

		expect(result.url).toMatch(/^\/api\/site-logo\?v=\d+$/);
		const object = await bucket.get("branding/site-logo");
		expect(object).not.toBeNull();
		expect(object?.httpMetadata?.contentType).toBe("image/png");
		await expect(object?.arrayBuffer()).resolves.toHaveProperty(
			"byteLength",
			33,
		);
		await expect(setting("site.logo_url")).resolves.toBe(
			JSON.stringify(result.url),
		);
		await expect(
			db
				.prepare(
					"SELECT action, actor_user_id, request_id, ip_address FROM audit_logs WHERE target_id = 'site.logo_url' ORDER BY created_at DESC LIMIT 1",
				)
				.first(),
		).resolves.toMatchObject({
			action: "site_asset.uploaded",
			actor_user_id: "root-user",
			request_id: "request-brand",
			ip_address: "192.0.2.1",
		});
		expect(await cache.get("site-brand:v1")).toBeNull();
		await expect(loadSiteBrand(db, cache)).resolves.toMatchObject({
			logoUrl: result.url,
		});
	});

	it("removes the R2 object and clears the public setting with an audit record", async () => {
		await uploadSiteAsset(
			"background",
			{ contentType: "image/png", base64: toBase64(png(3, 2)) },
			dependencies(),
		);
		await expect(
			removeSiteAsset("background", dependencies()),
		).resolves.toEqual({ removed: true });

		expect(await bucket.get("branding/site-background")).toBeNull();
		await expect(setting("site.background_image_url")).resolves.toBe('""');
		await expect(
			db
				.prepare(
					"SELECT action FROM audit_logs WHERE target_id = 'site.background_image_url' ORDER BY created_at DESC, rowid DESC LIMIT 1",
				)
				.first(),
		).resolves.toMatchObject({ action: "site_asset.removed" });
	});

	function dependencies() {
		return {
			db,
			bucket,
			cache,
			userId: "root-user",
			requestId: "request-brand",
			ipAddress: "192.0.2.1",
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
});

function png(width: number, height: number) {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	new DataView(bytes.buffer).setUint32(16, width);
	new DataView(bytes.buffer).setUint32(20, height);
	return bytes;
}

function toBase64(bytes: Uint8Array) {
	let value = "";
	for (const byte of bytes) value += String.fromCharCode(byte);
	return btoa(value);
}
