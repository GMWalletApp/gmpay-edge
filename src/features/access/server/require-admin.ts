import { hasGrantedPermission } from "#/features/access/permissions";
import {
	AccessDeniedError,
	type AccessSessionUser,
	type EffectiveUserAccess,
	loadEffectiveUserAccess,
	memoizeRequestAccess,
} from "#/features/access/server/access-cache";
import {
	allSystemPermissionGrants,
	type SystemPermission,
} from "#/features/access/system-rbac";
import { getSessionForRequest } from "#/features/auth/server/auth";
import { getCloudflareEnv } from "#/server/db.server";
import { measureRequestTiming } from "#/server/server-timing";

export type AdminSessionUser = AccessSessionUser;

const requestAccess = new WeakMap<Request, Promise<EffectiveUserAccess>>();

export async function requireAdmin(
	request: Request,
	permission?: SystemPermission,
) {
	const access = await loadUserAccess(request);
	if (permission && !hasPermission(access, permission)) {
		throw new AccessDeniedError(403);
	}
	return {
		...access.user,
		roles: access.roles,
		root: access.root,
	};
}

export async function getAdminPermissions(request: Request) {
	const access = await loadUserAccess(request);
	return {
		...access.user,
		roles: access.roles,
		root: access.root,
		permissions: access.root
			? [...allSystemPermissionGrants]
			: [...access.permissions].map(([module, permissionMask]) => ({
					module: module as SystemPermission["module"],
					permissionMask,
				})),
	};
}

async function loadUserAccess(request: Request) {
	return memoizeRequestAccess(requestAccess, request, async () => {
		const session = await measureRequestTiming(request, "session", () =>
			getSessionForRequest(request),
		);
		if (!session?.user) throw new AccessDeniedError(401);
		const user = session.user as AdminSessionUser;
		if (user.enabled !== true) throw new AccessDeniedError(403);
		const env = getCloudflareEnv(request);
		if (!env.DB) throw new Error("D1 binding DB is unavailable");
		const db = env.DB;
		return measureRequestTiming(request, "rbac", () =>
			loadEffectiveUserAccess(db, env.CACHE, user),
		);
	});
}

function hasPermission(
	access: EffectiveUserAccess,
	permission: SystemPermission,
) {
	return hasGrantedPermission(access.root, access.permissions, permission);
}
