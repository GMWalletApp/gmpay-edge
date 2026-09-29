import { DomainError } from "#/lib/domain-error";
import type { ReadDatabase } from "#/server/read-replica";

const TASK_LEASE_MS = 30 * 60_000;

export class OperationTaskAlreadyRunningError extends DomainError {
	constructor(
		readonly task: string,
		readonly attemptId: string,
		readonly activeRunId: string | null,
	) {
		super("already_running", 409, "This operation task is already running");
		this.name = "OperationTaskAlreadyRunningError";
	}
}

export async function runTrackedTask<T>(
	db: D1Database,
	input: {
		task: string;
		trigger: "manual" | "scheduled";
		schedule?: string | null;
		now?: number;
		invocationId?: string;
	},
	run: () => Promise<T>,
): Promise<T> {
	const startedAt = input.now ?? Date.now();
	const id = crypto.randomUUID();
	const leaseCutoff = startedAt - TASK_LEASE_MS;
	const [, claim] = await db.batch([
		db
			.prepare(
				`UPDATE operation_task_runs
				 SET status = 'failed', completed_at = ?,
				 duration_ms = MAX(0, ? - started_at),
				 error_code = 'lease_expired'
				 WHERE task = ? AND status = 'running' AND started_at <= ?`,
			)
			.bind(startedAt, startedAt, input.task, leaseCutoff),
		db
			.prepare(
				`INSERT INTO operation_task_runs
			(id, task, trigger, schedule, status, started_at)
			SELECT ?, ?, ?, ?, 'running', ?
			WHERE NOT EXISTS (
			 SELECT 1 FROM operation_task_runs WHERE task = ? AND status = 'running'
			 AND started_at > ?
			)`,
			)
			.bind(
				id,
				input.task,
				input.trigger,
				input.schedule ?? null,
				startedAt,
				input.task,
				leaseCutoff,
			),
	]);
	if ((claim?.meta.changes ?? 0) !== 1) {
		const active = await db
			.prepare(
				`SELECT id FROM operation_task_runs
				 WHERE task = ? AND status = 'running' AND started_at > ?
				 ORDER BY started_at DESC, id DESC LIMIT 1`,
			)
			.bind(input.task, leaseCutoff)
			.first<{ id: string }>();
		logTaskRun({
			event: "operation_task_skipped",
			taskRunId: id,
			task: input.task,
			trigger: input.trigger,
			invocationId: input.invocationId ?? null,
			startedAt,
			status: "skipped",
			errorCode: "already_running",
			activeRunId: active?.id ?? null,
		});
		throw new OperationTaskAlreadyRunningError(
			input.task,
			id,
			active?.id ?? null,
		);
	}
	logTaskRun({
		event: "operation_task_started",
		taskRunId: id,
		task: input.task,
		trigger: input.trigger,
		invocationId: input.invocationId ?? null,
		startedAt,
		status: "running",
	});
	try {
		const result = await run();
		const completedAt = Date.now();
		const durationMs = Math.max(0, completedAt - startedAt);
		await db
			.prepare(
				`UPDATE operation_task_runs SET status = 'succeeded', completed_at = ?,
				 duration_ms = ?, result = ? WHERE id = ? AND status = 'running'`,
			)
			.bind(completedAt, durationMs, JSON.stringify(result ?? null), id)
			.run();
		logTaskRun({
			event: "operation_task_completed",
			taskRunId: id,
			task: input.task,
			trigger: input.trigger,
			invocationId: input.invocationId ?? null,
			startedAt,
			completedAt,
			durationMs,
			status: "succeeded",
		});
		return result;
	} catch (error) {
		const completedAt = Date.now();
		const durationMs = Math.max(0, completedAt - startedAt);
		const errorCode = taskErrorCode(error);
		await db
			.prepare(
				`UPDATE operation_task_runs SET status = 'failed', completed_at = ?,
				 duration_ms = ?, error_code = ? WHERE id = ? AND status = 'running'`,
			)
			.bind(completedAt, durationMs, errorCode, id)
			.run();
		logTaskRun({
			event: "operation_task_completed",
			taskRunId: id,
			task: input.task,
			trigger: input.trigger,
			invocationId: input.invocationId ?? null,
			startedAt,
			completedAt,
			durationMs,
			status: "failed",
			errorCode,
		});
		throw error;
	}
}

export type LatestOperationTaskRun = {
	id: string;
	task: string;
	trigger: "manual" | "scheduled";
	schedule: string | null;
	status: "running" | "succeeded" | "failed";
	started_at: number;
	completed_at: number | null;
	duration_ms: number | null;
	error_code: string | null;
};

/**
 * Newest run per requested task through one indexed seek each
 * (`operation_task_runs_task_started_idx`) instead of ranking every run.
 */
export async function loadLatestOperationTaskRuns(
	db: ReadDatabase,
	tasks: readonly string[],
) {
	const rows = await db
		.prepare(
			`SELECT run.id, run.task, run.trigger, run.schedule, run.status, run.started_at,
			 run.completed_at, run.duration_ms, run.error_code
			 FROM json_each(?) AS requested
			 JOIN operation_task_runs run ON run.id = (
			  SELECT id FROM operation_task_runs INDEXED BY operation_task_runs_task_started_idx
			  WHERE task = requested.value ORDER BY started_at DESC LIMIT 1
			 )`,
		)
		.bind(JSON.stringify(tasks))
		.all<LatestOperationTaskRun>();
	return rows.results;
}

function logTaskRun(event: Record<string, unknown>) {
	console.info(JSON.stringify(event));
}

function taskErrorCode(error: unknown) {
	if (error instanceof OperationTaskAlreadyRunningError) return error.code;
	if (error instanceof DomainError) return error.code;
	if (error instanceof DOMException && error.name === "TimeoutError")
		return "timeout";
	return "task_failed";
}
