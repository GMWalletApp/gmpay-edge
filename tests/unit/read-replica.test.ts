import { describe, expect, it } from "vitest";
import {
	readBookmark,
	readBookmarkCookieName,
	readDatabase,
	refreshesReadBookmark,
	withReadBookmarkCookie,
} from "#/server/read-replica";

type SessionCall = { constraint: string | undefined; statements: string[] };

function fakeDatabase(bookmark: string | null = "0000-0001") {
	const sessions: SessionCall[] = [];
	const database = {
		prepare: (query: string) => statement(query, "primary"),
		batch: async () => [],
		exec: async () => ({ count: 0, duration: 0 }),
		withSession: (constraint?: string) => {
			const call: SessionCall = { constraint, statements: [] };
			sessions.push(call);
			return {
				prepare: (query: string) => {
					call.statements.push(query);
					return statement(query, "session");
				},
				batch: async () => [],
				getBookmark: () => bookmark,
			};
		},
	};
	return { database: database as unknown as D1Database, sessions };
}

function statement(query: string, origin: string) {
	const bound = {
		bind: () => bound,
		first: async () => ({ query, origin }),
		run: async () => ({ success: true as const, results: [], meta: {} }),
		all: async () => ({ success: true as const, results: [], meta: {} }),
		raw: async () => [],
	};
	return bound as unknown as D1PreparedStatement;
}

describe("D1 read replica sessions", () => {
	it("opens one unconstrained session per request and reuses it", () => {
		const { database, sessions } = fakeDatabase();
		const request = new Request("https://pay.example/admin/orders");
		const first = readDatabase(request, database);
		const second = readDatabase(request, database);
		expect(second).toBe(first);
		expect(sessions.map((call) => call.constraint)).toEqual([
			"first-unconstrained",
		]);
		expect(
			readDatabase(new Request("https://pay.example/admin/orders"), database),
		).not.toBe(first);
	});

	it("anchors the session at a valid bookmark cookie and ignores forged values", () => {
		const { database, sessions } = fakeDatabase();
		readDatabase(
			new Request("https://pay.example/admin", {
				headers: {
					cookie: `theme=dark; ${readBookmarkCookieName}=0000-00ab_CD`,
				},
			}),
			database,
		);
		readDatabase(
			new Request("https://pay.example/admin", {
				headers: { cookie: `${readBookmarkCookieName}=../etc; other=1` },
			}),
			database,
		);
		expect(sessions.map((call) => call.constraint)).toEqual([
			"0000-00ab_CD",
			"first-unconstrained",
		]);
		expect(readBookmark(null)).toBeUndefined();
		expect(readBookmark(`${readBookmarkCookieName}=`)).toBeUndefined();
	});

	it("falls back to the primary database when sessions are unavailable", () => {
		const primary = {
			prepare: () => statement("", "primary"),
			batch: async () => [],
			exec: async () => ({ count: 0, duration: 0 }),
		} as unknown as D1Database;
		expect(
			readDatabase(new Request("https://pay.example/admin"), primary),
		).toBe(primary);
	});

	it("refreshes the bookmark only after server-function and checkout mutations", () => {
		const post = (url: string) => new Request(url, { method: "POST" });
		expect(refreshesReadBookmark(post("https://pay.example/_serverFn/x"))).toBe(
			true,
		);
		expect(
			refreshesReadBookmark(post("https://pay.example/api/checkout/1/review")),
		).toBe(true);
		expect(
			refreshesReadBookmark(
				post("https://pay.example/payments/gmpay/v1/order/create-transaction"),
			),
		).toBe(false);
		expect(
			refreshesReadBookmark(new Request("https://pay.example/_serverFn/x")),
		).toBe(false);
	});

	it("captures the primary bookmark after a mutation and sets a scoped cookie", async () => {
		const { database, sessions } = fakeDatabase("0000-0042");
		const response = await withReadBookmarkCookie(
			new Request("https://pay.example/_serverFn/save", { method: "POST" }),
			new Response("ok", { headers: { "set-cookie": "existing=1" } }),
			database,
		);
		expect(sessions).toEqual([
			{ constraint: "first-primary", statements: ["SELECT 1"] },
		]);
		const cookies = response.headers.getSetCookie();
		expect(cookies).toHaveLength(2);
		expect(cookies[1]).toBe(
			`${readBookmarkCookieName}=0000-0042; Path=/; Max-Age=300; HttpOnly; SameSite=Lax; Secure`,
		);
		expect(await response.text()).toBe("ok");
	});

	it("leaves reads, sessionless databases, and bookmarkless sessions untouched", async () => {
		const { database, sessions } = fakeDatabase(null);
		const original = new Response("ok");
		expect(
			await withReadBookmarkCookie(
				new Request("https://pay.example/_serverFn/list"),
				original,
				database,
			),
		).toBe(original);
		expect(
			await withReadBookmarkCookie(
				new Request("http://localhost/_serverFn/save", { method: "POST" }),
				original,
				database,
			),
		).toBe(original);
		expect(sessions).toHaveLength(1);
		expect(
			await withReadBookmarkCookie(
				new Request("https://pay.example/_serverFn/save", { method: "POST" }),
				original,
				undefined,
			),
		).toBe(original);
	});
});
