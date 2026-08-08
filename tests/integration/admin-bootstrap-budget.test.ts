import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "#/db/schema";
import { loadAdminBootstrap } from "#/features/auth/server/admin-bootstrap";
import { createAuth } from "#/features/auth/server/auth-factory";
import { installSystem } from "#/features/installation/server/install";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import {
	createDatastoreCounters,
	instrumentD1,
	instrumentKv,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

const workerEnv = vi.hoisted(() => ({
	bindings: {} as Partial<Env>,
}));

vi.mock("cloudflare:workers", () => ({
	env: workerEnv.bindings,
	waitUntil: vi.fn(),
}));

describe("admin bootstrap request budget", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let cache: KVNamespace;
	let cookie: string;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-admin-bootstrap-budget" },
			kvNamespaces: { CACHE: "gmpay-edge-admin-bootstrap-cache" },
		});
		db = await miniflare.getD1Database("DB");
		cache = (await miniflare.getKVNamespace("CACHE")) as unknown as KVNamespace;
		await applyMigrations(db);
		const runtime = createInitialRuntimeConfig("https://pay.example");
		await installSystem(
			drizzle(db, { schema }),
			{
				name: "Root",
				email: "root@example.com",
				password: "exact-root-password",
			},
			runtime,
		);
		const auth = createAuth(drizzle(db, { schema }), {
			BETTER_AUTH_SECRET: runtime.betterAuthSecret,
			BETTER_AUTH_URL: runtime.betterAuthUrl,
		});
		const response = await auth.api.signInEmail({
			body: {
				email: "root@example.com",
				password: "exact-root-password",
			},
			asResponse: true,
		});
		cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
	});

	afterAll(async () => miniflare.dispose());

	it("uses one settings read and one authoritative RBAC read when cold", async () => {
		const counters = createDatastoreCounters();
		workerEnv.bindings.DB = instrumentD1(db, counters);
		workerEnv.bindings.CACHE = instrumentKv(cache, counters);

		await expect(loadAdminBootstrap(request("cold"))).resolves.toMatchObject({
			installed: true,
			access: { email: "root@example.com", root: true },
		});
		expect(counters).toMatchObject({
			d1Prepare: 5,
			d1StatementFirst: 1,
			d1StatementAll: 2,
			d1StatementRaw: 2,
			d1Batch: 0,
			kvGet: 1,
			kvPut: 1,
		});
	});

	it("uses the versioned RBAC cache on a later request", async () => {
		const counters = createDatastoreCounters();
		workerEnv.bindings.DB = instrumentD1(db, counters);
		workerEnv.bindings.CACHE = instrumentKv(cache, counters);

		await expect(loadAdminBootstrap(request("warm"))).resolves.toMatchObject({
			installed: true,
			access: { email: "root@example.com", root: true },
		});
		expect(counters).toMatchObject({
			d1Prepare: 4,
			d1StatementFirst: 1,
			d1StatementAll: 1,
			d1StatementRaw: 2,
			d1Batch: 0,
			kvGet: 1,
			kvPut: 0,
		});
	});

	function request(id: string) {
		return new Request("https://pay.example/admin", {
			headers: { cookie, "x-request-id": `bootstrap-${id}` },
		});
	}
});
