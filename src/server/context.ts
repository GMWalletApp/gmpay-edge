import { getRequest } from "@tanstack/react-start/server";

import { requireAdmin } from "#/features/access/server/require-admin";
import type { SystemPermission } from "#/features/access/system-rbac";
import { getDb } from "./db.server";

export async function getAdminServerContext(permission: SystemPermission) {
	const request = getRequest();
	const currentUser = await requireAdmin(request, permission);

	return {
		request,
		currentUser,
		db: getDb(request),
	};
}
