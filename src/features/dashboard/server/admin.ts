import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireAdmin } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import { queryAdminDashboard } from "#/features/dashboard/server/query";
import { getCloudflareEnv } from "#/server/db.server";
import { createIsolateSnapshot } from "#/server/isolate-snapshot";
import { readDatabase } from "#/server/read-replica";

export const dashboardSnapshotTtlMs = 10_000;

const dashboardSnapshot = createIsolateSnapshot<
	Awaited<ReturnType<typeof queryAdminDashboard>>
>(dashboardSnapshotTtlMs);

/**
 * The dashboard aggregates whole tables; every viewer polling it shares one
 * replica-served query round per isolate and ten seconds.
 */
export function loadAdminDashboard(
	request: Request,
	db: D1Database,
	now = Date.now(),
) {
	return dashboardSnapshot(
		db,
		() => queryAdminDashboard(readDatabase(request, db), now),
		now,
	);
}

export const getAdminDashboardFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const request = getRequest();
		await requireAdmin(request, systemPermission("dashboard", "read"));
		const db = getCloudflareEnv(request).DB;
		if (!db) throw new Error("D1 binding DB is unavailable");
		return loadAdminDashboard(request, db);
	},
);
