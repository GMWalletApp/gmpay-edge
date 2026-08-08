import { waitUntil } from "cloudflare:workers";
import { createAuth } from "#/features/auth/server/auth-factory";
import { trustedOriginsFromAllowedHosts } from "#/features/auth/trusted-hosts";
import { getCloudflareEnv, getDb } from "#/server/db.server";
import { loadRequestAllowedHosts } from "#/server/middleware/authority";
import { loadRequestRuntimeConfig } from "#/server/runtime-config";

const authCache = new WeakMap<
	object,
	{ auth: ReturnType<typeof createAuth>; signature: string }
>();
export async function getAuth(request: Request) {
	const env = getCloudflareEnv(request);
	const d1 = env?.DB;
	if (!d1) throw new Error("D1 binding DB is unavailable");
	const [runtime, trustedOrigins] = await Promise.all([
		loadRequestRuntimeConfig(request, d1, new URL(request.url).origin),
		loadTrustedOrigins(request, d1),
	]);
	if (runtime.betterAuthSecret.length < 32)
		throw new Error("BETTER_AUTH_SECRET has not been initialized");
	const signature = `${runtime.betterAuthSecret}:${runtime.betterAuthUrl}:${trustedOrigins.join(",")}`;
	const cached = authCache.get(d1);
	if (cached?.signature === signature) return cached.auth;
	const auth = createAuth(getDb(request), {
		BETTER_AUTH_SECRET: runtime.betterAuthSecret,
		BETTER_AUTH_URL: runtime.betterAuthUrl,
		TRUSTED_ORIGINS: trustedOrigins,
		AUTH_EMAIL: env.AUTH_EMAIL,
		WAIT_UNTIL: waitUntil,
	});
	authCache.set(d1, { auth, signature });
	return auth;
}

async function loadTrustedOrigins(request: Request, db: D1Database) {
	return trustedOriginsFromAllowedHosts(
		await loadRequestAllowedHosts(request, db),
	);
}
