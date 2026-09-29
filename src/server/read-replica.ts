/**
 * D1 read replication support. Business reads (lists, dashboards, checkout
 * status) run on a per-request D1 session that may be served by a replica
 * near the Worker; authorization, settings and every write stay on the
 * primary through the raw binding. A short-lived bookmark cookie written after
 * mutations anchors the next reads at least at that write, so a client never
 * observes its own change disappearing. Without read replication (or on Bun)
 * the session simply resolves to the primary database.
 */

export type ReadDatabase = Pick<D1Database, "prepare" | "batch">;
type SessionDatabase = Pick<D1Database, "withSession">;

export const readBookmarkCookieName = "gmpay_d1_bookmark";
const readBookmarkMaxAgeSeconds = 300;
const bookmarkPattern = /^[0-9A-Za-z_-]{1,256}$/;
const readSessions = new WeakMap<Request, ReadDatabase>();

export function readDatabase(request: Request, db: D1Database): ReadDatabase {
	const cached = readSessions.get(request);
	if (cached) return cached;
	const session = sessionCapable(db)
		? db.withSession(
				readBookmark(request.headers.get("cookie")) ?? "first-unconstrained",
			)
		: db;
	readSessions.set(request, session);
	return session;
}

/** The Bun SQLite adapter and older local runtimes expose no D1 sessions. */
function sessionCapable(db: object): db is SessionDatabase {
	return (
		"withSession" in db &&
		typeof (db as Partial<SessionDatabase>).withSession === "function"
	);
}

export function readBookmark(cookieHeader: string | null): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() !== readBookmarkCookieName) continue;
		const value = part.slice(separator + 1).trim();
		return bookmarkPattern.test(value) ? value : undefined;
	}
	return undefined;
}

/** Mutations that later reads must observe: server functions and checkout API. */
export function refreshesReadBookmark(request: Request) {
	if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
	const { pathname } = new URL(request.url);
	return (
		pathname.startsWith("/_serverFn/") || pathname.startsWith("/api/checkout/")
	);
}

/**
 * Captures the primary's current bookmark after a mutation and hands it to the
 * client. One primary round trip; skipped where sessions are unavailable.
 */
export async function withReadBookmarkCookie(
	request: Request,
	response: Response,
	db: object | undefined,
) {
	if (!db || !sessionCapable(db) || !refreshesReadBookmark(request))
		return response;
	const session = db.withSession("first-primary");
	await session.prepare("SELECT 1").first();
	const bookmark = session.getBookmark();
	if (!bookmark || !bookmarkPattern.test(bookmark)) return response;
	const headers = new Headers(response.headers);
	headers.append(
		"set-cookie",
		[
			`${readBookmarkCookieName}=${bookmark}`,
			"Path=/",
			`Max-Age=${readBookmarkMaxAgeSeconds}`,
			"HttpOnly",
			"SameSite=Lax",
			...(new URL(request.url).protocol === "https:" ? ["Secure"] : []),
		].join("; "),
	);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
