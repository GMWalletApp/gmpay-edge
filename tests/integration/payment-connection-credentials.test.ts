import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPaymentConnectionApiKey } from "#/features/payment-settings/server/connection-credentials";
import { applyMigrations } from "./migrations";

describe("payment connection credential migration", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "payment-connection-credentials" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.integration_config_secret', ?, 1, ?, ?)",
				)
				.bind(JSON.stringify("credential-encryption-secret"), now, now),
			db
				.prepare(
					"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('test-chain', 'Test chain', 'chain', 'evm', ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					`INSERT INTO payment_ingresses
					 (id, rail_code, name, type, transport, endpoint, api_key, enabled, created_at, updated_at)
					 VALUES ('legacy-connection', 'test-chain', 'Legacy', 'rpc', 'http',
					 'https://rpc.example', 'legacy-secret', 0, ?, ?)`,
				)
				.bind(now, now),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it("encrypts and clears a legacy plaintext API key atomically", async () => {
		await expect(
			loadPaymentConnectionApiKey(db, {
				connectionId: "legacy-connection",
				configEncrypted: null,
				legacyApiKey: "legacy-secret",
			}),
		).resolves.toBe("legacy-secret");

		const stored = await db
			.prepare(
				`SELECT ingress.api_key, credential.config_encrypted
				 FROM payment_ingresses ingress
				 JOIN payment_ingress_credentials credential
				 ON credential.payment_ingress_id = ingress.id
				 WHERE ingress.id = 'legacy-connection'`,
			)
			.first<{ api_key: string | null; config_encrypted: string }>();
		expect(stored?.api_key).toBeNull();
		expect(stored?.config_encrypted).not.toContain("legacy-secret");
		await expect(
			loadPaymentConnectionApiKey(db, {
				connectionId: "legacy-connection",
				configEncrypted: stored?.config_encrypted ?? null,
				legacyApiKey: null,
			}),
		).resolves.toBe("legacy-secret");
	});
});
