import { describe, expect, it, vi } from "vitest";
import {
	adaptCloudflareEnv,
	type CloudflareBindings,
} from "#/server/runtime/cloudflare";
import { ConfiguredMailSender } from "#/server/runtime/email-mail";
import { requireRuntimeDatabase } from "#/server/runtime/types";

describe("Cloudflare runtime adapter", () => {
	it("preserves binding identities and exposes the Cloudflare capability", () => {
		const bindings = {
			DB: {},
			CACHE: {},
			FILES: {},
			WEBHOOK_QUEUE: {},
			PAYMENT_QUEUE: {},
			EMAIL: { send: vi.fn() },
		} as unknown as CloudflareBindings;
		const waitUntil = vi.fn();

		const runtime = adaptCloudflareEnv(bindings, waitUntil);

		expect(runtime).toMatchObject({
			runtime: "cloudflare",
			DB: bindings.DB,
			CACHE: bindings.CACHE,
			FILES: bindings.FILES,
			WEBHOOK_QUEUE: bindings.WEBHOOK_QUEUE,
			PAYMENT_QUEUE: bindings.PAYMENT_QUEUE,
			waitUntil,
		});
		expect(runtime.EMAIL).toBeDefined();
		expect(runtime.MAIL).toBeInstanceOf(ConfiguredMailSender);
	});

	it("keeps optional bindings absent instead of inventing capabilities", () => {
		const runtime = adaptCloudflareEnv({} as CloudflareBindings);

		expect(runtime).toEqual({
			runtime: "cloudflare",
			DB: undefined,
			FILES: undefined,
			CACHE: undefined,
			WEBHOOK_QUEUE: undefined,
			PAYMENT_QUEUE: undefined,
			EMAIL: undefined,
			MAIL: undefined,
			waitUntil: undefined,
		});
		expect(() => requireRuntimeDatabase(runtime)).toThrow(
			'Runtime database binding "DB" is unavailable.',
		);
	});
});
