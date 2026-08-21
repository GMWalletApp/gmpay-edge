import { z } from "zod";
import { mergeRolePermissions } from "#/features/access/permissions";
import { systemRbacModuleIds } from "#/features/access/system-rbac";
import { recordKvCacheMetric } from "#/server/cache-observability";
import type { RuntimeCache, RuntimeDatabase } from "#/server/runtime/types";

const accessCacheVersion = 1;
const accessCacheTtlSeconds = 300;
const accessCachePrefix = `rbac-access:v${accessCacheVersion}`;
const pendingLoads = new WeakMap<
	RuntimeDatabase,
	Map<string, Promise<EffectiveUserAccess>>
>();

export type AccessSessionUser = {
	id: string;
	name: string;
	email: string;
	enabled: boolean | null | undefined;
	updatedAt: Date | string;
};

export type EffectiveUserAccess = {
	user: AccessSessionUser;
	roles: string[];
	root: boolean;
	permissions: ReadonlyMap<string, number>;
};

export class AccessDeniedError extends Error {
	constructor(readonly status: 401 | 403) {
		super(status === 401 ? "Unauthorized" : "Forbidden");
		this.name = "AccessDeniedError";
	}
}

const cachedAccessSchema = z
	.object({
		version: z.literal(accessCacheVersion),
		userId: z.string().min(1),
		revision: z.number().int().nonnegative(),
		roles: z.array(z.string().min(1).max(64)).min(1),
		root: z.boolean(),
		permissions: z.array(
			z.object({
				module: z.enum(systemRbacModuleIds),
				permissionMask: z.number().int().positive(),
			}),
		),
	})
	.refine(({ root, roles }) => root === roles.includes("root"));

type CachedUserAccess = z.infer<typeof cachedAccessSchema>;

export async function loadEffectiveUserAccess(
	db: RuntimeDatabase,
	kv: RuntimeCache | undefined,
	user: AccessSessionUser,
): Promise<EffectiveUserAccess> {
	if (user.enabled !== true) throw new AccessDeniedError(403);
	const revision = accessRevision(user.updatedAt);
	const key = `${accessCachePrefix}:${user.id}:${revision}`;
	const bindingLoads = bindingPendingLoads(db);
	const pending = bindingLoads.get(key);
	if (pending) return { ...(await pending), user };

	const load = (async () => {
		const cached = await readCachedAccess(kv, key, user.id, revision);
		return cached
			? hydrateAccess(user, cached)
			: loadAuthoritativeAccess(db, kv, key, user, revision);
	})();
	bindingLoads.set(key, load);
	try {
		return await load;
	} finally {
		if (bindingLoads.get(key) === load) bindingLoads.delete(key);
	}
}

function bindingPendingLoads(db: RuntimeDatabase) {
	const existing = pendingLoads.get(db);
	if (existing) return existing;
	const loads = new Map<string, Promise<EffectiveUserAccess>>();
	pendingLoads.set(db, loads);
	return loads;
}

async function loadAuthoritativeAccess(
	db: RuntimeDatabase,
	kv: RuntimeCache | undefined,
	key: string,
	user: AccessSessionUser,
	revision: number,
) {
	const rows = await db
		.prepare(`SELECT r.name, rp.module, rp.permission_mask
			FROM user_roles ur
			JOIN roles r ON r.id = ur.role_id
			LEFT JOIN role_permissions rp ON rp.role_id = r.id
			WHERE ur.user_id = ? AND r.enabled = 1
			ORDER BY r.name, rp.module`)
		.bind(user.id)
		.all<{
			name: string;
			module: string | null;
			permission_mask: number | null;
		}>();
	const roleNames = [...new Set(rows.results.map((row) => row.name))];
	if (roleNames.length === 0) throw new AccessDeniedError(403);
	const root = roleNames.includes("root");
	const permissions = root
		? new Map<string, number>()
		: mergeRolePermissions(
				rows.results.flatMap(({ module, permission_mask }) =>
					isSystemModule(module) && permission_mask !== null
						? [{ module, permissionMask: permission_mask }]
						: [],
				),
			);
	const snapshot: CachedUserAccess = {
		version: accessCacheVersion,
		userId: user.id,
		revision,
		roles: roleNames,
		root,
		permissions: systemRbacModuleIds.flatMap((module) => {
			const permissionMask = permissions.get(module);
			return permissionMask ? [{ module, permissionMask }] : [];
		}),
	};
	await writeCachedAccess(kv, key, snapshot);
	return { user, roles: roleNames, root, permissions };
}

export function memoizeRequestAccess(
	cache: WeakMap<Request, Promise<EffectiveUserAccess>>,
	request: Request,
	load: () => Promise<EffectiveUserAccess>,
) {
	const cached = cache.get(request);
	if (cached) return cached;
	const pending = load();
	cache.set(request, pending);
	return pending;
}

function accessRevision(value: Date | string) {
	const revision = value instanceof Date ? value.getTime() : Date.parse(value);
	if (!Number.isSafeInteger(revision) || revision < 0)
		throw new Error("Invalid session user revision");
	return revision;
}

async function readCachedAccess(
	kv: RuntimeCache | undefined,
	key: string,
	userId: string,
	revision: number,
) {
	if (!kv) return null;
	const startedAt = performance.now();
	try {
		const value = await kv.get(key);
		if (!value) {
			recordKvCacheMetric(
				{ cache: "rbac_access", operation: "read", outcome: "miss" },
				startedAt,
			);
			return null;
		}
		const parsed = parseCachedAccess(value, userId, revision);
		recordKvCacheMetric(
			{
				cache: "rbac_access",
				operation: "read",
				outcome: parsed ? "hit" : "corrupt",
			},
			startedAt,
		);
		return parsed;
	} catch {
		recordKvCacheMetric(
			{ cache: "rbac_access", operation: "read", outcome: "fallback" },
			startedAt,
		);
		return null;
	}
}

async function writeCachedAccess(
	kv: RuntimeCache | undefined,
	key: string,
	value: CachedUserAccess,
) {
	if (!kv) return;
	const startedAt = performance.now();
	try {
		await kv.put(key, JSON.stringify(value), {
			expirationTtl: accessCacheTtlSeconds,
		});
		recordKvCacheMetric(
			{ cache: "rbac_access", operation: "write", outcome: "success" },
			startedAt,
		);
	} catch {
		recordKvCacheMetric(
			{ cache: "rbac_access", operation: "write", outcome: "fallback" },
			startedAt,
		);
		// D1 remains authoritative when optional KV is unavailable.
	}
}

function parseCachedAccess(
	value: string,
	userId: string,
	revision: number,
): CachedUserAccess | null {
	try {
		const parsed = cachedAccessSchema.safeParse(JSON.parse(value));
		if (!parsed.success) return null;
		return parsed.data.userId === userId && parsed.data.revision === revision
			? parsed.data
			: null;
	} catch {
		return null;
	}
}

function hydrateAccess(
	user: AccessSessionUser,
	snapshot: CachedUserAccess,
): EffectiveUserAccess {
	return {
		user,
		roles: snapshot.roles,
		root: snapshot.root,
		permissions: mergeRolePermissions(snapshot.permissions),
	};
}

function isSystemModule(
	value: string | null,
): value is (typeof systemRbacModuleIds)[number] {
	return systemRbacModuleIds.some((module) => module === value);
}
