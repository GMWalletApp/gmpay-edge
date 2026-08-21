import { APIError, type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import * as schema from "#/db/schema";
import type { AppDb } from "#/server/db.server";
import type { RuntimeMailSender } from "#/server/runtime/types";
import { schedulePasswordResetEmail } from "./password-reset-email";

export type AuthEnv = {
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL: string;
	TRUSTED_ORIGINS?: string[];
	MAIL?: RuntimeMailSender;
	WAIT_UNTIL?: (promise: Promise<unknown>) => void;
};

export function createAuth(db: AppDb, env: AuthEnv) {
	return betterAuth({
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		trustedOrigins: [
			env.BETTER_AUTH_URL,
			...(env.TRUSTED_ORIGINS ?? []),
		].filter(
			(value, index, values) =>
				Boolean(value) && values.indexOf(value) === index,
		),
		advanced: {
			ipAddress: {
				// Cloudflare Workers receive the authenticated client address in this
				// single-value header. Better Auth otherwise only checks X-Forwarded-For.
				ipAddressHeaders: ["cf-connecting-ip"],
			},
		},
		database: drizzleAdapter(db, { provider: "sqlite", schema }),
		user: {
			additionalFields: {
				enabled: {
					type: "boolean",
					required: false,
					defaultValue: true,
					input: false,
				},
			},
		},
		emailAndPassword: {
			enabled: true,
			disableSignUp: true,
			minPasswordLength: 12,
			resetPasswordTokenExpiresIn: 15 * 60,
			revokeSessionsOnPasswordReset: true,
			sendResetPassword: async ({ user, url }) => {
				schedulePasswordResetEmail(
					db.$client,
					env.MAIL,
					{
						recipient: user.email,
						resetUrl: url,
					},
					env.WAIT_UNTIL,
				);
			},
			onPasswordReset: async ({ user }, request) => {
				await db.$client
					.prepare(
						`INSERT INTO audit_logs
						 (id, actor_user_id, action, target_type, target_id, request_id,
						  ip_address, created_at)
						 VALUES (?, ?, 'auth.password_reset', 'user', ?, ?, ?, ?)`,
					)
					.bind(
						crypto.randomUUID(),
						user.id,
						user.id,
						request?.headers.get("x-request-id") ?? null,
						request?.headers.get("cf-connecting-ip") ?? null,
						Date.now(),
					)
					.run();
			},
		},
		rateLimit: {
			enabled: true,
			window: 60,
			max: 20,
			customRules: {
				"/sign-in/email": { window: 60, max: 5 },
				"/request-password-reset": { window: 60, max: 3 },
				"/reset-password": { window: 60, max: 5 },
			},
		},
		hooks: {
			after: createAuthMiddleware(async (ctx) => {
				const action = securityAuditAction(ctx.path);
				if (!action) return;
				if (ctx.context.returned instanceof APIError) return;
				const userId =
					securityAuditUserId(ctx.context) ??
					(await getSessionFromCtx(ctx).catch(() => null))?.user.id;
				if (!userId) return;
				const after =
					ctx.path === "/change-password"
						? {
								revokeOtherSessions: Boolean(
									(ctx.body as { revokeOtherSessions?: boolean } | undefined)
										?.revokeOtherSessions,
								),
							}
						: null;
				await db.$client
					.prepare(
						`INSERT INTO audit_logs
						(id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
						VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)`,
					)
					.bind(
						crypto.randomUUID(),
						userId,
						action,
						userId,
						ctx.headers?.get("x-request-id") ?? null,
						ctx.headers?.get("cf-connecting-ip") ?? null,
						after ? JSON.stringify(after) : null,
						Date.now(),
					)
					.run();
			}),
		},
		plugins: [
			twoFactor({
				issuer: "GMPay Edge",
				twoFactorTable: "twoFactor",
				twoFactorCookieMaxAge: 600,
				trustDeviceMaxAge: 2_592_000,
				accountLockout: {
					enabled: true,
					maxFailedAttempts: 8,
					durationSeconds: 900,
				},
			}),
			enabledUsersPlugin(),
			tanstackStartCookies(),
		],
	});
}

function securityAuditAction(path: string) {
	return (
		{
			"/sign-in/email": "auth.signed_in",
			"/sign-out": "auth.signed_out",
			"/change-password": "auth.password_changed",
			"/two-factor/enable": "auth.two_factor_enabled",
			"/two-factor/disable": "auth.two_factor_disabled",
			"/two-factor/verify-totp": "auth.two_factor_verified",
			"/two-factor/verify-backup-code": "auth.two_factor_backup_verified",
		}[path] ?? null
	);
}

function securityAuditUserId(context: {
	session?: { user?: { id?: string } } | null;
	newSession?: { user?: { id?: string } } | null;
	returned?: unknown;
}) {
	return (
		context.session?.user?.id ??
		context.newSession?.user?.id ??
		findReturnedUserId(context.returned) ??
		null
	);
}

function findReturnedUserId(value: unknown, depth = 0): string | undefined {
	if (!value || typeof value !== "object" || depth > 3) return undefined;
	const object = value as Record<string, unknown>;
	if (object.user && typeof object.user === "object") {
		const id = (object.user as Record<string, unknown>).id;
		if (typeof id === "string") return id;
	}
	for (const key of ["response", "data", "result"]) {
		const id = findReturnedUserId(object[key], depth + 1);
		if (id) return id;
	}
	return undefined;
}

function enabledUsersPlugin() {
	return {
		id: "enabled-users",
		init() {
			return {
				options: {
					databaseHooks: {
						user: {
							create: {
								async before(newUser: Record<string, unknown>) {
									return { data: { enabled: true, ...newUser } };
								},
							},
						},
						session: {
							create: {
								async before(
									newSession: { userId?: string },
									ctx?: {
										context?: {
											internalAdapter?: {
												findUserById?: (id: string) => Promise<unknown>;
											};
										};
									} | null,
								) {
									const userId = newSession.userId;
									const currentUser =
										userId &&
										(await ctx?.context?.internalAdapter?.findUserById?.(
											userId,
										));
									if (
										(currentUser as { enabled?: boolean | null } | null)
											?.enabled !== true
									)
										throw APIError.from("FORBIDDEN", {
											message: "This user has been disabled.",
											code: "USER_DISABLED",
										});
								},
							},
						},
					},
				},
			};
		},
	} as unknown as BetterAuthPlugin;
}
