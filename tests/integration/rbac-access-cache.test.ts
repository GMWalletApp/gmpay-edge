import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { hasGrantedPermission } from "#/features/access/permissions";
import {
	loadEffectiveUserAccess,
	memoizeRequestAccess,
} from "#/features/access/server/access-cache";
import { bumpUserAccessRevisionStatement } from "#/features/access/server/access-revision";
import { systemPermission } from "#/features/access/system-rbac";
import { replaceUserRolesAtomically } from "#/features/users/server/role-assignments";
import { applyMigrations } from "./migrations";

describe("versioned RBAC access cache", () => {
	let miniflare: Miniflare;
	let database: D1Database;
	let updatedAt: number;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-rbac-access-cache" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
	});

	beforeEach(async () => {
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		await database.batch([
			database.prepare("DELETE FROM user_roles"),
			database.prepare("DELETE FROM role_permissions"),
			database.prepare("DELETE FROM roles"),
			database.prepare("DELETE FROM users"),
		]);
		updatedAt = Date.now();
		await database.batch([
			database
				.prepare(
					"INSERT INTO users (id, name, email, email_verified, enabled, two_factor_enabled, created_at, updated_at) VALUES ('user-1', 'Operator', 'operator@example.com', 1, 1, 0, ?, ?)",
				)
				.bind(updatedAt, updatedAt),
			database
				.prepare(
					"INSERT INTO roles (id, name, built_in, enabled, created_at, updated_at) VALUES ('role-1', 'operator', 0, 1, ?, ?), ('role-2', 'reviewer', 0, 1, ?, ?)",
				)
				.bind(updatedAt, updatedAt, updatedAt, updatedAt),
			database
				.prepare(
					"INSERT INTO role_permissions (id, role_id, module, permission_mask, created_at, updated_at) VALUES ('permission-1', 'role-1', 'orders', 1, ?, ?), ('permission-2', 'role-2', 'orders', 4, ?, ?)",
				)
				.bind(updatedAt, updatedAt, updatedAt, updatedAt),
			database
				.prepare(
					"INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES ('user-role-1', 'user-1', 'role-1', ?), ('user-role-2', 'user-1', 'role-2', ?)",
				)
				.bind(updatedAt, updatedAt),
		]);
	});

	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => miniflare.dispose());

	it("uses one D1 query on a cold load and no RBAC query on a warm load", async () => {
		const cache = new MemoryKv();
		const counted = countedDatabase(database);
		const user = sessionUser(updatedAt);

		const cold = await loadEffectiveUserAccess(counted.db, cache.kv, user);
		const warm = await loadEffectiveUserAccess(counted.db, cache.kv, user);

		expect(counted.queryCount()).toBe(1);
		expect(cache.gets).toBe(2);
		expect(cache.puts).toBe(1);
		expect(cold.roles).toEqual(["operator", "reviewer"]);
		expect(warm.permissions.get("orders")).toBe(5);
		expect(
			hasGrantedPermission(
				false,
				warm.permissions,
				systemPermission("orders", "update"),
			),
		).toBe(true);
		const metrics = vi
			.mocked(console.info)
			.mock.calls.map(([metric]) => metric);
		expect(metrics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					cache: "rbac_access",
					operation: "read",
					outcome: "miss",
					sampleRate: 1,
				}),
				expect.objectContaining({
					cache: "rbac_access",
					operation: "write",
					outcome: "success",
					sampleRate: 1,
				}),
			]),
		);
		expect(JSON.stringify(metrics)).not.toContain("user-1");
		expect(JSON.stringify(metrics)).not.toContain("operator@example.com");
		expect(JSON.stringify(metrics)).not.toContain("rbac-access:v1");
		const payload = [...cache.values.values()].join("");
		expect(payload).not.toMatch(
			/operator@example\.com|"name"|session|token|password|secret/i,
		);
	});

	it("does not coalesce the same user revision across D1 bindings", async () => {
		const first = countedDatabase(database);
		const second = countedDatabase(database);
		const user = sessionUser(updatedAt);

		const [firstAccess, secondAccess] = await Promise.all([
			loadEffectiveUserAccess(first.db, new MemoryKv().kv, user),
			loadEffectiveUserAccess(second.db, new MemoryKv().kv, user),
		]);

		expect(first.queryCount()).toBe(1);
		expect(second.queryCount()).toBe(1);
		expect(firstAccess.permissions.get("orders")).toBe(5);
		expect(secondAccess.permissions.get("orders")).toBe(5);
	});

	it("rebuilds malformed cache values without trusting them", async () => {
		const cache = new MemoryKv();
		const counted = countedDatabase(database);
		const user = sessionUser(updatedAt);
		await loadEffectiveUserAccess(counted.db, cache.kv, user);
		cache.corruptOnlyValue();

		const rebuilt = await loadEffectiveUserAccess(counted.db, cache.kv, user);

		expect(counted.queryCount()).toBe(2);
		expect(rebuilt.permissions.get("orders")).toBe(5);
		expect(vi.mocked(console.info)).toHaveBeenCalledWith(
			expect.objectContaining({
				cache: "rbac_access",
				operation: "read",
				outcome: "corrupt",
			}),
		);
	});

	it("rejects version, user, and revision mismatches before rebuilding from D1", async () => {
		const cache = new MemoryKv();
		const counted = countedDatabase(database);
		const user = sessionUser(updatedAt);
		await loadEffectiveUserAccess(counted.db, cache.kv, user);

		for (const snapshot of [
			cachedSnapshot(updatedAt, { version: 2 }),
			cachedSnapshot(updatedAt, { userId: "other-user" }),
			cachedSnapshot(updatedAt, { revision: updatedAt + 1 }),
		]) {
			cache.replaceOnlyValue(JSON.stringify(snapshot));
			await expect(
				loadEffectiveUserAccess(counted.db, cache.kv, user),
			).resolves.toMatchObject({ roles: ["operator", "reviewer"] });
		}

		expect(counted.queryCount()).toBe(4);
	});

	it("does not use corrupt KV access when authoritative D1 is unavailable", async () => {
		const cache = new MemoryKv();
		await loadEffectiveUserAccess(database, cache.kv, sessionUser(updatedAt));
		cache.corruptOnlyValue();
		const unavailable = {
			prepare: () => ({
				bind: () => ({
					all: async () => {
						throw new Error("D1 unavailable");
					},
				}),
			}),
		} as unknown as D1Database;

		await expect(
			loadEffectiveUserAccess(unavailable, cache.kv, sessionUser(updatedAt)),
		).rejects.toThrow("D1 unavailable");
	});

	it("uses the new revision after a permission mutation even while old KV remains", async () => {
		const cache = new MemoryKv();
		const counted = countedDatabase(database);
		await loadEffectiveUserAccess(counted.db, cache.kv, sessionUser(updatedAt));
		await database.batch([
			database
				.prepare(
					"UPDATE role_permissions SET permission_mask = 8, updated_at = ? WHERE id = 'permission-1'",
				)
				.bind(updatedAt + 1),
			bumpUserAccessRevisionStatement(database, "user-1", updatedAt),
		]);
		const row = await database
			.prepare("SELECT updated_at FROM users WHERE id = 'user-1'")
			.first<{ updated_at: number }>();

		const refreshed = await loadEffectiveUserAccess(
			counted.db,
			cache.kv,
			sessionUser(row?.updated_at ?? 0),
		);

		expect(row?.updated_at).toBeGreaterThan(updatedAt);
		expect(cache.size).toBe(2);
		expect(counted.queryCount()).toBe(2);
		expect(refreshed.permissions.get("orders")).toBe(12);
	});

	it("keeps a concurrent old revision from poisoning access after revocation", async () => {
		const cache = new MemoryKv();
		const counted = countedDatabase(database);
		const oldUser = sessionUser(updatedAt);
		await loadEffectiveUserAccess(counted.db, cache.kv, oldUser);
		await database.batch([
			database
				.prepare(
					"UPDATE role_permissions SET permission_mask = 0, updated_at = ? WHERE id = 'permission-1'",
				)
				.bind(updatedAt + 1),
			bumpUserAccessRevisionStatement(database, "user-1", updatedAt),
		]);
		const row = await database
			.prepare("SELECT updated_at FROM users WHERE id = 'user-1'")
			.first<{ updated_at: number }>();

		const [stale, current] = await Promise.all([
			loadEffectiveUserAccess(counted.db, cache.kv, oldUser),
			loadEffectiveUserAccess(
				counted.db,
				cache.kv,
				sessionUser(row?.updated_at ?? 0),
			),
		]);

		expect(stale.permissions.get("orders")).toBe(5);
		expect(current.permissions.get("orders")).toBe(4);
		expect(cache.size).toBe(2);
		expect(counted.queryCount()).toBe(2);
	});

	it("falls back to D1 when KV is unavailable", async () => {
		const cache = new MemoryKv();
		cache.failGet = true;
		const counted = countedDatabase(database);

		await expect(
			loadEffectiveUserAccess(counted.db, cache.kv, sessionUser(updatedAt)),
		).resolves.toMatchObject({ roles: ["operator", "reviewer"] });
		expect(counted.queryCount()).toBe(1);
		expect(vi.mocked(console.info)).toHaveBeenCalledWith(
			expect.objectContaining({
				cache: "rbac_access",
				operation: "read",
				outcome: "fallback",
			}),
		);
	});

	it("returns authoritative access when the KV write fails", async () => {
		const cache = new MemoryKv();
		cache.failPut = true;
		const counted = countedDatabase(database);

		const access = await loadEffectiveUserAccess(
			counted.db,
			cache.kv,
			sessionUser(updatedAt),
		);

		expect(access.permissions.get("orders")).toBe(5);
		expect(counted.queryCount()).toBe(1);
		expect(cache.puts).toBe(1);
		expect(cache.size).toBe(0);
		expect(vi.mocked(console.info)).toHaveBeenCalledWith(
			expect.objectContaining({
				cache: "rbac_access",
				operation: "write",
				outcome: "fallback",
			}),
		);
	});

	it("coalesces concurrent cold loads before querying D1", async () => {
		const cache = new MemoryKv();
		const counted = countedDatabase(database);
		const user = sessionUser(updatedAt);

		const [first, second] = await Promise.all([
			loadEffectiveUserAccess(counted.db, cache.kv, user),
			loadEffectiveUserAccess(counted.db, cache.kv, user),
		]);

		expect(counted.queryCount()).toBe(1);
		expect(cache.gets).toBe(1);
		expect(cache.puts).toBe(1);
		expect(first.permissions.get("orders")).toBe(5);
		expect(second.permissions.get("orders")).toBe(5);
	});

	it("fails closed for missing or disabled user state and users without enabled roles", async () => {
		const counted = countedDatabase(database);

		for (const enabled of [undefined, null, false] as const) {
			await expect(
				loadEffectiveUserAccess(counted.db, undefined, {
					...sessionUser(updatedAt),
					enabled,
				}),
			).rejects.toThrow("Forbidden");
		}
		expect(counted.queryCount()).toBe(0);

		await database
			.prepare("DELETE FROM user_roles WHERE user_id = 'user-1'")
			.run();
		await expect(
			loadEffectiveUserAccess(counted.db, undefined, sessionUser(updatedAt)),
		).rejects.toThrow("Forbidden");
		expect(counted.queryCount()).toBe(1);
	});

	it("uses an empty permission map for root and still caches the role", async () => {
		await database.batch([
			database.prepare("DELETE FROM user_roles WHERE user_id = 'user-1'"),
			database.prepare("UPDATE roles SET name = 'root' WHERE id = 'role-1'"),
			database
				.prepare(
					"INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES ('root-assignment', 'user-1', 'role-1', ?)",
				)
				.bind(updatedAt),
		]);
		const cache = new MemoryKv();

		const access = await loadEffectiveUserAccess(
			database,
			cache.kv,
			sessionUser(updatedAt),
		);

		expect(access).toMatchObject({ root: true, roles: ["root"] });
		expect(access.permissions.size).toBe(0);
		expect(cache.puts).toBe(1);
	});

	it("drops unknown modules and unregistered permission bits", async () => {
		await database.batch([
			database.prepare(
				"UPDATE role_permissions SET permission_mask = 255 WHERE id = 'permission-1'",
			),
			database
				.prepare(
					"INSERT INTO role_permissions (id, role_id, module, permission_mask, created_at, updated_at) VALUES ('unknown-module', 'role-1', 'future_module', 255, ?, ?)",
				)
				.bind(updatedAt, updatedAt),
		]);

		const access = await loadEffectiveUserAccess(
			database,
			undefined,
			sessionUser(updatedAt),
		);

		expect(access.permissions.get("orders")).toBe(31);
		expect(access.permissions.has("future_module")).toBe(false);
	});

	it("increments the revision for repeated same-millisecond mutations", async () => {
		await database.batch([
			bumpUserAccessRevisionStatement(database, "user-1", updatedAt),
			bumpUserAccessRevisionStatement(database, "user-1", updatedAt),
		]);

		const row = await database
			.prepare("SELECT updated_at FROM users WHERE id = 'user-1'")
			.first<{ updated_at: number }>();
		expect(row?.updated_at).toBe(updatedAt + 2);
	});

	it("advances the revision in the same batch as role replacement", async () => {
		await replaceUserRolesAtomically(database, {
			userId: "user-1",
			roleIds: ["role-2"],
			desiredHasRoot: false,
			currentUserId: "actor",
			currentUserIsRoot: false,
		});

		const state = await database
			.prepare(
				"SELECT updated_at, (SELECT GROUP_CONCAT(role_id) FROM user_roles WHERE user_id = users.id) AS role_ids FROM users WHERE id = 'user-1'",
			)
			.first<{ updated_at: number; role_ids: string }>();
		expect(state?.updated_at).toBeGreaterThan(updatedAt);
		expect(state?.role_ids).toBe("role-2");
	});

	it("shares one in-flight access load within the same Request", async () => {
		const cache = new WeakMap<
			Request,
			ReturnType<typeof loadEffectiveUserAccess>
		>();
		const request = new Request("https://pay.example/admin");
		let calls = 0;
		const load = async () => {
			calls += 1;
			return loadEffectiveUserAccess(
				database,
				undefined,
				sessionUser(updatedAt),
			);
		};

		const [first, second] = await Promise.all([
			memoizeRequestAccess(cache, request, load),
			memoizeRequestAccess(cache, request, load),
		]);

		expect(calls).toBe(1);
		expect(first).toBe(second);
	});

	it("does not share request memoization across Request objects", async () => {
		const cache = new WeakMap<
			Request,
			ReturnType<typeof loadEffectiveUserAccess>
		>();
		let calls = 0;
		const load = async () => {
			calls += 1;
			return loadEffectiveUserAccess(
				database,
				undefined,
				sessionUser(updatedAt),
			);
		};

		await Promise.all([
			memoizeRequestAccess(
				cache,
				new Request("https://pay.example/admin"),
				load,
			),
			memoizeRequestAccess(
				cache,
				new Request("https://pay.example/admin"),
				load,
			),
		]);

		expect(calls).toBe(2);
	});
});

