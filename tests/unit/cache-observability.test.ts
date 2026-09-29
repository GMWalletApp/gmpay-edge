import { afterEach, describe, expect, it, vi } from "vitest";
import { recordKvCacheMetric } from "#/server/cache-observability";

describe("KV cache observability", () => {
	afterEach(() => vi.restoreAllMocks());

	it("samples cache hits at one percent and reports the aggregation rate", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

		recordKvCacheMetric(
			{ cache: "site_brand", operation: "read", outcome: "hit" },
			performance.now(),
			() => 0.009,
		);
		recordKvCacheMetric(
			{ cache: "site_brand", operation: "read", outcome: "hit" },
			performance.now(),
			() => 0.01,
		);

		expect(info).toHaveBeenCalledTimes(1);
		expect(info).toHaveBeenCalledWith({
			cache: "site_brand",
			durationMs: expect.any(Number),
			event: "kv_cache",
			operation: "read",
			outcome: "hit",
			sampleRate: 0.01,
		});
	});

	it("records misses and fallback operations without sampling", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

		recordKvCacheMetric(
			{ cache: "rbac_access", operation: "read", outcome: "miss" },
			performance.now(),
			() => 1,
		);
		recordKvCacheMetric(
			{
				cache: "site_brand",
				operation: "delete",
				outcome: "fallback",
			},
			performance.now(),
			() => 1,
		);

		expect(info).toHaveBeenCalledTimes(2);
		for (const [metric] of info.mock.calls) {
			expect(metric).toMatchObject({ event: "kv_cache", sampleRate: 1 });
		}
	});
});
