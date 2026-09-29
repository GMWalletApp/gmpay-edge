import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { bumpRoleUsersAccessRevisionStatement } from "#/features/access/server/access-revision";
import { requireAdmin } from "#/features/access/server/require-admin";
import { deleteCustomRole } from "#/features/access/server/role-delete";
import { setCustomRoleEnabled } from "#/features/access/server/role-enabled";
import {
	allSystemPermissionGrants,
	normalizeSystemPermissionGrants,
	type SystemPermissionGrant,
	systemPermission,
	systemRbacModuleIds,
} from "#/features/access/system-rbac";
import { DomainError } from "#/lib/domain-error";
import { createAuditStatement } from "#/server/audit";
import { getCloudflareEnv } from "#/server/db.server";

export const listSystemAccessFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db } = await context(systemPermission("roles", "read"));
		const [roles, permissions] = await Promise.all([
			db
				.prepare(`SELECT r.id, r.name, r.description, r.built_in, r.enabled,
				 r.created_at, COUNT(ur.id) AS user_count
				 FROM roles r LEFT JOIN user_roles ur ON ur.role_id = r.id
				 GROUP BY r.id ORDER BY r.built_in DESC, r.name`)
				.all<{
					id: string;
					name: string;
					description: string | null;
					built_in: number;
					enabled: number;
					created_at: number;
					user_count: number;
				}>(),
			db
				.prepare(
					"SELECT role_id, module, permission_mask FROM role_permissions",
				)
				.all<{
					role_id: string;
					module: string;
					permission_mask: number;
				}>(),
		]);
		const byRole = new Map<string, SystemPermissionGrant[]>();
		for (const row of permissions.results) {
			const list = byRole.get(row.role_id) ?? [];
			if (systemRbacModuleIds.includes(row.module as never))
				list.push({
					module: row.module as SystemPermissionGrant["module"],
					permissionMask: row.permission_mask,
				});
			byRole.set(row.role_id, list);
		}
		return {
			roles: roles.results.map((role) => ({
				id: role.id,
				name: role.name,
				description: role.description,
				permissions:
					role.name === "root"
						? [...allSystemPermissionGrants]
						: (byRole.get(role.id) ?? []),
				memberCount: role.user_count,
				protected: Boolean(role.built_in),
				enabled: Boolean(role.enabled),
				createdAt: new Date(role.created_at).toISOString(),
			})),
		};
	},
);

const roleInput = z.object({
	id: z.uuid().optional(),
	name: z
		.string()
		.trim()
		.min(2)
		.max(64)
		.regex(/^[a-z][a-z0-9_-]*$/),
	description: z.string().trim().max(240).optional(),
	permissions: z.array(
		z.object({
			module: z.enum(systemRbacModuleIds),
			permissionMask: z.number().int().nonnegative(),
		}),
	),
});

export const saveSystemRoleFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof roleInput>) => roleInput.parse(input))
	.handler(async ({ data }) => {
		const { db, request, user } = await context(
			systemPermission("roles", data.id ? "update" : "create"),
		);
		const now = Date.now();
		const id = data.id ?? crypto.randomUUID();
		const permissions = normalizeSystemPermissionGrants(data.permissions);
		if (data.id) {
			const role = await db
				.prepare("SELECT built_in FROM roles WHERE id = ? LIMIT 1")
				.bind(id)
				.first<{ built_in: number }>();
			if (!role) throw new DomainError("role_not_found", 404, "Role not found");
			if (role.built_in)
				throw new DomainError(
					"built_in_role",
					409,
					"Built-in roles cannot be edited",
				);
		}
		const statements: D1PreparedStatement[] = [
			data.id
				? db
						.prepare(
							"UPDATE roles SET name = ?, description = ?, updated_at = ? WHERE id = ? AND built_in = 0",
						)
						.bind(data.name, data.description || null, now, id)
				: db
						.prepare(
							"INSERT INTO roles (id, name, description, built_in, enabled, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)",
						)
						.bind(id, data.name, data.description || null, now, now),
			db.prepare("DELETE FROM role_permissions WHERE role_id = ?").bind(id),
		];
		for (const permission of permissions) {
			statements.push(
				db
					.prepare(
						"INSERT INTO role_permissions (id, role_id, module, permission_mask, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
					)
					.bind(
						crypto.randomUUID(),
						id,
						permission.module,
						permission.permissionMask,
						now,
						now,
					),
			);
		}
		if (data.id)
			statements.push(bumpRoleUsersAccessRevisionStatement(db, id, now));
		statements.push(
			createAuditStatement(db, request, user.id, {
				action: data.id ? "role.updated" : "role.created",
				targetType: "role",
				targetId: id,
				after: {
					name: data.name,
					description: data.description || null,
					permissions,
				},
			}),
		);
		await db.batch(statements);
		return { id };
	});

export const deleteSystemRoleFn = createServerFn({ method: "POST" })
	.validator((input: { id: string }) => z.object({ id: z.uuid() }).parse(input))
	.handler(async ({ data }) => {
		const { db, request, user } = await context(
			systemPermission("roles", "delete"),
		);
		return deleteCustomRole(
			db,
			data.id,
			createAuditStatement(db, request, user.id, {
				action: "role.deleted",
				targetType: "role",
				targetId: data.id,
			}),
		);
	});

export const setSystemRoleEnabledFn = createServerFn({ method: "POST" })
	.validator((input: { id: string; enabled: boolean }) =>
		z.object({ id: z.uuid(), enabled: z.boolean() }).parse(input),
	)
	.handler(async ({ data }) => {
		const { db, request, user } = await context(
			systemPermission("roles", "update"),
		);
		return setCustomRoleEnabled(
			db,
			data.id,
			data.enabled,
			createAuditStatement(db, request, user.id, {
				action: "role.enabled_changed",
				targetType: "role",
				targetId: data.id,
				after: { enabled: data.enabled },
			}),
		);
	});

async function context(permission: ReturnType<typeof systemPermission>) {
	const request = getRequest();
	const user = await requireAdmin(request, permission);
	const db = getCloudflareEnv(request).DB;
	if (!db) throw new Error("D1 binding DB is unavailable");
	return { db, request, user };
}
