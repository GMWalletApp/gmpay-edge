import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyNodeMigrations,
	NodeDurableQueue,
	NodeMemoryCache,
	NodeObjectStorage,
	NodeRuntimeLifecycle,
	NodeScheduler,
	openNodeDatabase,
} from "#/server/runtime/node";

const directories: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Bun SQLite database", () => {
	it("implements D1-style statements and atomic batches", async () => {
		const database = openNodeDatabase(":memory:");
		await database.exec(
			"CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)",
		);
		const inserted = await database
			.prepare("INSERT INTO values_table (value) VALUES (?)")
			.bind("one")
			.run();
		expect(inserted.meta.changes).toBe(1);
		expect(
			await database
				.prepare("SELECT value FROM values_table WHERE id = ?")
				.bind(1)
				.first<string>("value"),
		).toBe("one");

		await expect(
			database.batch([
				database.prepare("INSERT INTO values_table (value) VALUES ('two')"),
				database.prepare("INSERT INTO values_table (value) VALUES ('one')"),
			]),
		).rejects.toThrow();
		const count = await database
			.prepare("SELECT COUNT(*) AS count FROM values_table")
			.first<number>("count");
		expect(count).toBe(1);
		database.close();
	});

	it("applies each immutable migration exactly once", async () => {
		const directory = await temporaryDirectory();
		await writeFile(
			join(directory, "0000_initial.sql"),
			"CREATE TABLE example (id TEXT PRIMARY KEY);",
		);
		const database = openNodeDatabase(":memory:");
		const url = pathToFileURL(`${directory}/`);
		expect(await applyNodeMigrations(database, url)).toEqual({
			applied: 1,
			total: 1,
		});
		expect(await applyNodeMigrations(database, url)).toEqual({
			applied: 0,
			total: 1,
		});
		await writeFile(
			join(directory, "0000_initial.sql"),
			"CREATE TABLE changed (id TEXT PRIMARY KEY);",
		);
		await expect(applyNodeMigrations(database, url)).rejects.toThrow(
			"Applied migration changed",
		);
		database.close();
	});
});

describe("NodeMemoryCache", () => {
	it("expires entries and evicts the least recently used value", async () => {
		let now = 1_000;
		const cache = new NodeMemoryCache({ maxEntries: 2, now: () => now });
		await cache.put("expiring", "value", { expirationTtl: 1 });
		now = 2_000;
		expect(await cache.get("expiring")).toBeNull();

		await cache.put("one", "1");
		await cache.put("two", "2");
		expect(await cache.get("one")).toBe("1");
		await cache.put("three", "3");
		expect(await cache.get("two")).toBeNull();
		expect(await cache.get("one")).toBe("1");
	});
});

describe("NodeObjectStorage", () => {
	it("streams private objects with metadata and safe hashed paths", async () => {
		const directory = await temporaryDirectory();
		const storage = new NodeObjectStorage(directory);
		const stored = await storage.put("../../payment/review", "evidence", {
			httpMetadata: { contentType: "text/plain", cacheControl: "private" },
			customMetadata: { reviewId: "review-1" },
		});
		expect(stored?.etag).toMatch(/^[a-f0-9]{64}$/);
		await expect(
			readFile(join(directory, "payment", "review")),
		).rejects.toMatchObject({ code: "ENOENT" });

		const object = await storage.get("../../payment/review");
		expect(object && "body" in object ? await object.text() : null).toBe(
			"evidence",
		);
		const headers = new Headers();
		object?.writeHttpMetadata(headers);
		expect(headers.get("content-type")).toBe("text/plain");

		const conditional = await storage.get("../../payment/review", {
			onlyIf: new Headers({ "if-none-match": stored?.httpEtag ?? "" }),
		});
		expect(conditional && "body" in conditional).toBe(false);
		await storage.delete("../../payment/review");
		expect(await storage.head("../../payment/review")).toBeNull();
	});
});

