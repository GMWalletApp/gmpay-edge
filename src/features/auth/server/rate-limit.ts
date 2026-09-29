import { sha256Hex } from "#/lib/crypto";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";

type AuthRateLimitPolicy = {
	scope: "ip" | "email";
	limit: number;
	windowMs: number;
};

// Better Auth's in-memory limiter stays a best-effort first layer per isolate;
// these D1 windows are the authoritative limit shared by every instance.
export const authRateLimitPolicies: ReadonlyMap<
	string,
	readonly AuthRateLimitPolicy[]
> = new Map([
	[
		"/sign-in/email",
		[
			{ scope: "ip", limit: 5, windowMs: 60_000 },
			{ scope: "email", limit: 30, windowMs: 900_000 },
		],
	],
	["/request-password-reset", [{ scope: "ip", limit: 3, windowMs: 60_000 }]],
	["/reset-password", [{ scope: "ip", limit: 5, windowMs: 60_000 }]],
]);

export async function claimAuthRateLimit(
	db: D1Database,
	input: { path: string; ip: string | null; email?: string; now?: number },
): Promise<{ retryAfterSeconds: number } | null> {
	const now = input.now ?? Date.now();
	for (const policy of authRateLimitPolicies.get(input.path) ?? []) {
		const subject =
			policy.scope === "ip" ? (input.ip ?? "no-trusted-ip") : input.email;
		if (subject === undefined) continue;
		const claim = await claimFixedWindowRateLimit(db, {
			bucketKey: await sha256Hex(
				`auth:${input.path}\0${policy.scope}\0${subject}`,
			),
			limit: policy.limit,
			windowMs: policy.windowMs,
			now,
		});
		if (!claim.allowed)
			return {
				retryAfterSeconds: Math.max(
					1,
					Math.ceil((claim.windowStart + policy.windowMs - now) / 1_000),
				),
			};
	}
	return null;
}
