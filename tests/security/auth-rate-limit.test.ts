import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import { createAuth } from "#/features/auth/server/auth-factory";
import { claimAuthRateLimit } from "#/features/auth/server/rate-limit";
import { installSystem } from "#/features/installation/server/install";
import { sha256Hex } from "#/lib/crypto";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "../integration/migrations";

describe("authoritative D1 authentication rate limits", () => {
	let miniflare: Miniflare;
	let database: D1Database;
	let auth: ReturnType<typeof createAuth>;
	const email = "root@example.com";
	const password = "exact-root-password";

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-auth-rate-limit" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		const db = drizzle(database, { schema });
		const runtime = createInitialRuntimeConfig("https://pay.example");
		await installSystem(db, { name: "Root", email, password }, runtime);
		auth = createAuth(db, {
			BETTER_AUTH_SECRET: runtime.betterAuthSecret,
			BETTER_AUTH_URL: runtime.betterAuthUrl,
		});
	});

	afterAll(async () => miniflare.dispose());

	function post(path: string, ip: string, body: Record<string, string>) {
		return auth.handler(
			new Request(`https://pay.example/api/auth${path}`, {
				method: "POST",
				headers: {
					"cf-connecting-ip": ip,
					"content-type": "application/json",
					origin: "https://pay.example",
				},
				body: JSON.stringify(body),
			}),
		);
	}
	const signIn = (ip: string) =>
		post("/sign-in/email", ip, { email, password: "incorrect-password" });
	const bucket = (path: string, scope: "ip" | "email", subject: string) =>
		sha256Hex(`auth:${path}\0${scope}\0${subject}`);
	async function claimed(bucketKey: string) {
		const row = await database
			.prepare(
				"SELECT COALESCE(SUM(count), 0) AS total FROM rate_limit_counters WHERE bucket_key = ?",
			)
			.bind(bucketKey)
			.first<{ total: number }>();
		return row?.total ?? 0;
	}
	async function counterRows() {
		const row = await database
			.prepare("SELECT COUNT(*) AS count FROM rate_limit_counters")
			.first<{ count: number }>();
		return row?.count ?? 0;
	}

	it("claims one D1 window per client address and per account on every HTTP sign-in", async () => {
		for (let attempt = 0; attempt < 5; attempt += 1)
			expect((await signIn("203.0.113.5")).status).toBe(401);
		expect(
			await claimed(await bucket("/sign-in/email", "ip", "203.0.113.5")),
		).toBe(5);
		expect(await claimed(await bucket("/sign-in/email", "email", email))).toBe(
			5,
		);
		expect((await signIn("203.0.113.5")).status).toBe(429);
	});

	it("refuses from the shared D1 window before the in-memory limiter has seen the client", async () => {
		const ip = "198.51.100.77";
		const key = await bucket("/sign-in/email", "ip", ip);
		const now = Date.now();
		const currentWindow = Math.floor(now / 60_000) * 60_000;
		// Fill this and the next minute so the assertion cannot straddle a window edge.
		for (const windowStart of [currentWindow, currentWindow + 60_000])
			await database
				.prepare(
					`INSERT INTO rate_limit_counters
					 (id, bucket_key, window_start, count, expires_at, created_at, updated_at)
					 VALUES (?, ?, ?, 5, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					key,
					windowStart,
					windowStart + 120_000,
					now,
					now,
				)
				.run();
		const response = await signIn(ip);
		expect(response.status).toBe(429);
		expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(await response.json()).toMatchObject({ code: "TOO_MANY_REQUESTS" });
	});

	it("does not consume windows for trusted server-side auth.api calls", async () => {
		const before = await counterRows();
		const emailBefore = await claimed(
			await bucket("/sign-in/email", "email", email),
		);
		const response = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		expect(response.status).toBe(200);
		expect(await counterRows()).toBe(before);
		expect(await claimed(await bucket("/sign-in/email", "email", email))).toBe(
			emailBefore,
		);
	});

	it("limits password-reset requests per client address in D1", async () => {
		const reset = () =>
			post("/request-password-reset", "203.0.113.9", {
				email: "missing@example.com",
				redirectTo: "/reset-password",
			});
		for (let attempt = 0; attempt < 3; attempt += 1)
			expect((await reset()).status).toBe(200);
		expect(
			await claimed(
				await bucket("/request-password-reset", "ip", "203.0.113.9"),
			),
		).toBe(3);
		expect((await reset()).status).toBe(429);
	});

	it("enforces the per-account window across many client addresses", async () => {
		const now = 1_800_000_000_000;
		const target = "target@example.com";
		for (let attempt = 0; attempt < 30; attempt += 1)
			expect(
				await claimAuthRateLimit(database, {
					path: "/sign-in/email",
					ip: `10.0.${Math.floor(attempt / 200)}.${attempt}`,
					email: target,
					now,
				}),
			).toBeNull();
		expect(
			await claimAuthRateLimit(database, {
				path: "/sign-in/email",
				ip: "10.9.9.9",
				email: target,
				now,
			}),
		).toEqual({ retryAfterSeconds: 900 });
		expect(
			await claimAuthRateLimit(database, {
				path: "/get-session",
				ip: "10.9.9.9",
				email: target,
				now,
			}),
		).toBeNull();
		expect(
			await claimAuthRateLimit(database, {
				path: "/sign-in/email",
				ip: "10.9.9.9",
				email: target,
				now: now + 900_000,
			}),
		).toBeNull();
	});

	it("shares one window for clients without a trustworthy address", async () => {
		const now = 1_800_000_900_000;
		for (let attempt = 0; attempt < 5; attempt += 1)
			expect(
				await claimAuthRateLimit(database, {
					path: "/reset-password",
					ip: null,
					now,
				}),
			).toBeNull();
		expect(
			await claimAuthRateLimit(database, {
				path: "/reset-password",
				ip: null,
				now,
			}),
		).toEqual({ retryAfterSeconds: 60 });
	});
});
