import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyNodeMigrations,
	type NodeDatabase,
	NodeDurableQueue,
	NodeMemoryCache,
	NodeObjectStorage,
	NodeRequestTracker,
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
		const run = vi.spyOn(database.sqlite, "run");
		const url = pathToFileURL(`${directory}/`);
		expect(await applyNodeMigrations(database, url)).toEqual({
			applied: 1,
			total: 1,
		});
		expect(
			run.mock.calls.filter(([sql]) => sql === "PRAGMA optimize"),
		).toHaveLength(1);
		run.mockClear();
		expect(await applyNodeMigrations(database, url)).toEqual({
			applied: 0,
			total: 1,
		});
		expect(run).not.toHaveBeenCalledWith("PRAGMA optimize");
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

describe("NodeDurableQueue delivery budget", () => {
	it("keeps a leased message exclusive until the lease expires, then redelivers it", async () => {
		vi.useFakeTimers();
		const database = openNodeDatabase(":memory:");
		const queue = new NodeDurableQueue<{ id: string }>(database, "payments");
		const claim = vi.spyOn(queue, "claim");
		// The injected clock stays ahead of the wall-clock insert timestamps so
		// only the lease arithmetic under test decides what a poll may claim.
		let clock = Date.now() + 86_400_000;
		const deliveries: { attempts: number; finish: () => void }[] = [];
		const consumer = queue.createConsumer(
			(batch) =>
				new Promise<void>((resolve) => {
					// The handler stays open until the test releases it, like a hung
					// worker whose lease must run out before anyone else may deliver.
					for (const message of batch.messages)
						deliveries.push({
							attempts: message.attempts,
							finish: () => {
								message.ack();
								resolve();
							},
						});
				}),
			{
				concurrency: 2,
				maxAttempts: 3,
				pollIntervalMs: 100,
				maxIdlePollIntervalMs: 100,
				leaseMs: 5_000,
				now: () => clock,
			},
		);

		consumer.start();
		const { messageId } = await queue.send({ id: "payment-1" });
		await advanceTimersByTime(0);
		const leaseExpiresAt = clock + 5_000;
		expect(deliveries.map((delivery) => delivery.attempts)).toEqual([1]);
		const first = readQueueRow(database, messageId);
		expect(first).toMatchObject({
			status: "leased",
			attempts: 1,
			lease_expires_at: leaseExpiresAt,
		});

		clock = leaseExpiresAt - 1;
		await advanceTimersByTime(100);
		expect(claim).toHaveBeenLastCalledWith(1, 5_000, leaseExpiresAt - 1);
		expect(deliveries).toHaveLength(1);
		expect(readQueueRow(database, messageId)).toEqual(first);

		clock = leaseExpiresAt;
		await advanceTimersByTime(100);
		expect(deliveries.map((delivery) => delivery.attempts)).toEqual([1, 2]);
		const second = readQueueRow(database, messageId);
		expect(second).toMatchObject({
			status: "leased",
			attempts: 2,
			lease_expires_at: leaseExpiresAt + 5_000,
		});
		expect(second?.lease_token).not.toBe(first?.lease_token);

		// The stale delivery finishing late cannot ack the redelivered row.
		deliveries[0]?.finish();
		await advanceTimersByTime(0);
		expect(readQueueRow(database, messageId)).toEqual(second);
		deliveries[1]?.finish();
		await advanceTimersByTime(0);
		expect(readQueueRow(database, messageId)).toBeNull();

		await consumer.stop();
		database.close();
	});

	it("dead-letters a failing message after exactly maxAttempts deliveries", async () => {
		vi.useFakeTimers();
		const database = openNodeDatabase(":memory:");
		const queue = new NodeDurableQueue<{ id: string }>(database, "webhooks");
		let clock = Date.now() + 86_400_000;
		const attempts: number[] = [];
		const consumer = queue.createConsumer(
			async (batch) => {
				attempts.push(...batch.messages.map((message) => message.attempts));
				throw new Error("merchant endpoint unavailable");
			},
			{
				concurrency: 1,
				maxAttempts: 3,
				pollIntervalMs: 100,
				maxIdlePollIntervalMs: 100,
				now: () => clock,
			},
		);

		consumer.start();
		const { messageId } = await queue.send({ id: "delivery-1" });
		await advanceTimersByTime(0);
		expect(attempts).toEqual([1]);
		// Without baseRetryDelayMs the first retry waits the 15s retry_delay that
		// wrangler.jsonc configures for the Cloudflare consumers.
		expect(readQueueRow(database, messageId)).toMatchObject({
			status: "ready",
			attempts: 1,
			available_at: clock + 15_000,
			lease_token: null,
			last_error: "Error",
		});

		clock += 14_999;
		await advanceTimersByTime(100);
		expect(attempts).toEqual([1]);
		clock += 1;
		await advanceTimersByTime(100);
		expect(attempts).toEqual([1, 2]);
		expect(readQueueRow(database, messageId)).toMatchObject({
			status: "ready",
			attempts: 2,
			available_at: clock + 30_000,
		});

		clock += 30_000;
		await advanceTimersByTime(100);
		expect(attempts).toEqual([1, 2, 3]);
		expect(readQueueRow(database, messageId)).toMatchObject({
			status: "dead",
			attempts: 3,
			lease_token: null,
			last_error: "Error",
		});

		// The dead letter is never redelivered and stays inspectable: idle polls
		// purge with the documented seven-day default, which this row is far from.
		const purge = vi.spyOn(queue, "purgeDeadMessages");
		clock += 60 * 60_000;
		await advanceTimersByTime(100);
		expect(attempts).toEqual([1, 2, 3]);
		expect(purge).toHaveBeenLastCalledWith(clock - 7 * 86_400_000);
		expect(readQueueRow(database, messageId)).toMatchObject({
			status: "dead",
			attempts: 3,
		});

		await consumer.stop();
		database.close();
	});

	it("purges only its own dead rows at or before the cutoff, oldest first and bounded", async () => {
		const database = openNodeDatabase(":memory:");
		const queue = new NodeDurableQueue<{ id: string }>(database, "payments");
		const other = new NodeDurableQueue<{ id: string }>(database, "webhooks");
		const oldest = await deadLetter(queue, 1_000);
		const boundary = await deadLetter(queue, 2_000);
		const newest = await deadLetter(queue, 3_000);
		await deadLetter(other, 1_000);
		await queue.send({ id: "leased" });
		expect(queue.claim(1, 60_000, Date.now())).toHaveLength(1);
		await queue.send({ id: "ready" });
		expect(deadMessageIds(database, "payments")).toEqual([
			oldest,
			boundary,
			newest,
		]);

		expect(queue.purgeDeadMessages(2_000, 1)).toBe(1);
		expect(deadMessageIds(database, "payments")).toEqual([boundary, newest]);
		expect(queue.purgeDeadMessages(2_000)).toBe(1);
		expect(deadMessageIds(database, "payments")).toEqual([newest]);
		expect(queue.purgeDeadMessages(2_000)).toBe(0);

		// A cutoff covering every row still leaves live work and other queues alone.
		expect(queue.purgeDeadMessages(Number.MAX_SAFE_INTEGER)).toBe(1);
		expect(
			database.sqlite
				.prepare(
					"SELECT queue, status FROM node_queue_messages ORDER BY queue, status",
				)
				.all(),
		).toEqual([
			{ queue: "payments", status: "leased" },
			{ queue: "payments", status: "ready" },
			{ queue: "webhooks", status: "dead" },
		]);
		database.close();
	});

	it("purges dead letters past deadRetentionMs from idle polls once per interval", async () => {
		vi.useFakeTimers();
		const database = openNodeDatabase(":memory:");
		const queue = new NodeDurableQueue<{ id: string }>(database, "webhooks");
		const purge = vi.spyOn(queue, "purgeDeadMessages");
		let clock = Date.now() + 86_400_000;
		const expired = await deadLetter(queue, clock - 60_000);
		const retained = await deadLetter(queue, clock - 59_999);
		expect(deadMessageIds(database, "webhooks")).toEqual([expired, retained]);
		const handled: string[] = [];
		const consumer = queue.createConsumer(
			async (batch) => {
				handled.push(...batch.messages.map((message) => message.body.id));
				batch.ackAll();
			},
			{
				concurrency: 1,
				maxAttempts: 1,
				pollIntervalMs: 100,
				maxIdlePollIntervalMs: 100,
				deadRetentionMs: 60_000,
				now: () => clock,
			},
		);

		consumer.start();
		await advanceTimersByTime(0);
		expect(purge).toHaveBeenCalledTimes(1);
		expect(purge).toHaveBeenLastCalledWith(clock - 60_000);
		expect(deadMessageIds(database, "webhooks")).toEqual([retained]);

		// Idle polls inside the hourly purge interval leave newly expired rows alone.
		clock += 1;
		await advanceTimersByTime(100);
		expect(purge).toHaveBeenCalledTimes(1);

		// Once the interval has passed, a poll that claims live work still defers
		// the purge to the next idle poll.
		clock += 60 * 60_000;
		await queue.send({ id: "live" });
		await advanceTimersByTime(0);
		expect(handled).toEqual(["live"]);
		expect(purge).toHaveBeenCalledTimes(1);
		await advanceTimersByTime(0);
		expect(purge).toHaveBeenCalledTimes(2);
		expect(deadMessageIds(database, "webhooks")).toEqual([]);

		await consumer.stop();
		database.close();
	});
});

