import { sha256Hex } from "#/lib/crypto";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";

const testEmailPolicy = { limit: 5, windowMs: 3_600_000 } as const;

/** Bounds operator-triggered test mail per actor; D1 is the atomic counter. */
export async function claimTestEmailRateLimit(
	db: D1Database,
	userId: string,
	now = Date.now(),
) {
	return claimFixedWindowRateLimit(db, {
		bucketKey: await sha256Hex(`email-test\0${userId}`),
		...testEmailPolicy,
		now,
	});
}