describe("Node durable background services", () => {
	it("reuses queue statements instead of preparing them per operation", async () => {
		const database = openNodeDatabase(":memory:");
		const queue = new NodeDurableQueue<{ id: string }>(database, "payments");
		const statements = Reflect.get(queue, "statements") as {
			insert: { run: (...values: unknown[]) => unknown };
			selectCandidates: { all: (...values: unknown[]) => unknown };
			claim: { get: (...values: unknown[]) => unknown };
			retry: { run: (...values: unknown[]) => unknown };
			ack: { run: (...values: unknown[]) => unknown };
		};
		const insert = vi.spyOn(statements.insert, "run");
		const selectCandidates = vi.spyOn(statements.selectCandidates, "all");
		const claim = vi.spyOn(statements.claim, "get");
		const retry = vi.spyOn(statements.retry, "run");
		const ack = vi.spyOn(statements.ack, "run");

		await queue.send({ id: "payment-1" });
		const [claimed] = queue.claim(1, 1_000, Date.now());
		if (!claimed) throw new Error("Expected a claimed message");
		queue.retry(claimed, {
			maxAttempts: 2,
			delayMs: 0,
			now: Date.now(),
		});
		const [retried] = queue.claim(1, 1_000, Date.now());
		if (!retried) throw new Error("Expected a retried message");
		queue.ack(retried.id, retried.lease_token);

		expect(insert).toHaveBeenCalledOnce();
		expect(selectCandidates).toHaveBeenCalledTimes(2);
		expect(claim).toHaveBeenCalledTimes(2);
		expect(retry).toHaveBeenCalledOnce();
		expect(ack).toHaveBeenCalledOnce();
		database.close();
	});

	it("backs off empty polling and wakes immediately when a message arrives", async () => {
		vi.useFakeTimers();
		const database = openNodeDatabase(":memory:");
		const queue = new NodeDurableQueue<{ id: string }>(database, "payments");
		const claim = vi.spyOn(queue, "claim");
		const handled: string[] = [];
		const consumer = queue.createConsumer(
			async (batch) => {
				handled.push(batch.messages[0]?.body.id ?? "missing");
				batch.ackAll();
			},
			{
				concurrency: 1,
				maxAttempts: 3,
				pollIntervalMs: 100,
				maxIdlePollIntervalMs: 400,
			},
		);

		consumer.start();
		await advanceTimersByTime(0);
		expect(claim).toHaveBeenCalledTimes(1);
		await advanceTimersByTime(299);
		expect(claim).toHaveBeenCalledTimes(2);
		await advanceTimersByTime(1);
		expect(claim).toHaveBeenCalledTimes(3);

		await queue.send({ id: "payment-1" });
		await advanceTimersByTime(0);
		expect(handled).toEqual(["payment-1"]);
		await queue.sendBatch([{ body: { id: "payment-2" } }]);
		await advanceTimersByTime(0);
		expect(handled).toEqual(["payment-1", "payment-2"]);

		await consumer.stop();
		database.close();
	});

	it("leases, retries and dead-letters persistent queue messages", async () => {
		const directory = await temporaryDirectory();
		const filename = join(directory, "queue.sqlite");
		const database = openNodeDatabase(filename);
		const queue = new NodeDurableQueue<{ id: string }>(database, "payments");
		await queue.send({ id: "payment-1" });
		database.close();

		const reopened = openNodeDatabase(filename);
		const recoveredQueue = new NodeDurableQueue<{ id: string }>(
			reopened,
			"payments",
		);
		const [claimed] = recoveredQueue.claim(1, 1_000, Date.now());
		expect(claimed && JSON.parse(claimed.body)).toEqual({ id: "payment-1" });
		if (!claimed) throw new Error("Expected a claimed message");
		recoveredQueue.retry(claimed, {
			maxAttempts: 1,
			delayMs: 15_000,
			now: Date.now(),
			error: "Error",
		});
		const state = reopened.sqlite
			.prepare(
				"SELECT status, last_error FROM node_queue_messages WHERE id = ?",
			)
			.get(claimed.id);
		expect(state).toEqual({ status: "dead", last_error: "Error" });
		reopened.close();
	});

	it("prevents overlapping schedules and stops services in reverse order", async () => {
		vi.useFakeTimers();
		let resolveTask: (() => void) | undefined;
		const task = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveTask = resolve;
				}),
		);
		const scheduler = new NodeScheduler(task, { intervalMs: 1_000 });
		scheduler.start();
		await advanceTimersByTime(2_000);
		expect(task).toHaveBeenCalledTimes(1);
		resolveTask?.();
		await scheduler.stop();

		const calls: string[] = [];
		const lifecycle = new NodeRuntimeLifecycle([
			{
				start: () => {
					calls.push("start:first");
				},
				stop: () => {
					calls.push("stop:first");
				},
			},
			{
				start: () => {
					calls.push("start:second");
				},
				stop: () => {
					calls.push("stop:second");
				},
			},
		]);
		await lifecycle.start();
		await lifecycle.stop();
		expect(calls).toEqual([
			"start:first",
			"start:second",
			"stop:second",
			"stop:first",
		]);
	});
});

async function advanceTimersByTime(durationMs: number) {
	vi.advanceTimersByTime(durationMs);
	await Promise.resolve();
	await Promise.resolve();
}

async function temporaryDirectory() {
	const directory = await mkdtemp(join(tmpdir(), "gmpay-node-runtime-"));
	directories.push(directory);
	return directory;
}
