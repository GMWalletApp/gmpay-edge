import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	AUTH_FAILURE_LIMIT,
	authenticateGmpayParameters,
	GmpayRateLimitError,
	signGmpayParameters,
} from "#/features/api-keys/server/gmpay-signature";
import { encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

describe("GMPay API authentication", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const pepper = "gmpay-auth-test-pepper";
	const secret = "merchant-secret";

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-gmpay-auth" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.api_key_pepper', ?, 1, ?, ?)",
				)
				.bind(JSON.stringify(pepper), now, now),
			db
				.prepare(
					"INSERT INTO api_keys (id, name, pid, secret_encrypted, scopes, created_at, updated_at) VALUES ('key', 'GMPay', 'gmp_merchant', ?, '[\"orders:create\"]', ?, ?)",
				)
				.bind(await encryptSecret(secret, pepper), now, now),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it("identifies the API key by pid and verifies its decrypted secret", async () => {
		const input = {
			pid: "gmp_merchant",
			order_id: "ORDER-1001",
			currency: "cny",
			amount: "10.00",
			notify_url: "https://merchant.example/notify",
		};
		const result = await authenticateGmpayParameters(
			db,
			{ ...input, signature: signGmpayParameters(input, secret) },
			"orders:create",
		);
		expect(result).toMatchObject({ apiKeyId: "key", pid: "gmp_merchant" });
		const touched = await db
			.prepare("SELECT last_used_at FROM api_keys WHERE id = 'key'")
			.first<{ last_used_at: number | null }>();
		expect(touched?.last_used_at).toBeTypeOf("number");
	});

	it("does not rewrite recent API-key usage telemetry", async () => {
		const lastUsedAt = Date.now() + 60_000;
		const updatedAt = 123;
		await db
			.prepare(
				"UPDATE api_keys SET last_used_at = ?, updated_at = ? WHERE id = 'key'",
			)
			.bind(lastUsedAt, updatedAt)
			.run();
		const input = {
			pid: "gmp_merchant",
			order_id: "ORDER-TELEMETRY",
			amount: "10.00",
		};
		await authenticateGmpayParameters(
			db,
			{ ...input, signature: signGmpayParameters(input, secret) },
			"orders:create",
		);
		const touched = await db
			.prepare("SELECT last_used_at, updated_at FROM api_keys WHERE id = 'key'")
			.first<{ last_used_at: number; updated_at: number }>();
		expect(touched).toEqual({
			last_used_at: lastUsedAt,
			updated_at: updatedAt,
		});
	});

	it("rejects tampering, disabled or revoked credentials, and missing scopes", async () => {
		const input = {
			pid: "gmp_merchant",
			order_id: "ORDER-1002",
			amount: "10.00",
		};
		const signature = signGmpayParameters(input, secret);
		await expect(
			authenticateGmpayParameters(
				db,
				{ ...input, amount: "10.01", signature },
				"orders:create",
			),
		).resolves.toBeNull();
		await expect(
			authenticateGmpayParameters(db, { ...input, signature }, "orders:read"),
		).resolves.toBeNull();
		await db.prepare("UPDATE api_keys SET enabled = 0 WHERE id = 'key'").run();
		await expect(
			authenticateGmpayParameters(db, { ...input, signature }, "orders:create"),
		).resolves.toBeNull();
		await db
			.prepare(
				"UPDATE api_keys SET enabled = 1, revoked_at = ? WHERE id = 'key'",
			)
			.bind(Date.now())
			.run();
		await expect(
			authenticateGmpayParameters(db, { ...input, signature }, "orders:create"),
		).resolves.toBeNull();
	});

	it("counts rejected credentials in a separate failure bucket and refuses exhausted PIDs", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const input = { pid: "gmp_merchant", order_id: "ORDER-FAIL", amount: "1" };
		const successBefore = await bucketCount(db, "api-key:key");
		const failuresBefore = await bucketCount(
			db,
			"api-key-auth-fail:gmp_merchant",
		);
		try {
			await expect(
				authenticateGmpayParameters(
					db,
					{ ...input, signature: "f".repeat(64) },
					"orders:create",
					{ requestId: "auth-fail-1" },
				),
			).resolves.toBeNull();
			await expect(
				authenticateGmpayParameters(
					db,
					{ ...input, pid: "unknown-pid", signature: "f".repeat(64) },
					"orders:create",
				),
			).resolves.toBeNull();
			expect(warn).toHaveBeenNthCalledWith(1, "merchant_auth_failed", {
				pid: "gmp_merchant",
				requestId: "auth-fail-1",
			});
			expect(warn).toHaveBeenNthCalledWith(2, "merchant_auth_failed", {
				pid: "unknown-pid",
				requestId: null,
			});
			expect(await bucketCount(db, "api-key-auth-fail:gmp_merchant")).toBe(
				failuresBefore + 1,
			);
			expect(await bucketCount(db, "api-key-auth-fail:unknown-pid")).toBe(1);
			expect(await bucketCount(db, "api-key:key")).toBe(successBefore);

			await db
				.prepare(
					"UPDATE rate_limit_counters SET count = ? WHERE bucket_key = 'api-key-auth-fail:gmp_merchant'",
				)
				.bind(AUTH_FAILURE_LIMIT)
				.run();
			await expect(
				authenticateGmpayParameters(
					db,
					{ ...input, signature: signGmpayParameters(input, secret) },
					"orders:create",
				),
			).rejects.toBeInstanceOf(GmpayRateLimitError);
		} finally {
			warn.mockRestore();
			await db
				.prepare(
					"DELETE FROM rate_limit_counters WHERE bucket_key LIKE 'api-key-auth-fail:%'",
				)
				.run();
		}
	});

	it("enforces the D1 rate window after signature and scope verification", async () => {
		await db
			.prepare("UPDATE api_keys SET revoked_at = NULL WHERE id = 'key'")
			.run();
		await db
			.prepare(
				"UPDATE rate_limit_counters SET count = 120 WHERE bucket_key = 'api-key:key'",
			)
			.run();
		const input = {
			pid: "gmp_merchant",
			order_id: "ORDER-RATE-LIMIT",
			amount: "10.00",
		};
		await expect(
			authenticateGmpayParameters(
				db,
				{ ...input, signature: signGmpayParameters(input, secret) },
				"orders:create",
			),
		).rejects.toBeInstanceOf(GmpayRateLimitError);
		await db
			.prepare(
				"UPDATE rate_limit_counters SET count = 0 WHERE bucket_key = 'api-key:key'",
			)
			.run();
	});
});

async function bucketCount(db: D1Database, bucketKey: string) {
	const row = await db
		.prepare(
			"SELECT COALESCE(SUM(count), 0) AS count FROM rate_limit_counters WHERE bucket_key = ?",
		)
		.bind(bucketKey)
		.first<{ count: number }>();
	return row?.count ?? 0;
}
