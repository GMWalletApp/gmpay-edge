import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { replaceUserRolesAtomically } from "#/features/users/server/role-assignments";
import {
	createUser,
	deleteUser,
	type ListUsersInput,
	listUsers,
	setUserEnabled,
	type UserFormInput,
	updateUser,
} from "#/features/users/server/users";
import { DomainError } from "#/lib/domain-error";
import { createAuditStatement } from "#/server/audit";
import { getAdminServerContext } from "#/server/context";

const listUsersInput = z.object({
	pageIndex: z.number().int().min(0).optional(),
	pageSize: z.number().int().min(1).max(100).optional(),
	search: z.string().max(200).optional(),
});

const userInput = z.object({
	id: z.uuid().optional(),
	name: z.string().trim().min(2).max(100),
	email: z.email(),
	enabled: z.boolean(),
	password: z.string().max(200).optional(),
});

export const listUsersFn = createServerFn({ method: "GET" })
	.validator((input: ListUsersInput) => listUsersInput.parse(input))
	.handler(async ({ data }) => {
		const { db } = await getAdminServerContext(
			systemPermission("users", "read"),
		);
		return listUsers(db, {
			...(data.pageIndex === undefined ? {} : { pageIndex: data.pageIndex }),
			...(data.pageSize === undefined ? {} : { pageSize: data.pageSize }),
			...(data.search === undefined ? {} : { search: data.search }),
		});
	});

// Every audit row below is handed to the mutation so it commits in the same
// guarded D1 batch: a rejected change leaves no audit trail behind.
export const saveUserFn = createServerFn({ method: "POST" })
	.validator((input: UserFormInput) => userInput.parse(input))
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("users", data.id ? "update" : "create"),
		);
		const id = data.id ?? crypto.randomUUID();
		const user = {
			id,
			name: data.name,
			email: data.email,
			enabled: data.enabled,
			...(data.password === undefined ? {} : { password: data.password }),
			audit: createAuditStatement(db.$client, request, currentUser.id, {
				action: data.id ? "user.updated" : "user.created",
				targetType: "user",
				targetId: id,
				after: {
					name: data.name,
					email: data.email.trim().toLowerCase(),
					enabled: data.enabled,
					passwordChanged: Boolean(data.password),
				},
			}),
		};
		return data.id
			? updateUser(db, { ...user, currentUserId: currentUser.id })
			: createUser(db, user);
	});

export const setUserEnabledFn = createServerFn({ method: "POST" })
	.validator((input: { id: string; enabled: boolean }) =>
		z.object({ id: z.uuid(), enabled: z.boolean() }).parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("users", "update"),
		);
		return setUserEnabled(db, {
			...data,
			currentUserId: currentUser.id,
			audit: createAuditStatement(db.$client, request, currentUser.id, {
				action: "user.enabled_changed",
				targetType: "user",
				targetId: data.id,
				after: { enabled: data.enabled },
			}),
		});
	});

export const deleteUserFn = createServerFn({ method: "POST" })
	.validator((input: { id: string }) => z.object({ id: z.uuid() }).parse(input))
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("users", "delete"),
		);
		return deleteUser(db, {
			id: data.id,
			currentUserId: currentUser.id,
			audit: createAuditStatement(db.$client, request, currentUser.id, {
				action: "user.deleted",
				targetType: "user",
				targetId: data.id,
			}),
		});
	});

export const setUserRolesFn = createServerFn({ method: "POST" })
	.validator((input: { userId: string; roleIds: string[] }) =>
		z
			.object({
				userId: z.uuid(),
				roleIds: z.array(z.uuid()).transform((ids) => [...new Set(ids)]),
			})
			.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("users", "update"),
		);
		const roles = data.roleIds.length
			? await db.$client
					.prepare(
						`SELECT id, name FROM roles WHERE enabled = 1 AND id IN (${data.roleIds.map(() => "?").join(",")})`,
					)
					.bind(...data.roleIds)
					.all<{ id: string; name: string }>()
			: { results: [] as Array<{ id: string; name: string }> };
		if (roles.results.length !== data.roleIds.length)
			throw new DomainError(
				"role_unavailable",
				409,
				"Unknown or disabled role",
			);
		return replaceUserRolesAtomically(db.$client, {
			...data,
			desiredHasRoot: roles.results.some((role) => role.name === "root"),
			currentUserId: currentUser.id,
			currentUserIsRoot: currentUser.root,
			audit: createAuditStatement(db.$client, request, currentUser.id, {
				action: "user.roles_replaced",
				targetType: "user",
				targetId: data.userId,
				after: { roleIds: [...data.roleIds].sort() },
			}),
		});
	});
