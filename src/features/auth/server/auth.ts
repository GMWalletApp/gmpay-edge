import { createAuth } from "#/features/auth/server/auth-factory";
import { trustedOriginsFromAllowedHosts } from "#/features/auth/trusted-hosts";
import { getCloudflareEnv, getDb, getRuntimeEnv } from "#/server/db.server";
import { loadRequestAllowedHosts } from "#/server/middleware/authority";
import { loadRequestRuntimeConfig } from "#/server/runtime-config";

type Auth = ReturnType<typeof createAuth>;
type SessionResult = Awaited<ReturnType<Auth["api"]["getSession"]>>;

const authCache = new WeakMap<object, { auth: Auth; signature: string }>();

export async function getAuth(request: Request) {
	return (await resolveAuth(request)).auth;
}

async function resolveAuth(request: Request) {
	const env = getCloudflareEnv(request);
	const runtimeEnv = getRuntimeEnv(request);
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
	if (cached?.signature === signature) return cached;
	const auth = createAuth(getDb(request), {
		BETTER_AUTH_SECRET: runtime.betterAuthSecret,
		BETTER_AUTH_URL: runtime.betterAuthUrl,
		TRUSTED_ORIGINS: trustedOrigins,
		MAIL: runtimeEnv.MAIL,
		WAIT_UNTIL: runtimeEnv.waitUntil,
	});
	const entry = { auth, signature };
	authCache.set(d1, entry);
	return entry;
}

async function loadTrustedOrigins(request: Request, db: D1Database) {
	return trustedOriginsFromAllowedHosts(
		await loadRequestAllowedHosts(request, db),
	);
}

/**
 * Reads the Better Auth session for a request. When this isolate already holds
 * an auth instance, the D1 session lookup starts at once and overlaps the
 * settings read that confirms the instance is still current; a rotated secret
 * or changed origin list discards that optimistic result and repeats the lookup
 * with the rebuilt instance, so authorization never trusts a stale instance.
 */
export function getSessionForRequest(request: Request): Promise<SessionResult> {
	return takePrimedSession(request) ?? lookupSession(request);
}

async function lookupSession(request: Request): Promise<SessionResult> {
	const cached = cachedAuth(request);
	const optimistic = cached?.api.getSession({ headers: request.headers });
	optimistic?.catch(() => undefined);
	const { auth } = await resolveAuth(request);
	if (optimistic && auth === cached) return optimistic;
	return auth.api.getSession({ headers: request.headers });
}

function cachedAuth(request: Request) {
	const d1 = getCloudflareEnv(request)?.DB;
	return d1 ? authCache.get(d1)?.auth : undefined;
}

const primedSessions = new Map<
	string,
	{ promise: Promise<SessionResult>; expiresAt: number }
>();
const primedSessionTtlMs = 5_000;
const primedSessionLimit = 256;
const sessionCookieMarker = "session_token=";
const primedPathPattern = /^\/(?:admin|_serverFn|api\/admin)(?:\/|$)/;

/**
 * Starts the session lookup before routing for authenticated admin traffic so
 * it overlaps the Allowed Hosts settings read instead of following it. Only a
 * warm isolate can prime: a cold one has no verified auth instance yet. The
 * lookup is keyed by the cookie header and consumed by the first server entry
 * that authorizes the same session within a few seconds.
 */
export function primeSessionLookup(request: Request) {
	const cookie = request.headers.get("cookie");
	if (!cookie?.includes(sessionCookieMarker)) return;
	if (!primedPathPattern.test(new URL(request.url).pathname)) return;
	if (!cachedAuth(request)) return;
	const now = Date.now();
	for (const [key, entry] of primedSessions)
		if (entry.expiresAt <= now) primedSessions.delete(key);
	if (primedSessions.has(cookie) || primedSessions.size >= primedSessionLimit)
		return;
	const promise = lookupSession(request);
	promise.catch(() => undefined);
	primedSessions.set(cookie, { promise, expiresAt: now + primedSessionTtlMs });
}

function takePrimedSession(request: Request) {
	const cookie = request.headers.get("cookie");
	const primed = cookie ? primedSessions.get(cookie) : undefined;
	if (!cookie || !primed) return undefined;
	primedSessions.delete(cookie);
	return primed.expiresAt > Date.now() ? primed.promise : undefined;
}
