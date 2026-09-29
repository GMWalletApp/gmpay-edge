import { dehydrate, hydrate, QueryClient } from "@tanstack/react-query";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getContext, ssrQueryDehydrateOptions } from "#/context/tanstack-query";
import { dashboardQuery } from "#/features/dashboard/pages/admin";
import { queryAdminDashboard } from "#/features/dashboard/server/query";
import { applyMigrations } from "./migrations";

vi.mock("#/features/dashboard/server/admin", () => ({
	getAdminDashboardFn: vi.fn(),
}));

const now = Date.UTC(2026, 6, 14, 6);

describe("dashboard Query hydration budget", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-dashboard-hydration" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seedDashboard(db);
	});

	afterAll(async () => miniflare.dispose());

	it("dehydrates one bounded dashboard query without sensitive internals", async () => {
		const server = getContext().queryClient;
		await server.prefetchQuery({
			...dashboardQuery,
			queryFn: () => queryAdminDashboard(db, now),
		});
		const dehydrated = dehydrate(server);
		const serialized = JSON.stringify(dehydrated);

		expect(dehydrated.queries).toHaveLength(1);
		expect(dehydrated.queries[0]?.queryKey).toEqual(["admin", "dashboard"]);
		const bytes = new TextEncoder().encode(serialized).byteLength;
		expect(bytes).toBeGreaterThan(2_500);
		expect(bytes).toBeLessThanOrEqual(4 * 1024);
		expect(serialized).not.toMatch(
			/session-token-sensitive|permission_mask|notify-provider-sensitive|api_key|secret_encrypted|SELECT /i,
		);
	});

	it("uses the Router integration to dehydrate a bounded pending query", async () => {
		const { queryClient: server, router } = createSsrQueryRouter();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = server.prefetchQuery({
			...dashboardQuery,
			queryFn: async () => {
				await gate;
				return queryAdminDashboard(db, now);
			},
		});
		await Promise.resolve();
		const { state, finish } = await dehydrateRouter(router);
		const dehydrated = state.query.initial;
		const query = dehydrated?.[0];
		const serialized = JSON.stringify(dehydrated);

		expect(dehydrated).toHaveLength(1);
		expect(query?.state.status).toBe("pending");
		expect(query?.promise).toBeInstanceOf(Promise);
		expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
			1024,
		);
		expect(serialized).not.toMatch(
			/session|permission|secret|provider|SELECT/i,
		);

		release();
		await pending;
		await expect(query?.promise).resolves.toEqual(
			server.getQueryData(dashboardQuery.queryKey),
		);
		finish();
	});

	it("reuses the real dashboard payload throughout its freshness window", async () => {
		const server = getContext().queryClient;
		await server.fetchQuery({
			...dashboardQuery,
			queryFn: () => queryAdminDashboard(db, now),
		});
		const browser = getContext().queryClient;
		hydrate(browser, dehydrate(server));
		const refetch = vi.fn(() => queryAdminDashboard(db, now));

		await browser.fetchQuery({ ...dashboardQuery, queryFn: refetch });

		expect(refetch).not.toHaveBeenCalled();
	});

	it("isolates failed and cancelled Router queries from SSR payloads", async () => {
		const { queryClient: failed, router: failedRouter } =
			createSsrQueryRouter();
		const failingQuery = vi.fn(async () => {
			throw new Error("D1_ERROR: SELECT session-token-sensitive");
		});
		await failed.prefetchQuery({
			queryKey: dashboardQuery.queryKey,
			queryFn: failingQuery,
		});
		expect(failingQuery).toHaveBeenCalledOnce();
		const failedDehydration = await dehydrateRouter(failedRouter);
		expect(failedDehydration.state.query.initial ?? []).toHaveLength(0);
		failedDehydration.finish();

		const { queryClient: cancelled, router: cancelledRouter } =
			createSsrQueryRouter();
		let aborted = false;
		const request = cancelled.fetchQuery({
			queryKey: dashboardQuery.queryKey,
			queryFn: ({ signal }) =>
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						aborted = true;
						reject(new DOMException("Cancelled", "AbortError"));
					});
				}),
		});
		await Promise.resolve();
		const cancelledDehydration = await dehydrateRouter(cancelledRouter);
		const streamedPromise =
			cancelledDehydration.state.query.initial?.[0]?.promise;
		expect(streamedPromise).toBeInstanceOf(Promise);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		await cancelled.cancelQueries({ queryKey: dashboardQuery.queryKey });
		await expect(request).rejects.toThrow("CancelledError");
		await expect(streamedPromise).rejects.toThrow("redacted");
		expect(aborted).toBe(true);
		expect(cancelled.getQueryData(dashboardQuery.queryKey)).toBeUndefined();
		expect(consoleError).toHaveBeenCalledOnce();
		expect(consoleError.mock.calls[0]?.join(" ")).toContain("CancelledError");
		consoleError.mockRestore();
		cancelledDehydration.finish();
	});
});

type RouterDehydratedState = {
	query: {
		initial?: ReturnType<typeof dehydrate>["queries"];
		stream: ReadableStream<ReturnType<typeof dehydrate>["queries"]>;
	};
};

type TestRouter = {
	options: {
		dehydrate?: () => Promise<unknown>;
		Wrap?: unknown;
	};
	isServer: true;
	serverSsr?: {
		isDehydrated: () => boolean;
		onRenderFinished: (callback: () => void) => void;
	};
	serverSsrLifecycle?: unknown;
};

function createSsrQueryRouter() {
	const queryClient = new QueryClient();
	const router: TestRouter = { options: {}, isServer: true };
	setupRouterSsrQueryIntegration({
		router: router as never,
		queryClient,
		dehydrateOptions: ssrQueryDehydrateOptions,
		wrapQueryClient: false,
	});
	return { queryClient, router };
}

async function dehydrateRouter(router: TestRouter) {
	let finish = () => {};
	router.serverSsr = {
		isDehydrated: () => false,
		onRenderFinished: (callback: () => void) => {
			finish = callback;
		},
	};
	const state = (await router.options.dehydrate?.()) as RouterDehydratedState;
	return { finish, state };
}

async function seedDashboard(db: D1Database) {
	await db.batch([
		db
			.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled, two_factor_enabled, created_at, updated_at) VALUES ('dashboard-user', 'Dashboard', 'dashboard@example.com', 1, 1, 0, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES ('dashboard-session', 'dashboard-user', 'session-token-sensitive', ?, ?, ?)",
			)
			.bind(now + 86_400_000, now, now),
		...Array.from({ length: 8 }, (_, index) =>
			db
				.prepare(
					`INSERT INTO orders
					 (id, external_order_id, status, amount_minor, currency, currency_decimals,
					  received_amount_units, notify_url, expires_at, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'USD', 2, '0', ?, ?, ?, ?)`,
				)
				.bind(
					`dashboard-order-${index}`,
					`merchant-dashboard-${index}`,
					index % 2 ? "paid" : "pending",
					String((index + 1) * 100),
					`https://notify.example/notify-provider-sensitive-${index}`,
					now + 86_400_000,
					now - index * 86_400_000,
					now,
				),
		),
	]);
}
