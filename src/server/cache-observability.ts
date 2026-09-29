type KvCacheName = "rbac_access" | "site_brand";

type KvCacheMetric = { cache: KvCacheName } & (
	| {
			operation: "read";
			outcome: "corrupt" | "fallback" | "hit" | "miss";
	  }
	| {
			operation: "delete" | "write";
			outcome: "fallback" | "success";
	  }
);

const hitSampleRate = 0.01;

export function recordKvCacheMetric(
	metric: KvCacheMetric,
	startedAt: number,
	sample: () => number = Math.random,
) {
	const sampleRate =
		metric.operation === "read" && metric.outcome === "hit" ? hitSampleRate : 1;
	if (sampleRate < 1 && sample() >= sampleRate) return;
	console.info({
		event: "kv_cache",
		...metric,
		sampleRate,
		durationMs:
			Math.round(Math.max(0, performance.now() - startedAt) * 10) / 10,
	});
}
