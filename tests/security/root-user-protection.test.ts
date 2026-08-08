import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import { replaceUserRolesAtomically } from "#/features/users/server/role-assignments";
import {
	createUser,
	deleteUser,
	setUserEnabled,
	updateUser,
} from "#/features/users/server/users";
import { applyMigrations } from "../integration/migrations";

describe("root user protection", () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-root-protection" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		await seedRoot(database, "root-a", "root-a@example.com");
	});

	afterAll(async () => miniflare.dispose());

	it("rejects disabling the last enabled root through the switch", async () => {
		await expect(
			setUserEnabled(drizzle(database, { schema }), {
				id: "root-a",
				enabled: false,
				currentUserId: "operator",
			}),
		).rejects.toMatchObject({ code: "last_root_required", status: 409 });
	});

	it("rejects granting root from a non-root administrator", async () => {
		const now = Date.now();
		await database.batch([
			database
				.prepare(
					"INSERT INTO users (id, name, email, email_verified, enabled, two_factor_enabled, created_at, updated_at) VALUES ('role-operator', 'Role operator', 'role-operator@example.com', 1, 1, 0, ?, ?), ('root-target', 'Root target', 'root-target@example.com', 1, 1, 0, ?, ?)",
				)
				.bind(now, now, now, now),
		]);

		await expect(
			replaceUserRolesAtomically(database, {
				userId: "root-target",
				roleIds: ["root-role"],
				desiredHasRoot: true,
				currentUserId: "role-operator",
				currentUserIsRoot: false,
			}),
		).rejects.toMatchObject({ code: "root_role_required", status: 403 });

		const assignment = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM user_roles WHERE user_id = 'root-target' AND role_id = 'root-role'",
			)
			.first<{ count: number }>();
		expect(assignment?.count).toBe(0);

		await expect(
			replaceUserRolesAtomically(database, {
				userId: "root-target",
				roleIds: ["root-role"],
				desiredHasRoot: true,
				currentUserId: "root-a",
				currentUserIsRoot: true,
			}),
		).resolves.toEqual({
			userId: "root-target",
			roleIds: ["root-role"],
		});

		await database.batch([
			database.prepare("DELETE FROM user_roles WHERE user_id = 'root-target'"),
			database.prepare(
				"DELETE FROM users WHERE id IN ('role-operator', 'root-target')",
			),
		]);
	});

	it("rejects disabling the current user through the edit form", async () => {
		await expect(
			updateUser(drizzle(database, { schema }), {
				id: "root-a",
				name: "Root A",
				email: "root-a@example.com",
				enabled: false,
				currentUserId: "root-a",
			}),
		).rejects.toMatchObject({ code: "cannot_disable_self", status: 409 });
	});

	it("returns stable not-found errors for every user mutation path", async () => {
		const db = drizzle(database, { schema });
		await expect(
			setUserEnabled(db, {
				id: "missing-user",
				enabled: true,
				currentUserId: "operator",
			}),
		).rejects.toMatchObject({ code: "user_not_found", status: 404 });
		await expect(
			updateUser(db, {
				id: "missing-user",
				name: "Missing User",
				email: "missing@example.com",
				enabled: true,
				currentUserId: "operator",
			}),
		).rejects.toMatchObject({ code: "user_not_found", status: 404 });
		await expect(
			replaceUserRolesAtomically(database, {
				userId: "missing-user",
				roleIds: [],
				desiredHasRoot: false,
				currentUserId: "operator",
				currentUserIsRoot: false,
			}),
		).rejects.toMatchObject({ code: "user_not_found", status: 404 });
	});

	it("atomically maps concurrent duplicate emails without partial accounts", async () => {
		const db = drizzle(database, { schema });
		const results = await Promise.allSettled([
			createUser(db, {
				name: "Duplicate A",
				email: "duplicate@example.com",
				enabled: true,
				password: "duplicate-password-a",
			}),
			createUser(db, {
				name: "Duplicate B",
				email: "duplicate@example.com",
				enabled: true,
				password: "duplicate-password-b",
			}),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toEqual([
			expect.objectContaining({
				reason: expect.objectContaining({ code: "email_in_use", status: 409 }),
			}),
		]);
		const persisted = await database
			.prepare(
				`SELECT COUNT(*) AS users,
				 (SELECT COUNT(*) FROM accounts a JOIN users u ON u.id = a.user_id
				  WHERE u.email = 'duplicate@example.com') AS accounts
				 FROM users WHERE email = 'duplicate@example.com'`,
			)
			.first<{ users: number; accounts: number }>();
		expect(persisted).toEqual({ users: 1, accounts: 1 });
	});

	it("allows disabling one root after another enabled root exists", async () => {
		await seedRoot(database, "root-b", "root-b@example.com");
		await expect(
			setUserEnabled(drizzle(database, { schema }), {
				id: "root-a",
				enabled: false,
				currentUserId: "root-b",
			}),
		).resolves.toEqual({ id: "root-a" });
	});

	it("revokes sessions when the edit form disables a user", async () => {
		const now = Date.now();
		await database.batch([
			database
				.prepare(
					"INSERT INTO users (id, name, email, email_verified, enabled, two_factor_enabled, created_at, updated_at) VALUES ('member-a', 'Member', 'member@example.com', 1, 1, 0, ?, ?)",
				)
				.bind(now, now),
			database
				.prepare(
					"INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES ('member-session', 'member-a', 'member-token', ?, ?, ?)",
				)
				.bind(now + 60_000, now, now),
		]);
		await updateUser(drizzle(database, { schema }), {
			id: "member-a",
			name: "Member",
			email: "member@example.com",
			enabled: false,
			currentUserId: "root-b",
		});
		const state = await database
			.prepare(
				"SELECT enabled, disabled_at, (SELECT COUNT(*) FROM sessions WHERE user_id = 'member-a') AS sessions FROM users WHERE id = 'member-a'",
			)
			.first<{
				enabled: number;
				disabled_at: number | null;
				sessions: number;
			}>();
		expect(state).toMatchObject({ enabled: 0, sessions: 0 });
		expect(state?.disabled_at).toBeTypeOf("number");
	});

	it("atomically revokes sessions when the enabled switch disables a user", async () => {
		const now = Date.now();
		await database.batch([
			database
				.prepare(
					"UPDATE users SET enabled = 1, disabled_at = NULL, updated_at = ? WHERE id = 'member-a'",
				)
				.bind(now),
			database
				.prepare(
					"INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES ('member-switch-session', 'member-a', 'member-switch-token', ?, ?, ?)",
				)
				.bind(now + 60_000, now, now),
		]);
		await setUserEnabled(drizzle(database, { schema }), {
			id: "member-a",
			enabled: false,
			currentUserId: "root-b",
		});
		const state = await database
			.prepare(
				"SELECT enabled, (SELECT COUNT(*) FROM sessions WHERE user_id = 'member-a') AS sessions FROM users WHERE id = 'member-a'",
			)
			.first<{ enabled: number; sessions: number }>();
		expect(state).toEqual({ enabled: 0, sessions: 0 });
	});

	it("atomically preserves one root during concurrent disable requests", async () => {
		await database
			.prepare(
				"UPDATE users SET enabled = 1, disabled_at = NULL WHERE id IN ('root-a', 'root-b')",
			)
			.run();
		const db = drizzle(database, { schema });
		const results = await Promise.allSettled([
			setUserEnabled(db, {
				id: "root-a",
				enabled: false,
				currentUserId: "operator",
			}),
			setUserEnabled(db, {
				id: "root-b",
				enabled: false,
				currentUserId: "operator",
			}),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const enabledRoots = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.enabled = 1 AND r.name = 'root'",
			)
			.first<{ count: number }>();
		expect(enabledRoots?.count).toBe(1);
	});

	it("atomically preserves one root during concurrent role removals", async () => {
		await database
			.prepare(
				"UPDATE users SET enabled = 1, disabled_at = NULL WHERE id IN ('root-a', 'root-b')",
			)
			.run();
		await database
			.prepare(
				"INSERT OR IGNORE INTO user_roles (id, user_id, role_id, created_at) VALUES ('root-a-restored', 'root-a', 'root-role', ?), ('root-b-restored', 'root-b', 'root-role', ?)",
			)
			.bind(Date.now(), Date.now())
			.run();
		const results = await Promise.allSettled([
			replaceUserRolesAtomically(database, {
				userId: "root-a",
				roleIds: [],
				desiredHasRoot: false,
				currentUserId: "root-manager",
				currentUserIsRoot: true,
			}),
			replaceUserRolesAtomically(database, {
				userId: "root-b",
				roleIds: [],
				desiredHasRoot: false,
				currentUserId: "root-manager",
				currentUserIsRoot: true,
			}),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const assignments = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id WHERE r.name = 'root' AND r.enabled = 1 AND u.enabled = 1",
			)
			.first<{ count: number }>();
		expect(assignments?.count).toBe(1);
	});

	it("atomically preserves one root during concurrent user deletions", async () => {
		const now = Date.now();
		await database
			.prepare(
				"INSERT OR IGNORE INTO user_roles (id, user_id, role_id, created_at) VALUES ('root-a-delete-restored', 'root-a', 'root-role', ?), ('root-b-delete-restored', 'root-b', 'root-role', ?)",
			)
			.bind(now, now)
			.run();
		await database.batch([
			database
				.prepare(
					"INSERT INTO audit_logs (id, actor_user_id, action, target_type, created_at) VALUES ('root-a-history', 'root-a', 'test.root_history', 'user', ?)",
				)
				.bind(now),
			database
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, updated_by, created_at, updated_at) VALUES ('test.root_setting', 'true', 0, 'root-b', ?, ?)",
				)
				.bind(now, now),
		]);
		const db = drizzle(database, { schema });
		const results = await Promise.allSettled([
			deleteUser(db, { id: "root-a", currentUserId: "operator" }),
			deleteUser(db, { id: "root-b", currentUserId: "operator" }),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const enabledRoots = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.enabled = 1 AND r.enabled = 1 AND r.name = 'root'",
			)
			.first<{ count: number }>();
		expect(enabledRoots?.count).toBe(1);
		const history = await database
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM audit_logs WHERE id = 'root-a-history') AS audits,
				 (SELECT COUNT(*) FROM system_settings WHERE key = 'test.root_setting') AS settings`,
			)
			.first<{ audits: number; settings: number }>();
		expect(history).toEqual({ audits: 1, settings: 1 });
		const foreignKeyViolations = await database
			.prepare("PRAGMA foreign_key_check")
			.all();
		expect(foreignKeyViolations.results).toHaveLength(0);
	});
});

async function seedRoot(database: D1Database, id: string, email: string) {
	const now = Date.now();
	await database.batch([
		database
			.prepare(
				"INSERT OR IGNORE INTO roles (id, name, description, built_in, enabled, created_at, updated_at) VALUES ('root-role', 'root', 'Root', 1, 1, ?, ?)",
			)
			.bind(now, now),
		database
			.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled, two_factor_enabled, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 0, ?, ?)",
			)
			.bind(id, id, email, now, now),
		database
			.prepare(
				"INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES (?, ?, 'root-role', ?)",
			)
			.bind(`${id}-assignment`, id, now),
	]);
}
