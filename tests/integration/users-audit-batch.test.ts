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
import { createAuditStatement } from "#/server/audit";
import { applyMigrations } from "./migrations";

describe("user administration audit batches", () => {
	let miniflare: Miniflare;
	let database: D1Database;
	const request = new Request("https://pay.example/admin/users", {
		headers: {
			"x-request-id": "users-audit-batch",
			"cf-connecting-ip": "203.0.113.7",
		},
	});

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-users-audit-batch" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		const now = Date.now();
		await database.batch([
			database
				.prepare(
					"INSERT INTO roles (id, name, built_in, enabled, created_at, updated_at) VALUES ('root-role', 'root', 1, 1, ?, ?), ('operator-role', 'operator', 0, 1, ?, ?)",
				)
				.bind(now, now, now, now),
			database
				.prepare(
					"INSERT INTO users (id, name, email, email_verified, enabled, two_factor_enabled, created_at, updated_at) VALUES ('root-a', 'Root A', 'root-a@example.com', 1, 1, 0, ?, ?), ('operator', 'Operator', 'operator@example.com', 1, 1, 0, ?, ?)",
				)
				.bind(now, now, now, now),
			database
				.prepare(
					"INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES ('root-a-root', 'root-a', 'root-role', ?), ('operator-operator', 'operator', 'operator-role', ?)",
				)
				.bind(now, now),
		]);
	});

	afterAll(async () => miniflare.dispose());

	const db = () => drizzle(database, { schema });
	const audit = (action: string, targetId: string) =>
		createAuditStatement(database, request, "root-a", {
			action,
			targetType: "user",
			targetId,
		});
	async function auditCount(action: string) {
		const row = await database
			.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = ?")
			.bind(action)
			.first<{ count: number }>();
		return row?.count ?? 0;
	}

	it("commits the creation audit with the user and none for a duplicate email", async () => {
		await createUser(db(), {
			id: "member-id",
			name: "Member",
			email: "member@example.com",
			enabled: true,
			password: "member-password-1",
			audit: audit("user.created", "member-id"),
		});
		expect(await auditCount("user.created")).toBe(1);
		await expect(
			createUser(db(), {
				id: "member-dup",
				name: "Duplicate",
				email: "MEMBER@example.com",
				enabled: true,
				password: "member-password-2",
				audit: audit("user.created", "member-dup"),
			}),
		).rejects.toMatchObject({ code: "email_in_use", status: 409 });
		expect(await auditCount("user.created")).toBe(1);
		await expect(
			database
				.prepare(
					"SELECT COUNT(*) AS count FROM accounts WHERE user_id = 'member-dup'",
				)
				.first(),
		).resolves.toEqual({ count: 0 });
		await expect(
			database
				.prepare(
					"SELECT request_id, ip_address FROM audit_logs WHERE action = 'user.created'",
				)
				.first(),
		).resolves.toEqual({
			request_id: "users-audit-batch",
			ip_address: "203.0.113.7",
		});
	});

	it("writes exactly one audit row for an accepted update and none for a rejected one", async () => {
		await expect(
			updateUser(db(), {
				id: "root-a",
				name: "Root A",
				email: "root-a@example.com",
				enabled: true,
				currentUserId: "operator",
				audit: audit("user.updated", "root-a"),
			}),
		).rejects.toMatchObject({ code: "root_role_required", status: 403 });
		expect(await auditCount("user.updated")).toBe(0);
		await updateUser(db(), {
			id: "member-id",
			name: "Member Renamed",
			email: "member@example.com",
			enabled: true,
			currentUserId: "root-a",
			audit: audit("user.updated", "member-id"),
		});
		expect(await auditCount("user.updated")).toBe(1);
	});

	it("audits enable switches only when the state actually changes", async () => {
		await setUserEnabled(db(), {
			id: "member-id",
			enabled: false,
			currentUserId: "root-a",
			audit: audit("user.enabled_changed", "member-id"),
		});
		expect(await auditCount("user.enabled_changed")).toBe(1);
		await setUserEnabled(db(), {
			id: "member-id",
			enabled: false,
			currentUserId: "root-a",
			audit: audit("user.enabled_changed", "member-id"),
		});
		expect(await auditCount("user.enabled_changed")).toBe(1);
		await expect(
			setUserEnabled(db(), {
				id: "root-a",
				enabled: true,
				currentUserId: "operator",
				audit: audit("user.enabled_changed", "root-a"),
			}),
		).rejects.toMatchObject({ code: "root_role_required", status: 403 });
		expect(await auditCount("user.enabled_changed")).toBe(1);
		await setUserEnabled(db(), {
			id: "member-id",
			enabled: true,
			currentUserId: "root-a",
			audit: audit("user.enabled_changed", "member-id"),
		});
		expect(await auditCount("user.enabled_changed")).toBe(2);
	});

	it("audits role replacement only when the membership changed as requested", async () => {
		await expect(
			replaceUserRolesAtomically(database, {
				userId: "member-id",
				roleIds: ["root-role"],
				desiredHasRoot: true,
				currentUserId: "operator",
				currentUserIsRoot: false,
				audit: audit("user.roles_replaced", "member-id"),
			}),
		).rejects.toMatchObject({ code: "root_role_required", status: 403 });
		expect(await auditCount("user.roles_replaced")).toBe(0);
		await expect(
			replaceUserRolesAtomically(database, {
				userId: "member-id",
				roleIds: ["operator-role"],
				desiredHasRoot: false,
				currentUserId: "root-a",
				currentUserIsRoot: true,
				audit: audit("user.roles_replaced", "member-id"),
			}),
		).resolves.toEqual({ userId: "member-id", roleIds: ["operator-role"] });
		expect(await auditCount("user.roles_replaced")).toBe(1);
	});

	it("audits deletion only when a row was removed", async () => {
		await expect(
			deleteUser(db(), {
				id: "root-a",
				currentUserId: "operator",
				audit: audit("user.deleted", "root-a"),
			}),
		).rejects.toMatchObject({ code: "root_role_required", status: 403 });
		expect(await auditCount("user.deleted")).toBe(0);
		await deleteUser(db(), {
			id: "member-id",
			currentUserId: "root-a",
			audit: audit("user.deleted", "member-id"),
		});
		expect(await auditCount("user.deleted")).toBe(1);
		await expect(
			deleteUser(db(), {
				id: "member-id",
				currentUserId: "root-a",
				audit: audit("user.deleted", "member-id"),
			}),
		).resolves.toEqual({ id: "member-id" });
		expect(await auditCount("user.deleted")).toBe(1);
	});
});
