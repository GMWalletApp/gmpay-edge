/**
 * Memoizes one in-flight or recent value per binding object for `ttlMs`, so
 * anonymous bursts against public loaders share a single query round. A
 * rejected load is evicted immediately instead of caching the failure.
 */
export function createIsolateSnapshot<T>(ttlMs: number) {
	const snapshots = new WeakMap<
		object,
		{ expiresAt: number; value: Promise<T> }
	>();
	return (key: object, load: () => Promise<T>, now = Date.now()) => {
		const cached = snapshots.get(key);
		if (cached && cached.expiresAt > now) return cached.value;
		const value = load().catch((error: unknown) => {
			if (snapshots.get(key)?.value === value) snapshots.delete(key);
			throw error;
		});
		snapshots.set(key, { expiresAt: now + ttlMs, value });
		return value;
	};
}
