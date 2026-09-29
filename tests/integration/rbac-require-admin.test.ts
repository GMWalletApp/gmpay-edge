import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "#/db/schema";
import { requireAdmin } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import { primeSessionLookup } from "#/features/auth/server/auth";
import { createAuth } from "#/features/auth/server/auth-factory";
import { installSystem } from "#/features/installation/server/install";
import { createUser } from "#/features/users/server/users";
import { adaptCloudflareEnv } from "#/server/runtime/cloudflare";
import { runWithRuntimeEnv } from "#/server/runtime/context";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import {
	createDatastoreCounters,
	instrumentD1,
	instrumentKv,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

const workerEnv = vi.hoisted(() => ({
	bindings: {} as Partial<Env>,
}));

vi.mock("cloudflare:workers", () => ({
	env: workerEnv.bindings,
	waitUntil: vi.fn(),
}));

describe("requireAdmin authorization paths", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let cookies: { root: string; limited: string; disabled: string };

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-rbac-require-admin" },
			kvNamespaces: { CACHE: "gmpay-edge-rbac-require-admin-cache" },
		});
		db = await miniflare.getD1Database("DB");
		const cache = (await miniflare.getKVNamespace(
			"CACHE",
		)) as unknown as KVNamespace;
		await applyMigrations(db);
		const runtime = createInitialRuntimeConfig("https://pay.example");
		const appDb = drizzle(db, { schema });
		await installSystem(
			appDb,
			{
				name: "Root",
				email: "root@example.com",
				password: "exact-root-password",
			},
			runtime,
		);
		const limited = await createUser(appDb, {
			name: "Limited",
			email: "limited@example.com",
			enabled: true,
			password: "limited-password-1",
		});
		const disabled = await createUser(appDb, {
			name: "Disabled",
			email: "disabled@example.com",
			enabled: true,
			password: "disabled-password-1",
		});
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"INSERT INTO roles (id, name, built_in, enabled, created_at, updated_at) VALUES ('viewer-role', 'viewer', 0, 1, ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT INTO role_permissions (id, role_id, module, permission_mask, created_at, updated_at) VALUES ('viewer-orders', 'viewer-role', 'orders', 1, ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES ('limited-viewer', ?, 'viewer-role', ?), ('disabled-viewer', ?, 'viewer-role', ?)",
				)
				.bind(limited.id, now, disabled.id, now),
		]);
		const auth = createAuth(appDb, {
			BETTER_AUTH_SECRET: runtime.betterAuthSecret,
			BETTER_AUTH_URL: runtime.betterAuthUrl,
		});
		const signIn = async (email: string, password: string) => {
			const response = await auth.api.signInEmail({
				body: { email, password },
				asResponse: true,
			});
			return response.headers.get("set-cookie")?.split(";")[0] ?? "";
		};
		cookies = {
			root: await signIn("root@example.com", "exact-root-password"),
			limited: await signIn("limited@example.com", "limited-password-1"),
			disabled: await signIn("disabled@example.com", "disabled-password-1"),
		};
		// The session outlives the account: authorization must re-check enabled.
		await db
			.prepare(
				"UPDATE users SET enabled = 0, disabled_at = ?, updated_at = ? WHERE id = ?",
			)
			.bind(now, now, disabled.id)
			.run();
		workerEnv.bindings.DB = db;
		workerEnv.bindings.CACHE = cache;
	});

	afterAll(async () => miniflare.dispose());

	function authorize(
		cookie: string | undefined,
		permission: ReturnType<typeof systemPermission>,
	) {
		const request = new Request("https://pay.example/admin/orders", {
			headers: cookie ? { cookie } : {},
		});
		return runWithRuntimeEnv(adaptCloudflareEnv(workerEnv.bindings), () =>
			requireAdmin(request, permission),
		);
	}

	it("rejects anonymous requests with 401", async () => {
		await expect(
			authorize(undefined, systemPermission("orders", "read")),
		).rejects.toMatchObject({ name: "AccessDeniedError", status: 401 });
	});

	it("rejects a disabled user's still-valid session with 403", async () => {
		await expect(
			authorize(cookies.disabled, systemPermission("orders", "read")),
		).rejects.toMatchObject({ name: "AccessDeniedError", status: 403 });
	});

	it("rejects an enabled user who lacks the required bit with 403", async () => {
		await expect(
			authorize(cookies.limited, systemPermission("orders", "update")),
		).rejects.toMatchObject({ name: "AccessDeniedError", status: 403 });
		await expect(
			authorize(cookies.limited, systemPermission("users", "read")),
		).rejects.toMatchObject({ name: "AccessDeniedError", status: 403 });
	});

	it("consumes a primed session lookup instead of repeating it", async () => {
		const counters = createDatastoreCounters();
		const cache = workerEnv.bindings.CACHE;
		if (!cache) throw new Error("KV binding missing");
		const env = adaptCloudflareEnv({
			DB: instrumentD1(db, counters),
			CACHE: instrumentKv(cache, counters),
		});
		const request = (path: string) =>
			new Request(`https://pay.example${path}`, {
				headers: { cookie: cookies.root },
			});
		const authorize = (target: Request) =>
			runWithRuntimeEnv(env, () =>
				requireAdmin(target, systemPermission("orders", "read")),
			);
		// A cold binding has no verified auth instance: priming is a no-op.
		await runWithRuntimeEnv(env, () =>
			primeSessionLookup(request("/_serverFn/orders")),
		);
		expect(counters).toMatchObject({ d1StatementRaw: 0, d1StatementAll: 0 });
		await expect(authorize(request("/admin/orders"))).resolves.toMatchObject({
			root: true,
		});

		Object.assign(counters, createDatastoreCounters());
		const primed = request("/_serverFn/orders");
		await runWithRuntimeEnv(env, () => primeSessionLookup(primed));
		await expect(authorize(primed)).resolves.toMatchObject({ root: true });
		// One settings read plus one Better Auth session lookup, not two lookups.
		expect(
			counters.d1StatementAll +
				counters.d1StatementRaw +
				counters.d1StatementFirst +
				counters.d1StatementRun +
				counters.d1Batch,
		).toBe(3);

		// Public paths never prime, so anonymous traffic costs nothing extra.
		Object.assign(counters, createDatastoreCounters());
		await runWithRuntimeEnv(env, () =>
			primeSessionLookup(request("/checkout/12345678901234567890")),
		);
		expect(counters).toMatchObject({ d1StatementRaw: 0, d1StatementAll: 0 });
	});

	it("discards an optimistic lookup once the runtime secret changed", async () => {
		const original = await db
			.prepare(
				"SELECT value FROM system_settings WHERE key = 'runtime.better_auth_secret'",
			)
			.first<{ value: string }>();
		if (!original) throw new Error("runtime secret missing");
		const rotated = JSON.stringify("r".repeat(64));
		await db
			.prepare(
				"UPDATE system_settings SET value = ? WHERE key = 'runtime.better_auth_secret'",
			)
			.bind(rotated)
			.run();
		try {
			await expect(
				authorize(cookies.root, systemPermission("orders", "read")),
			).rejects.toMatchObject({ name: "AccessDeniedError", status: 401 });
		} finally {
			await db
				.prepare(
					"UPDATE system_settings SET value = ? WHERE key = 'runtime.better_auth_secret'",
				)
				.bind(original.value)
				.run();
		}
		await expect(
			authorize(cookies.root, systemPermission("orders", "read")),
		).resolves.toMatchObject({ root: true });
	});

	it("admits a granted user and returns the effective access", async () => {
		await expect(
			authorize(cookies.limited, systemPermission("orders", "read")),
		).resolves.toMatchObject({
			email: "limited@example.com",
			roles: ["viewer"],
			root: false,
		});
		await expect(
			authorize(cookies.root, systemPermission("users", "delete")),
		).resolves.toMatchObject({ email: "root@example.com", root: true });
	});
});
