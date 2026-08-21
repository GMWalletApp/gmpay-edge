import { createServerOnlyFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireAdmin } from "#/features/access/server/require-admin";
import type { SystemPermission } from "#/features/access/system-rbac";
import { getCloudflareEnv } from "#/server/db.server";

export const settingsAdminContext = createServerOnlyFn(
	async (permission: SystemPermission) => {
		const request = getRequest();
		const user = await requireAdmin(request, permission);
		const env = getCloudflareEnv(request);
		if (!env.DB) throw new Error("D1 binding DB is unavailable");
		return { db: env.DB, env, request, user };
	},
);