describe("NodeRequestTracker", () => {
	it("lets later services wait for in-flight requests before stopping", async () => {
		const tracker = new NodeRequestTracker(10_000);
		const calls: string[] = [];
		const lifecycle = new NodeRuntimeLifecycle([
			{
				start() {},
				stop: () => {
					calls.push("database");
				},
			},
			tracker,
		]);
		await lifecycle.start();
		let finish: ((value: string) => void) | undefined;
		const request = tracker.track(
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				}),
		);

		const stopping = lifecycle.stop();
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toEqual([]);

		finish?.("ok");
		await expect(request).resolves.toBe("ok");
		await stopping;
		expect(calls).toEqual(["database"]);
	});

	it("bounds the drain wait and settles failed or throwing handlers", async () => {
		const hung = new NodeRequestTracker(20);
		void hung.track(() => new Promise<never>(() => {}));
		const startedAt = Date.now();
		await hung.stop();
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);

		const failing = new NodeRequestTracker(10_000);
		await expect(
			failing.track(() => Promise.reject(new Error("boom"))),
		).rejects.toThrow("boom");
		await expect(
			failing.track(() => {
				throw new Error("sync");
			}),
		).rejects.toThrow("sync");
		expect(failing.stop()).toBeUndefined();
	});
});

async function advanceTimersByTime(durationMs: number) {
	vi.advanceTimersByTime(durationMs);
	// A handler settling, its disposition write and the wake-up that follows
	// span several microtask turns.
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

async function temporaryDirectory() {
	const directory = await mkdtemp(join(tmpdir(), "gmpay-node-runtime-"));
	directories.push(directory);
	return directory;
}

type QueueRow = {
	status: "ready" | "leased" | "dead";
	attempts: number;
	available_at: number;
	lease_token: string | null;
	lease_expires_at: number | null;
	last_error: string | null;
	updated_at: number;
};

function readQueueRow(database: NodeDatabase, id: string) {
	return database.sqlite
		.prepare(
			`SELECT status, attempts, available_at, lease_token, lease_expires_at,
			 last_error, updated_at FROM node_queue_messages WHERE id = ?`,
		)
		.get(id) as QueueRow | null;
}

function deadMessageIds(database: NodeDatabase, queue: string) {
	const rows = database.sqlite
		.prepare(
			`SELECT id FROM node_queue_messages
			 WHERE queue = ? AND status = 'dead' ORDER BY updated_at, id`,
		)
		.all(queue) as { id: string }[];
	return rows.map((row) => row.id);
}

/** Dead-letters a fresh message and backdates its last touch to `deadAt`. */
async function deadLetter(
	queue: NodeDurableQueue<{ id: string }>,
	deadAt: number,
) {
	const { messageId } = await queue.send({ id: `dead-${deadAt}` });
	const [claimed] = queue.claim(1, 1_000, Date.now());
	if (!claimed || claimed.id !== messageId)
		throw new Error("Expected to claim the message that was just sent");
	queue.retry(claimed, { maxAttempts: 1, delayMs: 0, now: deadAt });
	return messageId;
}