function sessionUser(revision: number) {
	return {
		id: "user-1",
		name: "Operator",
		email: "operator@example.com",
		enabled: true,
		updatedAt: new Date(revision),
	};
}

function countedDatabase(database: D1Database) {
	let queries = 0;
	return {
		db: {
			prepare(query: string) {
				queries += 1;
				return database.prepare(query);
			},
		} as D1Database,
		queryCount: () => queries,
	};
}

class MemoryKv {
	readonly values = new Map<string, string>();
	gets = 0;
	puts = 0;
	failGet = false;
	failPut = false;

	readonly kv = {
		get: async (key: string) => {
			this.gets += 1;
			if (this.failGet) throw new Error("KV unavailable");
			return this.values.get(key) ?? null;
		},
		put: async (key: string, value: string) => {
			this.puts += 1;
			if (this.failPut) throw new Error("KV unavailable");
			this.values.set(key, value);
		},
	} as unknown as KVNamespace;

	get size() {
		return this.values.size;
	}

	corruptOnlyValue() {
		const key = this.values.keys().next().value;
		if (key) this.values.set(key, "{invalid");
	}

	replaceOnlyValue(value: string) {
		const key = this.values.keys().next().value;
		if (key) this.values.set(key, value);
	}
}

function cachedSnapshot(
	revision: number,
	overrides: Partial<{ version: number; userId: string; revision: number }>,
) {
	return {
		version: 1,
		userId: "user-1",
		revision,
		roles: ["operator", "reviewer"],
		root: false,
		permissions: [{ module: "orders", permissionMask: 5 }],
		...overrides,
	};
}
