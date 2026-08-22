import { describe, expect, it, vi } from "vitest";
import {
	createDatastoreCounters,
	instrumentD1,
	instrumentKv,
	instrumentR2,
} from "../helpers/datastore-counters";

describe("datastore call counters", () => {
	it("counts D1 prepare, bind, and terminal operations deterministically", async () => {
		const counters = createDatastoreCounters();
		const statement = {
			bind: vi.fn(function (this: typeof statement) {
				return this;
			}),
			run: vi.fn(async () => ({ success: true })),
			first: vi.fn(async () => ({ value: 1 })),
			all: vi.fn(async () => ({ results: [] })),
			raw: vi.fn(async () => []),
		};
		const database = {
			prepare: vi.fn(() => statement),
			batch: vi.fn(async () => []),
			exec: vi.fn(async () => ({ count: 1, duration: 0 })),
		} as unknown as D1Database;
		const db = instrumentD1(database, counters);

		await db.prepare("SELECT 1").bind("value").first();
		await db.prepare("SELECT 1").all();
		await db.prepare("SELECT 1").raw();
		await db.prepare("SELECT 1").run();
		await db.batch([]);
		await db.exec("SELECT 1");

		expect(counters).toEqual({
			d1Prepare: 4,
			d1Batch: 1,
			d1Exec: 1,
			d1StatementBind: 1,
			d1StatementRun: 1,
			d1StatementFirst: 1,
			d1StatementAll: 1,
			d1StatementRaw: 1,
			kvGet: 0,
			kvPut: 0,
			kvDelete: 0,
			kvList: 0,
			r2Get: 0,
		});
	});

	it("counts R2 reads including missing objects and storage failures", async () => {
		const counters = createDatastoreCounters();
		const get = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error("R2 unavailable"));
		const bucket = instrumentR2({ get } as unknown as R2Bucket, counters);

		await expect(bucket.get("missing")).resolves.toBeNull();
		await expect(bucket.get("failed")).rejects.toThrow("R2 unavailable");
		expect(counters.r2Get).toBe(2);
	});

	it("counts KV cold/hot reads, writes, invalidation, and failures", async () => {
		const counters = createDatastoreCounters();
		const kv = instrumentKv(
			{
				get: vi.fn(async (key: string) =>
					key === "corrupt" ? "not-json" : null,
				),
				put: vi.fn(async () => undefined),
				delete: vi.fn(async () => undefined),
				list: vi.fn(async () => ({ keys: [] })),
			} as unknown as KVNamespace,
			counters,
		);

		await kv.get("cold");
		await kv.get("hot");
		await kv.get("corrupt");
		await kv.put("hot", "value");
		await kv.delete("hot");
		await kv.list();

		expect({ kvGet: counters.kvGet, kvPut: counters.kvPut }).toEqual({
			kvGet: 3,
			kvPut: 1,
		});
		expect(counters.kvDelete).toBe(1);
		expect(counters.kvList).toBe(1);
	});
});
