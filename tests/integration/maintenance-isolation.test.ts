import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RETENTION_INTERVAL_MS } from "#/features/operations/schedule";
import { runMaintenance } from "#/server/scheduled";
import { applyMigrations } from "./migrations";

/** The next tick that falls on a retention minute, strictly after `now`. */
function nextRetentionMinute(now: number) {
	return (Math.floor(now / RETENTION_INTERVAL_MS) + 1) * RETENTION_INTERVAL_MS;
}

describe("scheduled maintenance isolation", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-maintenance-isolation" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
	});

	afterAll(async () => miniflare.dispose());

	it("does not persist a retention run when no cleanup work is due", async () => {
		await runMaintenance({ DB: db } as unknown as Env, "* * * * *", {
			expire: vi.fn(),
			recoverWebhooks: vi.fn(),
			loadDueWork: forcedDueWork(),
		});
		const run = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM operation_task_runs WHERE task = 'retention_cleanup'",
			)
			.first<{ count: number }>();
		expect(run?.count).toBe(0);
	});

	it("leases scheduled external work before enqueueing it", async () => {
		const now = Date.now();
		await db
			.prepare(
				"DELETE FROM system_settings WHERE key = 'runtime.crypto_rate_sync_dispatch_lease'",
			)
			.run();
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const env = {
			DB: db,
			PAYMENT_QUEUE: { sendBatch },
		} as unknown as Env;
		const dependencies = {
			expire: vi.fn(),
			recoverWebhooks: vi.fn(),
			loadDueWork: forcedDueWork({ cryptoRateSync: true }),
		};

		await runMaintenance(env, "* * * * *", dependencies, now);
		await runMaintenance(env, "* * * * *", dependencies, now + 60_000);

		expect(sendBatch).toHaveBeenCalledOnce();
		expect(sendBatch).toHaveBeenCalledWith([
			{
				body: {
					kind: "payment.rate_sync",
					version: 1,
					category: "crypto",
				},
			},
		]);
	});

	it("releases an external-work lease when Queue enqueue fails", async () => {
		const now = Date.now();
		await db
			.prepare(
				"DELETE FROM system_settings WHERE key = 'runtime.crypto_rate_sync_dispatch_lease'",
			)
			.run();
		const sendBatch = vi
			.fn()
			.mockRejectedValueOnce(new Error("Queue unavailable"))
			.mockResolvedValueOnce(undefined);
		const env = {
			DB: db,
			PAYMENT_QUEUE: { sendBatch },
		} as unknown as Env;
		const dependencies = {
			expire: vi.fn(),
			recoverWebhooks: vi.fn(),
			loadDueWork: forcedDueWork({ cryptoRateSync: true }),
		};

		await runMaintenance(env, "* * * * *", dependencies, now);
		await runMaintenance(env, "* * * * *", dependencies, now + 1);

		expect(sendBatch).toHaveBeenCalledTimes(2);
		const runs = await db
			.prepare(
				"SELECT status FROM operation_task_runs WHERE task = 'crypto_rate_sync' AND started_at >= ? ORDER BY started_at, id",
			)
			.bind(now)
			.all<{ status: string }>();
		expect(runs.results.map(({ status }) => status)).toEqual(
			expect.arrayContaining(["failed", "succeeded"]),
		);
		expect(runs.results).toHaveLength(2);
	});

	it("continues cleanup and other tasks when one task fails", async () => {
		const expire = vi.fn().mockResolvedValue(0);
		const recoverWebhooks = vi.fn().mockRejectedValue(new Error("queue down"));
		await runMaintenance(
			{
				DB: db,
				PAYMENT_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) },
			} as unknown as Env,
			"*/1 * * * *",
			{
				expire,
				recoverWebhooks,
				loadDueWork: forcedDueWork({
					orderExpiration: true,
					webhookOutbox: true,
				}),
			},
		);
		expect(expire).toHaveBeenCalledOnce();
		expect(recoverWebhooks).toHaveBeenCalledOnce();
		const audit = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action = 'maintenance.task_failed' AND json_extract(after, '$.task') = 'webhook_outbox' ORDER BY created_at DESC LIMIT 1",
			)
			.first<{ after: string }>();
		expect(JSON.parse(audit?.after ?? "{}")).toEqual({
			invocationId: expect.any(String),
			task: "webhook_outbox",
		});
		expect(audit?.after).not.toContain("queue down");
	});

	it("reports a missing payment Queue binding with a stable task code", async () => {
		await db
			.prepare(
				"UPDATE system_settings SET value = '0' WHERE key = 'runtime.last_payment_scan_at'",
			)
			.run();

		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		try {
			await expect(
				runMaintenance({ DB: db } as unknown as Env, "*/1 * * * *", {
					expire: vi.fn().mockResolvedValue(0),
					recoverWebhooks: vi.fn().mockResolvedValue({ queued: 0, failed: 0 }),
					loadDueWork: forcedDueWork({ paymentScan: true }),
				}),
			).rejects.toMatchObject({ code: "binding_unavailable", status: 503 });
			const invocation = info.mock.calls
				.map(([value]) => JSON.parse(String(value)))
				.find((record) => record.event === "scheduled_invocation_completed");
			expect(invocation).toEqual(
				expect.objectContaining({
					durationMs: expect.any(Number),
					overBudget: expect.any(Boolean),
					outcome: "failed",
				}),
			);
		} finally {
			info.mockRestore();
		}
		const run = await db
			.prepare(
				"SELECT error_code FROM operation_task_runs WHERE task = 'payment_scan_enqueue' ORDER BY started_at DESC, id DESC LIMIT 1",
			)
			.first<{ error_code: string | null }>();
		expect(run?.error_code).toBe("binding_unavailable");
	});

	it("treats partial outbox enqueue failure as a recoverable task failure", async () => {
		await runMaintenance(
			{
				DB: db,
				PAYMENT_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) },
			} as unknown as Env,
			"*/1 * * * *",
			{
				expire: vi.fn().mockResolvedValue(0),
				recoverWebhooks: vi.fn().mockResolvedValue({ queued: 2, failed: 1 }),
				loadDueWork: forcedDueWork({
					orderExpiration: true,
					webhookOutbox: true,
					frequentCleanup: true,
				}),
			},
		);
		const run = await db
			.prepare(
				"SELECT status, error_code FROM operation_task_runs WHERE task = 'webhook_outbox' ORDER BY started_at DESC, id DESC LIMIT 1",
			)
			.first<{ status: string; error_code: string | null }>();
		expect(run).toEqual({
			status: "failed",
			error_code: "queue_enqueue_failed",
		});
		const continued = await db
			.prepare(
				`SELECT task, status, duration_ms, result FROM operation_task_runs
				 WHERE task IN ('order_expiration', 'frequent_cleanup')
				 ORDER BY task`,
			)
			.all<{
				task: string;
				status: string;
				duration_ms: number | null;
				result: string | null;
			}>();
		expect(continued.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					task: "order_expiration",
					status: "succeeded",
					duration_ms: expect.any(Number),
				}),
				expect.objectContaining({
					task: "frequent_cleanup",
					status: "succeeded",
					duration_ms: expect.any(Number),
				}),
			]),
		);
		const cleanup = continued.results.find(
			(result) => result.task === "frequent_cleanup",
		);
		expect(JSON.parse(cleanup?.result ?? "null")).toEqual({ affectedRows: 0 });
	});

	it("runs retention cleanup on a retention minute when expired rows exist", async () => {
		const now = Date.now();
		const retentionMinute = nextRetentionMinute(now);
		const expiredAt = now - 366 * 86_400_000;
		const expiredTaskAt = now - 91 * 86_400_000;
		await db.batch([
			db
				.prepare(
					`INSERT INTO operation_task_runs
					 (id, task, trigger, status, started_at, completed_at, duration_ms)
					 VALUES ('expired-task-run', 'retention-test', 'scheduled', 'succeeded', ?, ?, 1),
					 ('old-running-task', 'retention-running-test', 'scheduled', 'running', ?, NULL, NULL)`,
				)
				.bind(expiredTaskAt - 1, expiredTaskAt, expiredAt),
			db
				.prepare(
					"INSERT INTO idempotency_keys (id, key, request_hash, expires_at, created_at, updated_at) VALUES ('expired-idempotency', 'expired-idempotency', 'hash', ?, ?, ?)",
				)
				.bind(now - 1, now, now),
			db
				.prepare(
					"INSERT INTO audit_logs (id, action, target_type, created_at) VALUES ('expired-audit', 'test.expired', 'test', ?)",
				)
				.bind(expiredAt),
			db
				.prepare(
					`INSERT INTO payment_ingresses
					 (id, name, type, transport, provider, network, external_network, external_source_id,
					  config_encrypted, mode, created_at, updated_at)
					 VALUES ('retention-source', 'Payment event push', 'provider_webhook', 'webhook', 'alchemy', 'ethereum', 'ETH_MAINNET',
					  'retention-webhook', 'encrypted', 'shadow', ?, ?)`,
				)
				.bind(now, now),
			db
				.prepare(
					`INSERT INTO inbound_provider_events
					 (id, source_id, provider_event_id, activity_index, network, event_type,
					  transaction_hash, event_index, payload_hash, trigger, status,
					  received_at, processed_at, created_at, updated_at)
					 VALUES ('expired-provider-event', 'retention-source', 'provider-retention',
					  0, 'ethereum', 'address_activity', '0xretention', 0, 'hash', '{}',
					  'succeeded', ?, ?, ?, ?)`,
				)
				.bind(expiredAt, expiredAt, expiredAt, expiredAt),
			db
				.prepare(
					`INSERT INTO inbound_webhook_receipts
					 (id, endpoint_code, request_id, method, request_path, signature_status,
					  processing_status, response_status, duration_ms, received_at)
					 VALUES ('expired-provider-receipt', 'alchemy.address_activity',
					  'retention-request', 'POST', '/api/providers/alchemy/retention',
					  'valid', 'succeeded', 200, 1, ?)`,
				)
				.bind(expiredAt),
		]);
		const expire = vi.fn().mockResolvedValue(0);
		const recoverWebhooks = vi.fn().mockResolvedValue({ queued: 0, failed: 0 });

		// Retention is gated to every fifth minute; an ordinary tick skips it.
		await runMaintenance(
			{ DB: db } as unknown as Env,
			"* * * * *",
			{ expire, recoverWebhooks, loadDueWork: forcedDueWork() },
			retentionMinute + 60_000,
		);
		const skipped = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM operation_task_runs WHERE task = 'retention_cleanup' AND started_at >= ?",
			)
			.bind(retentionMinute)
			.first<{ count: number }>();
		expect(skipped?.count).toBe(0);

		await runMaintenance(
			{ DB: db } as unknown as Env,
			"* * * * *",
			{ expire, recoverWebhooks, loadDueWork: forcedDueWork() },
			retentionMinute,
		);

		expect(expire).not.toHaveBeenCalled();
		expect(recoverWebhooks).not.toHaveBeenCalled();
		const retained = await db
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM idempotency_keys WHERE id = 'expired-idempotency') AS idempotency_count,
				 (SELECT COUNT(*) FROM audit_logs WHERE id = 'expired-audit') AS audit_count,
				 (SELECT COUNT(*) FROM operation_task_runs WHERE id = 'expired-task-run') AS task_run_count,
				 (SELECT COUNT(*) FROM operation_task_runs WHERE id = 'old-running-task') AS running_task_count,
				 (SELECT COUNT(*) FROM inbound_provider_events WHERE id = 'expired-provider-event') AS provider_event_count,
				 (SELECT COUNT(*) FROM inbound_webhook_receipts WHERE id = 'expired-provider-receipt') AS receipt_count`,
			)
			.first<{
				idempotency_count: number;
				audit_count: number;
				task_run_count: number;
				running_task_count: number;
				provider_event_count: number;
				receipt_count: number;
			}>();
		expect(retained).toEqual({
			idempotency_count: 0,
			audit_count: 0,
			task_run_count: 0,
			running_task_count: 1,
			provider_event_count: 0,
			receipt_count: 0,
		});
		const run = await db
			.prepare(
				"SELECT status, duration_ms, result FROM operation_task_runs WHERE task = 'retention_cleanup' ORDER BY started_at DESC LIMIT 1",
			)
			.first<{
				status: string;
				duration_ms: number | null;
				result: string | null;
			}>();
		expect(run?.status).toBe("succeeded");
		expect(run?.duration_ms).toEqual(expect.any(Number));
		expect(JSON.parse(run?.result ?? "{}")).toEqual(
			expect.objectContaining({ affectedRows: 5 }),
		);
		const taskRunPlan = await db
			.prepare(
				`EXPLAIN QUERY PLAN
				 SELECT id FROM operation_task_runs INDEXED BY operation_task_runs_retention_idx
				 WHERE status IN ('succeeded', 'failed') AND completed_at < ?
				 ORDER BY completed_at, id LIMIT ?`,
			)
			.bind(now, 500)
			.all<{ detail: string }>();
		expect(
			taskRunPlan.results.map(({ detail }) => detail).join("\n"),
		).toContain("operation_task_runs_retention_idx");
	});

	it("continues retention on later ticks while expired rows remain", async () => {
		const now = Date.now();
		await db
			.prepare(
				`WITH RECURSIVE backlog(value) AS (
				 SELECT 1 UNION ALL SELECT value + 1 FROM backlog WHERE value < 2100
				)
				INSERT INTO audit_logs (id, action, target_type, created_at)
				SELECT 'expired-backlog-' || value, 'test.expired', 'test', ? FROM backlog`,
			)
			.bind(now - 366 * 86_400_000)
			.run();
		const remaining = () =>
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM audit_logs WHERE id LIKE 'expired-backlog-%'",
				)
				.first<{ count: number }>()
				.then((row) => row?.count ?? 0);
		const runsBefore = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM operation_task_runs WHERE task = 'retention_cleanup'",
			)
			.first<{ count: number }>();

		let ticks = 0;
		const retentionMinute = nextRetentionMinute(now);
		while ((await remaining()) > 0 && ticks < 5) {
			await runMaintenance(
				{ DB: db } as unknown as Env,
				"* * * * *",
				{
					expire: vi.fn(),
					recoverWebhooks: vi.fn(),
					loadDueWork: forcedDueWork(),
				},
				retentionMinute + ticks * RETENTION_INTERVAL_MS,
			);
			ticks += 1;
		}

		// One bounded chunk (at most 2000 rows) per retention minute, so the
		// backlog needs a second retention run and each run is tracked.
		expect(ticks).toBeGreaterThanOrEqual(2);
		await expect(remaining()).resolves.toBe(0);
		const runsAfter = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM operation_task_runs WHERE task = 'retention_cleanup' AND status = 'succeeded'",
			)
			.first<{ count: number }>();
		expect((runsAfter?.count ?? 0) - (runsBefore?.count ?? 0)).toBe(ticks);
	});

	it("bounds retention work and uses the expiry index under a large backlog", async () => {
		const now = Date.now();
		await db
			.prepare(
				`WITH RECURSIVE backlog(value) AS (
				 SELECT 1 UNION ALL SELECT value + 1 FROM backlog WHERE value < 501
				)
				INSERT INTO idempotency_keys
				 (id, key, request_hash, expires_at, created_at, updated_at)
				SELECT 'cleanup-' || value, 'cleanup-' || value, 'hash', ?, ?, ?
				FROM backlog`,
			)
			.bind(now - 1, now, now)
			.run();

		await runMaintenance(
			{ DB: db } as unknown as Env,
			"* * * * *",
			{
				expire: vi.fn(),
				recoverWebhooks: vi.fn(),
				loadDueWork: forcedDueWork(),
			},
			nextRetentionMinute(now),
		);

		const remaining = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM idempotency_keys WHERE id LIKE 'cleanup-%'",
			)
			.first<{ count: number }>();
		expect(remaining?.count).toBe(0);
		const plan = await db
			.prepare(
				`EXPLAIN QUERY PLAN
				 SELECT id FROM idempotency_keys INDEXED BY idempotency_keys_expires_idx
				 WHERE expires_at <= ? ORDER BY expires_at LIMIT ?`,
			)
			.bind(now, 500)
			.all<{ detail: string }>();
		expect(plan.results.map(({ detail }) => detail).join("\n")).toContain(
			"idempotency_keys_expires_idx",
		);
	});

	it("limits directly executed maintenance work to three concurrent tasks", async () => {
		let active = 0;
		let maximum = 0;
		const starts = new Map(
			["expiration", "webhook", "provider"].map((name) => [
				name,
				deferred<void>(),
			]),
		);
		const gates = new Map(
			["expiration", "webhook", "provider"].map((name) => [
				name,
				deferred<void>(),
			]),
		);
		const track = async (name: string) => {
			active += 1;
			maximum = Math.max(maximum, active);
			starts.get(name)?.resolve();
			await gates.get(name)?.promise;
			active -= 1;
		};
		const dependencies = {
			expire: vi.fn(async () => {
				await track("expiration");
				return 0;
			}),
			recoverWebhooks: vi.fn(async () => {
				await track("webhook");
				return { queued: 0, failed: 0 };
			}),
			recoverProviderEvents: vi.fn(() => track("provider")),
			loadDueWork: forcedDueWork({
				orderExpiration: true,
				webhookOutbox: true,
				paymentEventOutbox: true,
			}),
		} as unknown as NonNullable<Parameters<typeof runMaintenance>[2]>;

		const invocation = runMaintenance(
			{
				DB: db,
				PAYMENT_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) },
			} as unknown as Env,
			"*/1 * * * *",
			dependencies,
		);

		await Promise.all([...starts.values()].map(({ promise }) => promise));
		expect(active).toBe(3);
		expect(maximum).toBe(3);
		for (const gate of gates.values()) gate.resolve();
		await invocation;
	});

	it("uses a real task lease while another invocation continues independently", async () => {
		const expirationStarted = deferred<void>();
		const releaseExpiration = deferred<void>();
		const expire = vi.fn(async () => {
			expirationStarted.resolve();
			await releaseExpiration.promise;
			return 0;
		});
		const recoverWebhooks = vi.fn().mockResolvedValue({ queued: 0, failed: 0 });
		const dependencies = {
			expire,
			recoverWebhooks,
			refreshRpcHealth: vi.fn().mockResolvedValue({ checked: 0 }),
			refreshRateCategory: vi.fn().mockResolvedValue({ updated: 0 }),
			loadDueWork: forcedDueWork({
				orderExpiration: true,
				webhookOutbox: true,
			}),
		} as unknown as NonNullable<Parameters<typeof runMaintenance>[2]>;
		const env = {
			DB: db,
			PAYMENT_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) },
		} as unknown as Env;

		const first = runMaintenance(env, "*/1 * * * *", dependencies);
		await expirationStarted.promise;
		const second = runMaintenance(env, "*/1 * * * *", dependencies);
		await second;

		expect(expire).toHaveBeenCalledOnce();
		expect(recoverWebhooks).toHaveBeenCalled();
		const skipped = await db
			.prepare(
				`SELECT COUNT(*) AS count FROM audit_logs
				 WHERE action = 'maintenance.task_skipped'
				 AND target_id = 'order_expiration'`,
			)
			.first<{ count: number }>();
		expect(skipped?.count).toBeGreaterThan(0);
		releaseExpiration.resolve();
		await first;
	});

	it("waits for a started Queue send and reports deterministic over-budget wall time", async () => {
		const startedAt = 2_000_000_000_000;
		await seedScannableOrder(db, startedAt);
		const queueStarted = deferred<void>();
		const releaseQueue = deferred<void>();
		const sendBatch = vi.fn(() => {
			queueStarted.resolve();
			return releaseQueue.promise;
		});
		let now = startedAt;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		let completed = false;
		try {
			const invocation = runMaintenance(
				{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
				"*/1 * * * *",
				{
					expire: vi.fn().mockResolvedValue(0),
					recoverWebhooks: vi.fn().mockResolvedValue({ queued: 0, failed: 0 }),
					loadDueWork: forcedDueWork({ paymentScan: true }),
				},
			).then(() => {
				completed = true;
			});
			await queueStarted.promise;
			expect(completed).toBe(false);
			now += 900_001;
			releaseQueue.resolve();
			await invocation;

			expect(sendBatch).toHaveBeenCalledOnce();
			const record = info.mock.calls
				.map(([value]) => JSON.parse(String(value)))
				.find((entry) => entry.event === "scheduled_invocation_completed");
			expect(record).toEqual(
				expect.objectContaining({
					durationMs: 900_001,
					wallBudgetMs: 900_000,
					overBudget: true,
					outcome: "ok",
				}),
			);
		} finally {
			clock.mockRestore();
			info.mockRestore();
		}
	});

	it("skips an overlapping task lease without blocking independent tasks", async () => {
		const now = Date.now();
		await db
			.prepare(
				`INSERT INTO operation_task_runs
				 (id, task, trigger, schedule, status, started_at)
				 VALUES ('active-expiration', 'order_expiration', 'scheduled',
				 '*/1 * * * *', 'running', ?)`,
			)
			.bind(now)
			.run();
		const expire = vi.fn().mockResolvedValue(0);
		const recoverWebhooks = vi.fn().mockResolvedValue({ queued: 0, failed: 0 });
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		let records: Array<Record<string, unknown>> = [];
		try {
			await runMaintenance(
				{
					DB: db,
					PAYMENT_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) },
				} as unknown as Env,
				"*/1 * * * *",
				{
					expire,
					recoverWebhooks,
					loadDueWork: forcedDueWork({
						orderExpiration: true,
						webhookOutbox: true,
					}),
				},
			);
			records = info.mock.calls.map(([value]) => JSON.parse(String(value)));
		} finally {
			info.mockRestore();
			await db
				.prepare(
					"UPDATE operation_task_runs SET status = 'failed' WHERE id = 'active-expiration'",
				)
				.run();
		}

		expect(expire).not.toHaveBeenCalled();
		expect(recoverWebhooks).toHaveBeenCalledOnce();
		const skipped = await db
			.prepare(
				`SELECT target_id, after FROM audit_logs
				 WHERE action = 'maintenance.task_skipped'
				 ORDER BY created_at DESC, id DESC LIMIT 1`,
			)
			.first<{ target_id: string; after: string }>();
		expect(skipped?.target_id).toBe("order_expiration");
		expect(JSON.parse(skipped?.after ?? "{}")).toEqual({
			activeRunId: "active-expiration",
			attemptId: expect.any(String),
			invocationId: expect.any(String),
			reason: "already_running",
		});
		expect(records).toContainEqual(
			expect.objectContaining({
				event: "scheduled_invocation_completed",
				invocationId: expect.any(String),
				durationMs: expect.any(Number),
				outcome: "ok",
			}),
		);
		const invocationId = records.find(
			(record) => record.event === "scheduled_invocation_completed",
		)?.invocationId;
		expect(records).toContainEqual(
			expect.objectContaining({
				event: "operation_task_started",
				invocationId,
			}),
		);
		const failures = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'maintenance.task_failed' AND after LIKE '%order_expiration%'",
			)
			.first<{ count: number }>();
		expect(failures?.count).toBe(0);
	});

	it("does not persist task runs when no maintenance work is due", async () => {
		const before = await db
			.prepare("SELECT COUNT(*) AS count FROM operation_task_runs")
			.first<{ count: number }>();
		const expire = vi.fn();
		const recoverWebhooks = vi.fn();

		await runMaintenance({ DB: db } as unknown as Env, "*/1 * * * *", {
			expire,
			recoverWebhooks,
			loadDueWork: forcedDueWork(),
		});

		expect(expire).not.toHaveBeenCalled();
		expect(recoverWebhooks).not.toHaveBeenCalled();
		const after = await db
			.prepare("SELECT COUNT(*) AS count FROM operation_task_runs")
			.first<{ count: number }>();
		expect(after?.count).toBe(before?.count);
	});
});

type DueWorkName =
	| "orderExpiration"
	| "cryptoRateSync"
	| "fiatRateSync"
	| "webhookOutbox"
	| "paymentEventOutbox"
	| "inboundNotifications"
	| "rpcHealth"
	| "frequentCleanup"
	| "paymentScan";

function forcedDueWork(overrides: Partial<Record<DueWorkName, boolean>> = {}) {
	return vi.fn().mockResolvedValue({
		orderExpiration: false,
		cryptoRateSync: false,
		fiatRateSync: false,
		webhookOutbox: false,
		paymentEventOutbox: false,
		inboundNotifications: false,
		rpcHealth: false,
		frequentCleanup: false,
		paymentScan: false,
		...overrides,
	});
}

function deferred<T>() {
	let resolvePromise!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (value?: T) => resolvePromise(value as T),
	};
}

async function seedScannableOrder(db: D1Database, now: number) {
	await db.batch([
		db
			.prepare(
				"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('cron-tron', 'Cron TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT OR IGNORE INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('cron-asset', 'cron-tron', 'USDT', 'USDT', 'token', 6, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 1, created_at = ?, updated_at = ? WHERE id = 'cron-asset'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT OR IGNORE INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('cron-receiving', 'Cron receiver', 'cron-tron', 'address', 'TCron', 'TCron', 1, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT OR IGNORE INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at) VALUES ('cron-order', 'cron-order-number', 'pending', '100', 'USD', 2, 'cron-asset', '0', ?, 0, ?, ?)",
			)
			.bind(now + 900_000, now, now),
		db
			.prepare(
				`INSERT OR IGNORE INTO order_payment_snapshots
				 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind, asset_id, asset_code, decimals,
				 target_value, adapter, required_confirmations, expected_amount_units, created_at)
				 VALUES ('cron-order', 'cron-receiving', 'Cron receiver', 'cron-tron', 'chain', 'cron-asset', 'USDT', 6,
				 'TCron', 'mock', 1, '1000000', ?)`,
			)
			.bind(now),
		db
			.prepare(
				`INSERT INTO system_settings
				 (key, value, is_secret, created_at, updated_at)
				 VALUES ('runtime.last_payment_scan_at', '0', 0, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = '0', updated_at = excluded.updated_at`,
			)
			.bind(now, now),
	]);
}
