import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type OperationsTask,
	runOperationsTask,
} from "#/features/operations/server/run-task";
import { runTrackedTask } from "#/features/operations/server/task-runs";
import { applyMigrations } from "./migrations";

describe("manual operations tasks", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-operations-tasks" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at) VALUES ('actor', 'Root', 'root@example.com', 1, 1, 1, 1)",
			)
			.run();
	});

	afterAll(async () => miniflare.dispose());

	it("routes only the selected bounded task and audits its structured result", async () => {
		const expire = vi.fn().mockResolvedValue(2);
		const recoverWebhooks = vi.fn().mockResolvedValue({ queued: 3, failed: 0 });
		const refreshRpc = vi
			.fn()
			.mockResolvedValue({ checked: 4, healthy: 3, unhealthy: 1 });
		const refreshRates = vi.fn().mockResolvedValue({
			configured: 5,
			updated: 5,
			failed: 0,
			failures: [],
		});
		const reconcilePaymentDefaults = vi.fn().mockResolvedValue({
			rails: 0,
			assets: 1,
			connections: 1,
			exchangeRates: 1,
			rateSyncSettings: 2,
		});
		const dependencies = {
			expire,
			recoverWebhooks,
			refreshRpc,
			refreshRates,
			reconcilePaymentDefaults,
		};
		const queue = { send: vi.fn() } as unknown as Queue;
		const env = { DB: db, WEBHOOK_QUEUE: queue } as Env;
		const expectations: Array<{
			task: OperationsTask;
			result: Record<string, unknown>;
		}> = [
			{ task: "order_expiration", result: { expired: 2 } },
			{ task: "webhook_outbox", result: { queued: 3, failed: 0 } },
			{
				task: "rpc_health",
				result: { checked: 4, healthy: 3, unhealthy: 1 },
			},
			{
				task: "crypto_rate_sync",
				result: { configured: 5, updated: 5, failed: 0, failures: [] },
			},
			{
				task: "fiat_rate_sync",
				result: { configured: 5, updated: 5, failed: 0, failures: [] },
			},
			{
				task: "payment_defaults",
				result: {
					rails: 0,
					assets: 1,
					connections: 1,
					exchangeRates: 1,
					rateSyncSettings: 2,
				},
			},
		];
		for (const [index, expectation] of expectations.entries()) {
			await expect(
				runOperationsTask(
					env,
					{
						task: expectation.task,
						actorUserId: "actor",
						requestId: `request-${expectation.task}`,
						ipAddress: "203.0.113.70",
						now: 100 + index,
					},
					dependencies,
				),
			).resolves.toMatchObject({
				task: expectation.task,
				result: expectation.result,
			});
		}
		expect(expire).toHaveBeenCalledOnce();
		expect(recoverWebhooks).toHaveBeenCalledOnce();
		expect(refreshRpc).toHaveBeenCalledOnce();
		expect(refreshRates).toHaveBeenCalledTimes(2);
		expect(refreshRates.mock.calls.map((call) => call[3]?.category)).toEqual([
			"crypto",
			"fiat",
		]);
		expect(reconcilePaymentDefaults).toHaveBeenCalledOnce();

		const audits = await db
			.prepare(
				"SELECT target_id, request_id, ip_address, after FROM audit_logs WHERE action = 'operations.task_run' ORDER BY created_at",
			)
			.all<{
				target_id: string;
				request_id: string;
				ip_address: string;
				after: string;
			}>();
		expect(audits.results).toHaveLength(6);
		expect(audits.results.map((row) => row.target_id)).toEqual(
			expectations.map(({ task }) => task),
		);
		expect(audits.results[3]).toMatchObject({
			request_id: "request-crypto_rate_sync",
			ip_address: "203.0.113.70",
		});
		expect(JSON.parse(audits.results[3]?.after ?? "null")).toEqual(
			expectations[3]?.result,
		);
	});

	it("requires the queue binding before attempting outbox recovery", async () => {
		const recoverWebhooks = vi.fn();
		await expect(
			runOperationsTask(
				{ DB: db } as Env,
				{
					task: "webhook_outbox",
					actorUserId: "actor",
				},
				{
					expire: vi.fn(),
					recoverWebhooks,
					refreshRpc: vi.fn(),
					refreshRates: vi.fn(),
					reconcilePaymentDefaults: vi.fn(),
				},
			),
		).rejects.toThrow("Webhook Queue binding is unavailable");
		expect(recoverWebhooks).not.toHaveBeenCalled();
	});

	it("marks partial outbox enqueue failure as a failed operation", async () => {
		await expect(
			runOperationsTask(
				{ DB: db, WEBHOOK_QUEUE: { send: vi.fn() } } as unknown as Env,
				{ task: "webhook_outbox", actorUserId: "actor" },
				{
					expire: vi.fn(),
					recoverWebhooks: vi.fn().mockResolvedValue({ queued: 2, failed: 1 }),
					refreshRpc: vi.fn(),
					refreshRates: vi.fn(),
					reconcilePaymentDefaults: vi.fn(),
				},
			),
		).rejects.toMatchObject({ code: "queue_enqueue_failed" });
		const run = await db
			.prepare(
				"SELECT status, error_code FROM operation_task_runs WHERE task = 'webhook_outbox' ORDER BY started_at DESC, id DESC LIMIT 1",
			)
			.first<{ status: string; error_code: string | null }>();
		expect(run).toEqual({
			status: "failed",
			error_code: "queue_enqueue_failed",
		});
	});

	it("does not record a successful task audit when the task fails", async () => {
		const before = await auditCount(db);
		await expect(
			runOperationsTask(
				{ DB: db } as Env,
				{ task: "rpc_health", actorUserId: "actor" },
				{
					expire: vi.fn(),
					recoverWebhooks: vi.fn(),
					refreshRpc: vi.fn().mockRejectedValue(new Error("RPC task failed")),
					refreshRates: vi.fn(),
					reconcilePaymentDefaults: vi.fn(),
				},
			),
		).rejects.toThrow("RPC task failed");
		await expect(auditCount(db)).resolves.toBe(before);
		const failed = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action = 'operations.task_failed' AND target_id = 'rpc_health' ORDER BY created_at DESC LIMIT 1",
			)
			.first<{ after: string }>();
		expect(JSON.parse(failed?.after ?? "null")).toEqual({ code: "task_error" });
		expect(failed?.after).not.toContain("RPC task failed");
	});

	it("rejects a concurrent run of the same task until the active run finishes", async () => {
		let release: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const active = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const first = runTrackedTask(
			db,
			{ task: "concurrency-test", trigger: "manual", now: 10_000 },
			async () => {
				entered?.();
				await active;
				return { ok: true };
			},
		);
		await started;
		await expect(
			runTrackedTask(
				db,
				{ task: "concurrency-test", trigger: "manual", now: 10_001 },
				async () => ({ duplicate: true }),
			),
		).rejects.toMatchObject({
			name: "OperationTaskAlreadyRunningError",
			code: "already_running",
			task: "concurrency-test",
			activeRunId: expect.any(String),
		});
		release?.();
		await expect(first).resolves.toEqual({ ok: true });
		const runs = await db
			.prepare(
				"SELECT status, COUNT(*) AS count FROM operation_task_runs WHERE task = 'concurrency-test' GROUP BY status",
			)
			.all<{ status: string; count: number }>();
		expect(runs.results).toEqual([{ status: "succeeded", count: 1 }]);
	});

	it("uses the task lease index when expiring stale runs", async () => {
		const plan = await db
			.prepare(
				`EXPLAIN QUERY PLAN
				 UPDATE operation_task_runs
				 SET status = 'failed', completed_at = ?,
				 duration_ms = MAX(0, ? - started_at),
				 error_code = 'lease_expired'
				 WHERE task = ? AND status = 'running' AND started_at <= ?`,
			)
			.bind(Date.now(), Date.now(), "lease-plan-test", Date.now())
			.all<{ detail: string }>();

		expect(plan.results.map(({ detail }) => detail).join("\n")).toContain(
			"operation_task_runs_task_status_started_idx",
		);
	});

	it("expires a stale task lease atomically before starting its replacement", async () => {
		const now = Date.now();
		const staleStartedAt = now - 30 * 60_000 - 1;
		await db
			.prepare(
				`INSERT INTO operation_task_runs
				 (id, task, trigger, status, started_at)
				 VALUES ('stale-run', 'stale-lease-test', 'scheduled', 'running', ?)`,
			)
			.bind(staleStartedAt)
			.run();

		await expect(
			runTrackedTask(
				db,
				{ task: "stale-lease-test", trigger: "scheduled", now },
				async () => ({ recovered: true }),
			),
		).resolves.toEqual({ recovered: true });

		const runs = await db
			.prepare(
				`SELECT id, status, completed_at, duration_ms, error_code
				 FROM operation_task_runs WHERE task = 'stale-lease-test'
				 ORDER BY started_at`,
			)
			.all<{
				id: string;
				status: string;
				completed_at: number | null;
				duration_ms: number | null;
				error_code: string | null;
			}>();
		expect(runs.results).toHaveLength(2);
		expect(runs.results[0]).toEqual({
			id: "stale-run",
			status: "failed",
			completed_at: now,
			duration_ms: now - staleStartedAt,
			error_code: "lease_expired",
		});
		expect(runs.results[1]).toMatchObject({
			status: "succeeded",
			error_code: null,
		});
	});

	it("emits bounded structured task lifecycle records", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		let records: Array<Record<string, unknown>> = [];
		try {
			await runTrackedTask(
				db,
				{ task: "structured-log-test", trigger: "manual" },
				async () => ({ secret: "result-is-not-logged" }),
			);
		} finally {
			records = info.mock.calls.map(([value]) => JSON.parse(String(value)));
			info.mockRestore();
		}
		expect(records).toEqual([
			expect.objectContaining({
				event: "operation_task_started",
				taskRunId: expect.any(String),
				task: "structured-log-test",
				status: "running",
			}),
			expect.objectContaining({
				event: "operation_task_completed",
				taskRunId: expect.any(String),
				task: "structured-log-test",
				status: "succeeded",
				durationMs: expect.any(Number),
			}),
		]);
		expect(JSON.stringify(records)).not.toContain("result-is-not-logged");
	});
});

async function auditCount(db: D1Database) {
	return (
		await db
			.prepare(
				"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'operations.task_run'",
			)
			.first<{ count: number }>()
	)?.count;
}
