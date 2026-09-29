import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	dashboardSnapshotTtlMs,
	loadAdminDashboard,
} from "#/features/dashboard/server/admin";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("admin dashboard snapshot", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-dashboard-snapshot" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
	});

	afterAll(async () => miniflare.dispose());

	it("shares one replica-session query round per binding and ten seconds", async () => {
		const counters = createDatastoreCounters();
		const binding = instrumentD1(db, counters);
		const request = () =>
			new Request("https://pay.example/_serverFn/dashboard", {
				headers: { cookie: "gmpay_d1_bookmark=0000-0001" },
			});
		const now = Date.now();

		const first = await loadAdminDashboard(request(), binding, now);
		const second = await loadAdminDashboard(request(), binding, now + 5_000);
		expect(second).toBe(first);
		expect(counters.d1Batch).toBe(1);
		expect(first.orders.total).toBe(0);

		const refreshed = await loadAdminDashboard(
			request(),
			binding,
			now + dashboardSnapshotTtlMs + 1,
		);
		expect(refreshed).not.toBe(first);
		expect(counters.d1Batch).toBe(2);
	});
});
