/** Cookie helpers with Cookie Store and document.cookie support. */

import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

const DEFAULT_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

/**
 * Cookie header of the current SSR request or of the browser document, so
 * route loaders read the same values on both sides of hydration.
 */
const cookieHeader = createIsomorphicFn()
	.server(() => {
		// Start's request accessors throw outside an HTTP request scope (unit
		// tests, build-time invocations); no request means no cookies.
		try {
			return getRequestHeader("cookie") ?? "";
		} catch {
			return "";
		}
	})
	.client(() => document.cookie);

/**
 * Get a cookie value by name from the request (server) or document (browser)
 */
export function getCookie(name: string): string | undefined {
	return parseCookie(cookieHeader(), name);
}

export function parseCookie(header: string, name: string): string | undefined {
	const encodedName = `${encodeURIComponent(name)}=`;
	const value = header
		.split("; ")
		.find((part) => part.startsWith(encodedName))
		?.slice(encodedName.length);
	if (value === undefined) return undefined;
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Set a cookie with name, value, and optional max age
 */
export function setCookie(
	name: string,
	value: string,
	maxAge: number = DEFAULT_MAX_AGE,
): void {
	if (typeof document === "undefined") return;

	const store = browserCookieStore();
	if (store) {
		void store.set({
			name,
			value,
			path: "/",
			sameSite: "lax",
			expires: Date.now() + maxAge * 1000,
		});
		return;
	}
	Reflect.set(
		document,
		"cookie",
		`${encodeURIComponent(name)}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}`,
	);
}

type BrowserCookieStore = {
	set(options: {
		name: string;
		value: string;
		path: string;
		sameSite: "lax";
		expires: number;
	}): Promise<void>;
};

function browserCookieStore(): BrowserCookieStore | undefined {
	return (
		globalThis as typeof globalThis & { cookieStore?: BrowserCookieStore }
	).cookieStore;
}
