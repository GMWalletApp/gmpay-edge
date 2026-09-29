import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteCustomRole } from "#/features/access/server/role-delete";
import { createAuditStatement } from "#/server/audit";
import { applyMigrations } from "./migrations";

describe("custom role deletion", () => {
	let miniflare: Miniflare;
	let database: D1Database;
	const request = new Request("https://pay.example/admin/access", {
		headers: { "x-request-id": "role-delete-request" },
	});

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-roles-delete" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		const now = Date.now();
		await database.batch([
			database
				.prepare(
					"INSERT INTO users (id, name, email, email_verified, enabled, two_factor_enabled, created_at, updated_at) VALUES ('actor', 'Actor', 'actor@example.com', 1, 1, 0, ?, ?), ('member', 'Member', 'member@example.com', 1, 1, 0, ?, ?)",
				)
				.bind(now, now, now, now),
			database
				.prepare(
					`INSERT INTO roles (id, name, built_in, enabled, created_at, updated_at) VALUES
					 ('root-role', 'root', 1, 1, ?, ?),
					 ('unassigned-role', 'unassigned', 0, 1, ?, ?),
					 ('assigned-role', 'assigned', 0, 1, ?, ?),
					 ('racing-role', 'racing', 0, 1, ?, ?)`,
				)
				.bind(now, now, now, now, now, now, now, now),
			database
				.prepare(
					"INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES ('member-assigned', 'member', 'assigned-role', ?)",
				)
				.bind(now),
		]);
	});

	afterAll(async () => miniflare.dispose());

	const audit = (id: string) =>
		createAuditStatement(database, request, "actor", {
			action: "role.deleted",
			targetType: "role",
			targetId: id,
		});
	async function count(sql: string) {
		const row = await database.prepare(sql).first<{ count: number }>();
		return row?.count ?? 0;
	}
	const auditCount = () =>
		count(
			"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'role.deleted'",
		);

	it("deletes an unassigned custom role together with its audit row", async () => {
		await expect(
			deleteCustomRole(database, "unassigned-role", audit("unassigned-role")),
		).resolves.toEqual({ id: "unassigned-role" });
		expect(
			await count(
				"SELECT COUNT(*) AS count FROM roles WHERE id = 'unassigned-role'",
			),
		).toBe(0);
		expect(await auditCount()).toBe(1);
	});

	it("refuses built-in, missing, and assigned roles without auditing", async () => {
		await expect(
			deleteCustomRole(database, "root-role", audit("root-role")),
		).rejects.toMatchObject({ code: "built_in_role", status: 409 });
		await expect(
			deleteCustomRole(database, "missing-role", audit("missing-role")),
		).rejects.toMatchObject({ code: "role_not_found", status: 404 });
		await expect(
			deleteCustomRole(database, "assigned-role", audit("assigned-role")),
		).rejects.toMatchObject({ code: "role_in_use", status: 409 });
		expect(
			await count(
				"SELECT COUNT(*) AS count FROM roles WHERE id IN ('root-role', 'assigned-role')",
			),
		).toBe(2);
		expect(
			await count(
				"SELECT COUNT(*) AS count FROM user_roles WHERE id = 'member-assigned'",
			),
		).toBe(1);
		expect(await auditCount()).toBe(1);
	});

	it("keeps a role that is bound concurrently instead of cascading the binding away", async () => {
		const racing = new Proxy(database, {
			get(target, property) {
				if (property === "batch")
					return async (statements: D1PreparedStatement[]) => {
						await database
							.prepare(
								"INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES ('member-racing', 'member', 'racing-role', 1)",
							)
							.run();
						return database.batch(statements);
					};
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await expect(
			deleteCustomRole(racing, "racing-role", audit("racing-role")),
		).rejects.toMatchObject({ code: "role_in_use", status: 409 });
		expect(
			await count(
				"SELECT COUNT(*) AS count FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE r.id = 'racing-role' AND ur.id = 'member-racing'",
			),
		).toBe(1);
		expect(await auditCount()).toBe(1);
	});
});
