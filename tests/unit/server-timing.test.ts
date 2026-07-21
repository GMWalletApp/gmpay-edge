import { describe, expect, it } from "vitest";
import { getLocale } from "#/paraglide/runtime";
import { applySecurityHeaders } from "#/server/http-security";
import { handleI18nRequest } from "#/server/middleware/i18n";
import {
	appendServerTiming,
	measureRequestTiming,
	takeRequestTiming,
} from "#/server/server-timing";

describe("Server-Timing response instrumentation", () => {
	it("resolves the SSR locale from the locale cookie", async () => {
		const request = new Request("https://pay.example/docs", {
			headers: {
				cookie: "PARAGLIDE_LOCALE=zh-CN",
				"accept-language": "ja-JP",
			},
		});
		const response = await handleI18nRequest(
			request,
			undefined,
			undefined,
			() => new Response(getLocale()),
		);

		expect(await response.text()).toBe("zh-CN");
		expect(response.headers.get("location")).toBeNull();
	});

	it("uses the configured default when no locale cookie exists", async () => {
		const db = {
			prepare: () => ({
				all: async () => ({
					results: [{ key: "site.default_locale", value: '"zh-CN"' }],
				}),
			}),
		} as unknown as D1Database;
		const response = await handleI18nRequest(
			new Request("https://pay.example/docs"),
			db,
			undefined,
			() => new Response(getLocale()),
		);

		expect(await response.text()).toBe("zh-CN");
		expect(response.headers.get("vary")).toContain("Cookie");
	});

	it("does not consume a server function request body", async () => {
		const request = new Request("https://pay.example/_server/install", {
			method: "POST",
			headers: { cookie: "PARAGLIDE_LOCALE=zh-CN" },
			body: JSON.stringify({ email: "root@example.com" }),
		});
		const response = await handleI18nRequest(
			request,
			undefined,
			undefined,
			async (resolvedRequest) => new Response(await resolvedRequest.text()),
		);

		expect(await response.json()).toEqual({ email: "root@example.com" });
	});

	it("adds bounded fixed-name duration metrics without changing the response", async () => {
		const response = appendServerTiming(
			new Response("ok", {
				status: 202,
				headers: { "x-existing": "kept" },
			}),
			[
				{ name: "authority", durationMs: 1.26 },
				{ name: "app", durationMs: -5 },
				{ name: "total", durationMs: 9.94 },
			],
		);

		expect(response.status).toBe(202);
		expect(response.headers.get("x-existing")).toBe("kept");
		expect(response.headers.get("server-timing")).toBe(
			"authority;dur=1.3, app;dur=0.0, total;dur=9.9",
		);
		expect(await response.text()).toBe("ok");
	});

	it("preserves timing emitted by an inner handler", () => {
		const response = appendServerTiming(
			new Response(null, { headers: { "server-timing": "db;dur=2.0" } }),
			[{ name: "total", durationMs: 3 }],
		);

		expect(response.headers.get("server-timing")).toBe(
			"db;dur=2.0, total;dur=3.0",
		);
	});

	it("collects fixed request timing stages once, including failed work", async () => {
		const request = new Request("https://pay.example/admin");
		await measureRequestTiming(request, "session", async () => undefined);
		await expect(
			measureRequestTiming(request, "rbac", async () => {
				throw new Error("denied");
			}),
		).rejects.toThrow("denied");

		expect(takeRequestTiming(request).map(({ name }) => name)).toEqual([
			"session",
			"rbac",
		]);
		expect(takeRequestTiming(request)).toEqual([]);
	});

	it("preserves incremental body delivery instead of buffering SSR", async () => {
		const encoder = new TextEncoder();
		let release = () => {};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("shell"));
				release = () => {
					controller.enqueue(encoder.encode("content"));
					controller.close();
				};
			},
		});
		const request = new Request("https://pay.example/");
		const streamed = await handleI18nRequest(
			request,
			undefined,
			undefined,
			() => new Response(body),
		);
		const response = applySecurityHeaders(
			request,
			appendServerTiming(streamed, [{ name: "total", durationMs: 1 }]),
		);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();

		const first = await reader?.read();
		expect(new TextDecoder().decode(first?.value)).toBe("shell");
		expect(first?.done).toBe(false);
		release();
		const second = await reader?.read();
		expect(new TextDecoder().decode(second?.value)).toBe("content");
		expect(second?.done).toBe(false);
		expect((await reader?.read())?.done).toBe(true);
	});
});
