import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import { createAuth } from "#/features/auth/server/auth-factory";
import { installSystem } from "#/features/installation/server/install";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("Better Auth account security flow", () => {
	let miniflare: Miniflare;
	let database: D1Database;
	let auth: ReturnType<typeof createAuth>;
	let runtime: ReturnType<typeof createInitialRuntimeConfig>;
	const email = "root@example.com";
	const password = "exact-root-password";

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-better-auth-flow" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		const db = drizzle(database, { schema });
		runtime = createInitialRuntimeConfig("https://pay.example");
		await installSystem(
			db,
			{
				name: "Root",
				email,
				password,
			},
			runtime,
		);
		auth = createAuth(db, {
			BETTER_AUTH_SECRET: runtime.betterAuthSecret,
			BETTER_AUTH_URL: runtime.betterAuthUrl,
		});
	});

	afterAll(async () => miniflare.dispose());

	it("keeps an authenticated Better Auth session read within an explicit D1 budget", async () => {
		const signedIn = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		const counters = createDatastoreCounters();
		const countedAuth = createAuth(
			drizzle(instrumentD1(database, counters), { schema }),
			{
				BETTER_AUTH_SECRET: runtime.betterAuthSecret,
				BETTER_AUTH_URL: runtime.betterAuthUrl,
			},
		);
		await expect(
			countedAuth.api.getSession({
				headers: { cookie: responseCookie(signedIn) },
			}),
		).resolves.toMatchObject({ user: { email } });
		expect(counters).toMatchObject({
			d1Prepare: 2,
			d1StatementBind: 2,
			d1StatementRaw: 2,
			d1StatementFirst: 0,
			d1StatementAll: 0,
			d1StatementRun: 0,
			d1Batch: 0,
		});
	});

	it("keys authentication rate limits by Cloudflare's client address", async () => {
		const rateLimitedAuth = createAuth(drizzle(database, { schema }), {
			BETTER_AUTH_SECRET: runtime.betterAuthSecret,
			BETTER_AUTH_URL: runtime.betterAuthUrl,
		});
		const attempt = (ipAddress: string) =>
			rateLimitedAuth.handler(
				new Request(`${runtime.betterAuthUrl}/api/auth/sign-in/email`, {
					method: "POST",
					headers: {
						"cf-connecting-ip": ipAddress,
						"content-type": "application/json",
						origin: runtime.betterAuthUrl,
					},
					body: JSON.stringify({ email, password: "incorrect-password" }),
				}),
			);
		for (let attemptIndex = 0; attemptIndex < 5; attemptIndex += 1) {
			expect((await attempt("192.0.2.10")).status).not.toBe(429);
		}
		expect((await attempt("192.0.2.10")).status).toBe(429);
		expect((await attempt("198.51.100.10")).status).not.toBe(429);
	});

	it("enables, verifies, challenges and disables TOTP with a backup code", async () => {
		const signedIn = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		expect(signedIn.status).toBe(200);
		let cookie = responseCookie(signedIn);
		const setupResponse = await auth.api.enableTwoFactor({
			headers: { cookie },
			body: { password, issuer: "GMPay Edge" },
			asResponse: true,
		});
		expect(setupResponse.status).toBe(200);
		const setup = (await setupResponse.json()) as {
			totpURI: string;
			backupCodes: string[];
		};
		expect(setup.backupCodes.length).toBeGreaterThan(0);
		const secret = new URL(setup.totpURI).searchParams.get("secret");
		if (!secret) throw new Error("TOTP URI did not contain a secret");
		const verified = await auth.api.verifyTOTP({
			headers: { cookie },
			body: {
				code: await createOTP(
					new TextDecoder().decode(base32.decode(secret)),
				).totp(),
			},
			asResponse: true,
		});
		expect(verified.status, await verified.clone().text()).toBe(200);
		cookie = mergeResponseCookie(cookie, verified);
		const enabled = await database
			.prepare("SELECT two_factor_enabled FROM users WHERE email = ? LIMIT 1")
			.bind(email)
			.first<{ two_factor_enabled: number }>();
		expect(enabled?.two_factor_enabled).toBe(1);

		await auth.api.signOut({ headers: { cookie }, asResponse: true });
		const challenged = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		expect(challenged.status).toBe(200);
		const challengeBody = (await challenged.clone().json()) as {
			twoFactorRedirect?: boolean;
		};
		expect(challengeBody.twoFactorRedirect).toBe(true);
		const challengeCookie = responseCookie(challenged);
		const recovered = await auth.api.verifyBackupCode({
			headers: { cookie: challengeCookie },
			body: { code: setup.backupCodes[0] ?? "", trustDevice: false },
			asResponse: true,
		});
		expect(recovered.status).toBe(200);
		const recoveredCookie = mergeResponseCookie(challengeCookie, recovered);
		const reused = await auth.api.verifyBackupCode({
			headers: { cookie: challengeCookie },
			body: { code: setup.backupCodes[0] ?? "", trustDevice: false },
			asResponse: true,
		});
		expect(reused.status).toBeGreaterThanOrEqual(400);

		const disabled = await auth.api.disableTwoFactor({
			headers: { cookie: recoveredCookie },
			body: { password },
			asResponse: true,
		});
		expect(disabled.status).toBe(200);
		const finalState = await database
			.prepare(
				`SELECT u.two_factor_enabled,
				 (SELECT COUNT(*) FROM two_factors tf WHERE tf.user_id = u.id) AS configurations
				 FROM users u WHERE u.email = ? LIMIT 1`,
			)
			.bind(email)
			.first<{ two_factor_enabled: number; configurations: number }>();
		expect(finalState).toEqual({
			two_factor_enabled: 0,
			configurations: 0,
		});
	});

	it("audits self-service password changes without storing either password", async () => {
		const signedIn = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		const cookie = responseCookie(signedIn);
		const replacement = "replacement-root-password";
		const changed = await auth.api.changePassword({
			headers: {
				cookie,
				"x-request-id": "self-password-request",
				"cf-connecting-ip": "203.0.113.80",
			},
			body: {
				currentPassword: password,
				newPassword: replacement,
				revokeOtherSessions: true,
			},
			asResponse: true,
		});
		expect(changed.status, await changed.clone().text()).toBe(200);
		const audit = await database
			.prepare(
				"SELECT request_id, ip_address, after FROM audit_logs WHERE action = 'auth.password_changed' ORDER BY created_at DESC LIMIT 1",
			)
			.first<{ request_id: string; ip_address: string; after: string }>();
		expect(audit).toMatchObject({
			request_id: "self-password-request",
			ip_address: "203.0.113.80",
		});
		expect(JSON.parse(audit?.after ?? "null")).toEqual({
			revokeOtherSessions: true,
		});
		expect(audit?.after).not.toContain(password);
		expect(audit?.after).not.toContain(replacement);

		const currentCookie = mergeResponseCookie(cookie, changed);
		const restored = await auth.api.changePassword({
			headers: { cookie: currentCookie },
			body: {
				currentPassword: replacement,
				newPassword: password,
				revokeOtherSessions: false,
			},
			asResponse: true,
		});
		expect(restored.status, await restored.clone().text()).toBe(200);
	});

	it("does not audit a rejected password change as successful", async () => {
		const signedIn = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		const before = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'auth.password_changed'",
			)
			.first<{ count: number }>();
		const rejected = await auth.api.changePassword({
			headers: { cookie: responseCookie(signedIn) },
			body: {
				currentPassword: "incorrect-current-password",
				newPassword: "unused-replacement-password",
				revokeOtherSessions: true,
			},
			asResponse: true,
		});
		expect(rejected.status).toBeGreaterThanOrEqual(400);
		const after = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'auth.password_changed'",
			)
			.first<{ count: number }>();
		expect(after?.count).toBe(before?.count);
	});

	it("rejects public email registration and leaves user creation to administrators", async () => {
		const before = await database
			.prepare("SELECT COUNT(*) AS count FROM users")
			.first<{ count: number }>();
		const response = await auth.api.signUpEmail({
			body: {
				name: "Uninvited user",
				email: "uninvited@example.com",
				password: "uninvited-password-123",
			},
			asResponse: true,
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
		const after = await database
			.prepare("SELECT COUNT(*) AS count FROM users")
			.first<{ count: number }>();
		expect(after?.count).toBe(before?.count);
		const uninvited = await database
			.prepare("SELECT id FROM users WHERE email = 'uninvited@example.com'")
			.first();
		expect(uninvited).toBeNull();
	});

	it("sends a one-time reset link, keeps the response generic, and revokes sessions", async () => {
		const sent: Array<{ to?: unknown; text?: string }> = [];
		const scheduled: Promise<unknown>[] = [];
		await database
			.prepare(
				`INSERT INTO system_settings
				 (key, value, is_secret, created_at, updated_at)
				 VALUES ('auth.password_reset_from_email', '"security@pay.example"', 0, 1, 1)`,
			)
			.run();
		const resetAuth = createAuth(drizzle(database, { schema }), {
			BETTER_AUTH_SECRET: runtime.betterAuthSecret,
			BETTER_AUTH_URL: runtime.betterAuthUrl,
			AUTH_EMAIL: {
				send: async (message) => {
					sent.push(message as { to?: unknown; text?: string });
					return { messageId: "reset-message" };
				},
			} as SendEmail,
			WAIT_UNTIL: (promise) => scheduled.push(promise),
		});
		await Promise.all([
			resetAuth.api.signInEmail({ body: { email, password } }),
			resetAuth.api.signInEmail({ body: { email, password } }),
		]);
		const existingResponse = await resetAuth.api.requestPasswordReset({
			body: { email, redirectTo: "/reset-password" },
		});
		const missingResponse = await resetAuth.api.requestPasswordReset({
			body: {
				email: "missing@example.com",
				redirectTo: "/reset-password",
			},
		});
		expect(missingResponse).toEqual(existingResponse);
		await Promise.all(scheduled);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.to).toBe(email);
		const resetUrl = sent[0]?.text?.match(/https:\/\/\S+/)?.[0];
		const token = resetUrl
			? new URL(resetUrl).pathname.split("/").at(-1)
			: undefined;
		expect(token).toBeTruthy();
		await resetAuth.api.resetPassword({
			body: { newPassword: password, token },
		});
		const reused = await resetAuth.api.resetPassword({
			body: { newPassword: password, token },
			asResponse: true,
		});
		expect(reused.status).toBeGreaterThanOrEqual(400);
		const sessions = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)",
			)
			.bind(email)
			.first<{ count: number }>();
		expect(sessions?.count).toBe(0);
		const audit = await database
			.prepare(
				"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'auth.password_reset' AND target_id = (SELECT id FROM users WHERE email = ?)",
			)
			.bind(email)
			.first<{ count: number }>();
		expect(audit?.count).toBe(1);
	});

	it("does not create a session for a disabled user", async () => {
		const before = await database
			.prepare("SELECT COUNT(*) AS count FROM sessions")
			.first<{ count: number }>();
		await database
			.prepare(
				"UPDATE users SET enabled = 0, disabled_at = ?, updated_at = ? WHERE email = ?",
			)
			.bind(Date.now(), Date.now(), email)
			.run();
		const response = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true,
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "USER_DISABLED" });
		const after = await database
			.prepare("SELECT COUNT(*) AS count FROM sessions")
			.first<{ count: number }>();
		expect(after?.count).toBe(before?.count);
	});

	it("rate-limits repeated failed sign-in requests from one client", async () => {
		const responses: Response[] = [];
		for (let attempt = 0; attempt < 6; attempt++) {
			responses.push(
				await auth.handler(
					new Request("https://pay.example/api/auth/sign-in/email", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-forwarded-for": "198.51.100.45",
						},
						body: JSON.stringify({ email, password: "wrong-password-value" }),
					}),
				),
			);
		}
		expect(
			responses.slice(0, 5).every((response) => response.status === 401),
		).toBe(true);
		expect(responses[5]?.status).toBe(429);
	});
});

function responseCookie(response: Response) {
	const values = response.headers.getSetCookie();
	if (!values.length)
		throw new Error("Authentication response did not set a cookie");
	return values.map((value) => value.split(";", 1)[0]).join("; ");
}

function mergeResponseCookie(current: string, response: Response) {
	const updates = response.headers.getSetCookie();
	if (!updates.length) return current;
	const cookies = new Map(
		current.split("; ").map((value) => {
			const index = value.indexOf("=");
			return [value.slice(0, index), value.slice(index + 1)];
		}),
	);
	for (const update of updates) {
		const pair = update.split(";", 1)[0] ?? "";
		const index = pair.indexOf("=");
		cookies.set(pair.slice(0, index), pair.slice(index + 1));
	}
	return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
