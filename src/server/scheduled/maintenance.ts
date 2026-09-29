import {
	hasOperationalRetentionWork,
	runOperationalRetentionCleanup,
} from "#/features/operations/server/operational-retention";
import {
	OperationTaskAlreadyRunningError,
	runTrackedTask,
} from "#/features/operations/server/task-runs";
import {
	loadRateSyncConfiguration,
	type RateSyncConfiguration,
} from "#/features/payment-settings/server/exchange-rates";
import { clearReusableReceivingMethodLockKeys } from "#/features/payment-settings/server/receiving-method-locks";
import { expireOrders } from "#/features/payments/server/expiration";
import { recoverProviderEventOutbox } from "#/features/payments/server/provider-event-outbox";
import type {
	PaymentEventSourceReconcileMessage,
	PaymentQueueMessage,
	PaymentRateSyncMessage,
	PaymentRpcHealthMessage,
	PaymentScanMessage,
} from "#/features/payments/types";
import {
	assertWebhookOutboxRecovered,
	recoverWebhookOutbox,
} from "#/features/webhooks/server/outbox";
import { DomainError } from "#/lib/domain-error";
import { loadOperationalSettings } from "#/server/operational-settings";

type MaintenanceDependencies = {
	expire: typeof expireOrders;
	recoverWebhooks: typeof recoverWebhookOutbox;
	recoverProviderEvents?: typeof recoverProviderEventOutbox;
	loadDueWork?: typeof loadDueMaintenanceWork;
};

const maintenanceDefaults: MaintenanceDependencies = {
	expire: expireOrders,
	recoverWebhooks: recoverWebhookOutbox,
	recoverProviderEvents: recoverProviderEventOutbox,
	loadDueWork: loadDueMaintenanceWork,
};

const CLEANUP_BATCH_SIZE = 500;
// Retention deletes one bounded chunk per tick and runs again on the next tick
// while expired rows remain, so steady-state volume never outgrows a daily cap.
const RETENTION_BATCH_SIZE = 250;
const RETENTION_MAX_ROWS = 2_000;
const RETENTION_MAX_DURATION_MS = 2_000;
const MAX_TASK_RUN_RETENTION_MS = 90 * 86_400_000;
const EXTERNAL_DISPATCH_LEASE_MS = 5 * 60_000;
const SCHEDULED_WALL_BUDGET_MS = 15 * 60_000;

export async function runMaintenance(
	env: Env,
	cron: string,
	dependencies: MaintenanceDependencies = maintenanceDefaults,
	scheduledAt = Date.now(),
): Promise<void> {
	const invocationId = crypto.randomUUID();
	const startedAt = Date.now();
	let outcome: "ok" | "failed" = "ok";
	try {
		await runMaintenanceInvocation(
			env,
			cron,
			dependencies,
			scheduledAt,
			invocationId,
		);
	} catch (error) {
		outcome = "failed";
		throw error;
	} finally {
		const completedAt = Date.now();
		const durationMs = Math.max(0, completedAt - startedAt);
		console.info(
			JSON.stringify({
				event: "scheduled_invocation_completed",
				invocationId,
				cron,
				startedAt,
				completedAt,
				durationMs,
				wallBudgetMs: SCHEDULED_WALL_BUDGET_MS,
				overBudget: durationMs >= SCHEDULED_WALL_BUDGET_MS,
				outcome,
			}),
		);
	}
}

async function runMaintenanceInvocation(
	env: Env,
	cron: string,
	dependencies: MaintenanceDependencies,
	now: number,
	invocationId: string,
) {
	const runScheduledTask = async (
		task: string,
		run: () => Promise<unknown>,
	) => {
		try {
			return await runTrackedTask(
				env.DB,
				{
					task,
					trigger: "scheduled",
					schedule: cron,
					invocationId,
				},
				run,
			);
		} catch (error) {
			if (!(error instanceof OperationTaskAlreadyRunningError)) throw error;
			await recordSkippedTask(env.DB, error, invocationId, now);
			return undefined;
		}
	};
	const settings = await loadOperationalSettings(env.DB);
	const retentionWork =
		(await hasRetentionCleanupWork(env.DB, now, settings.retentionAuditMs)) ||
		(await hasOperationalRetentionWork(env.DB, now, settings.retentionAuditMs));
	const [cryptoRateConfiguration, fiatRateConfiguration] = await Promise.all([
		loadRateSyncConfiguration(env.DB, "crypto"),
		loadRateSyncConfiguration(env.DB, "fiat"),
	]);
	const dueWork = await (dependencies.loadDueWork ?? loadDueMaintenanceWork)(
		env.DB,
		now,
		settings.reorgMonitorMs,
		settings.paymentScanIntervalMs,
		settings.webhookRecoveryIntervalMs,
		settings.rpcHealthIntervalMs,
		cryptoRateConfiguration,
		fiatRateConfiguration,
	);
	const [
		cryptoRateDispatch,
		fiatRateDispatch,
		eventSourceDispatch,
		rpcDispatch,
	] = await Promise.all([
		dueWork.cryptoRateSync
			? prepareRateSyncDispatch(env.DB, "crypto", now)
			: null,
		dueWork.fiatRateSync ? prepareRateSyncDispatch(env.DB, "fiat", now) : null,
		dueWork.inboundNotifications
			? preparePaymentEventSourceReconciliation(env.DB, now)
			: null,
		dueWork.rpcHealth
			? prepareRpcHealthDispatch(env.DB, now, settings.rpcHealthIntervalMs)
			: null,
	]);

	const tracked = (name: string, run: () => Promise<unknown>) => ({
		name,
		run: () => runScheduledTask(name, run),
	});
	const tasks = [
		retentionWork &&
			tracked("retention_cleanup", async () => {
				const core = await runRetentionCleanup(
					env.DB,
					now,
					settings.retentionAuditMs,
				);
				const operational = await runOperationalRetentionCleanup({
					db: env.DB,
					bucket: env.FILES,
					now,
					retentionMs: settings.retentionAuditMs,
				});
				return {
					affectedRows: core.affectedRows + operational.affectedRows,
					webhookRows: operational.webhookRows,
					auditExports: operational.auditExports,
				};
			}),
		dueWork.orderExpiration &&
			tracked("order_expiration", () => dependencies.expire(env, now)),
		cryptoRateDispatch &&
			tracked("crypto_rate_sync", () =>
				enqueueRateSync(env, cryptoRateDispatch, now),
			),
		fiatRateDispatch &&
			tracked("fiat_rate_sync", () =>
				enqueueRateSync(env, fiatRateDispatch, now),
			),
		dueWork.webhookOutbox &&
			tracked("webhook_outbox", async () => {
				const result = await dependencies.recoverWebhooks(env, now);
				assertWebhookOutboxRecovered(result);
				return result;
			}),
		dueWork.paymentEventOutbox &&
			tracked("payment_event_outbox", async () =>
				dependencies.recoverProviderEvents?.(env, now),
			),
		eventSourceDispatch &&
			tracked("inbound_notifications", () =>
				enqueuePaymentEventSourceReconciliation(env, eventSourceDispatch, now),
			),
		rpcDispatch &&
			tracked("rpc_health", () => enqueueRpcHealth(env, rpcDispatch, now)),
	].filter((task): task is ReturnType<typeof tracked> => Boolean(task));
	const taskResults = await settleMaintenanceTasks(tasks);
	const failedTasks = tasks.flatMap((task, index) =>
		taskResults[index]?.status === "rejected" ? [task.name] : [],
	);
	if (failedTasks.length)
		await recordFailedTasks(env.DB, failedTasks, invocationId, now);

	if (dueWork.frequentCleanup)
		await runScheduledTask("frequent_cleanup", () =>
			runFrequentCleanup(env.DB, now, settings.immediateReleaseMode),
		);
	if (!dueWork.paymentScan) return;
	if (!(await claimPaymentScan(env.DB, now, settings.paymentScanIntervalMs)))
		return;
	await runScheduledTask("payment_scan_enqueue", () =>
		enqueuePaymentScans(
			env,
			now,
			settings.paymentScanBatchSize,
			settings.reorgMonitorMs,
			settings.paymentScanIntervalMs,
			settings.webhookRecoveryIntervalMs,
		),
	);
}

type DueMaintenanceWork = {
	orderExpiration: boolean;
	cryptoRateSync: boolean;
	fiatRateSync: boolean;
	webhookOutbox: boolean;
	paymentEventOutbox: boolean;
	inboundNotifications: boolean;
	rpcHealth: boolean;
	frequentCleanup: boolean;
	paymentScan: boolean;
};

async function loadDueMaintenanceWork(
	db: D1Database,
	now: number,
	reorgMonitorMs: number,
	paymentScanIntervalMs: number,
	webhookRecoveryIntervalMs: number,
	rpcHealthIntervalMs: number,
	cryptoRateConfiguration: RateSyncConfiguration,
	fiatRateConfiguration: RateSyncConfiguration,
): Promise<DueMaintenanceWork> {
	const monitorSince = now - reorgMonitorMs;
	const defaultScanBefore = now - paymentScanIntervalMs;
	const webhookRecoveryBefore = now - webhookRecoveryIntervalMs;
	const rpcHealthDueBefore = now - rpcHealthIntervalMs;
	const row = await db
		.prepare(
			`SELECT
			 EXISTS(SELECT 1 FROM exchange_rates WHERE category = 'crypto' LIMIT 1) AS crypto_rates,
			 EXISTS(SELECT 1 FROM orders INDEXED BY orders_expiration_idx WHERE status IN ('pending','confirming','partially_paid') AND expires_at <= ? LIMIT 1) AS order_expiration,
			 EXISTS(SELECT 1 FROM webhook_deliveries
			  WHERE status IN ('queued','failed','delivering')
			  AND (next_attempt_at IS NULL OR next_attempt_at <= ?) LIMIT 1) AS webhook_outbox,
			 (EXISTS(SELECT 1 FROM inbound_provider_events INDEXED BY inbound_provider_events_outbox_idx
			  WHERE status IN ('received','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) LIMIT 1)
			  OR EXISTS(SELECT 1 FROM inbound_provider_events INDEXED BY inbound_provider_events_lease_idx
			  WHERE status = 'processing' AND lease_until <= ? LIMIT 1)) AS payment_event_outbox,
			 EXISTS(SELECT 1 FROM payment_ingresses INDEXED BY payment_ingresses_reconcile_idx
			  WHERE reconcile_required_at IS NOT NULL AND reconcile_required_at <= ? LIMIT 1) AS inbound_notifications,
			 EXISTS(SELECT 1 FROM payment_ingresses connection JOIN payment_rails rail ON rail.code = connection.rail_code
			  WHERE connection.enabled = 1 AND rail.kind = 'chain'
			  AND (connection.last_checked_at IS NULL OR connection.last_checked_at <= ?) LIMIT 1) AS rpc_health,
			 (EXISTS(SELECT 1 FROM receiving_method_locks INDEXED BY receiving_method_locks_expiry_idx
			  WHERE released_at IS NULL AND expires_at <= ? LIMIT 1)
			  OR EXISTS(SELECT 1 FROM rate_limit_counters INDEXED BY rate_limit_counters_expires_idx WHERE expires_at <= ? LIMIT 1)
			  OR EXISTS(SELECT 1 FROM idempotency_keys INDEXED BY idempotency_keys_expires_idx WHERE expires_at <= ? LIMIT 1)) AS frequent_cleanup,
			 EXISTS(SELECT 1 FROM orders o INDEXED BY orders_payment_scan_idx
			  JOIN order_payment_snapshots ops ON ops.order_id = o.id
			  LEFT JOIN payment_ingresses source
			   ON source.network = ops.rail_code AND source.provider = 'alchemy'
			   AND source.enabled = 1 AND source.mode = 'active'
			  WHERE o.status IN ('pending','confirming','partially_paid','paid','overpaid','expired')
			  AND (((o.status IN ('pending','partially_paid') AND o.expires_at > ?) OR o.status = 'confirming')
			   OR (o.status IN ('paid','overpaid') AND o.paid_at >= ?)
			   OR (o.status = 'expired' AND o.updated_at >= ?))
			  AND (o.last_payment_scan_at IS NULL OR o.last_payment_scan_at <= CASE
			   WHEN source.id IS NOT NULL AND source.health_status = 'healthy' THEN ?
			   ELSE ? END) LIMIT 1) AS payment_scan`,
		)
		.bind(
			now,
			now,
			now,
			now,
			now,
			rpcHealthDueBefore,
			now,
			now,
			now,
			now,
			monitorSince,
			monitorSince,
			webhookRecoveryBefore,
			defaultScanBefore,
		)
		.first<Record<string, number>>();
	return {
		orderExpiration: row?.order_expiration === 1,
		cryptoRateSync:
			row?.crypto_rates === 1 && isRateSyncDue(cryptoRateConfiguration, now),
		fiatRateSync:
			"credentials" in fiatRateConfiguration &&
			Boolean(fiatRateConfiguration.credentials.apiKey) &&
			isRateSyncDue(fiatRateConfiguration, now),
		webhookOutbox: row?.webhook_outbox === 1,
		paymentEventOutbox: row?.payment_event_outbox === 1,
		inboundNotifications: row?.inbound_notifications === 1,
		rpcHealth: row?.rpc_health === 1,
		frequentCleanup: row?.frequent_cleanup === 1,
		paymentScan: row?.payment_scan === 1,
	};
}

function isRateSyncDue(configuration: RateSyncConfiguration, now: number) {
	if (!configuration.enabled) return false;
	return (
		configuration.lastSyncedAt === null ||
		now - configuration.lastSyncedAt >= configuration.intervalMs
	);
}

async function hasRetentionCleanupWork(
	db: D1Database,
	now: number,
	retentionAuditMs: number,
) {
	const cutoff = now - retentionAuditMs;
	const taskRunCutoff = now - taskRunRetentionMs(retentionAuditMs);
	const row = await db
		.prepare(
			`SELECT
			 (EXISTS(SELECT 1 FROM rate_limit_counters INDEXED BY rate_limit_counters_expires_idx WHERE expires_at <= ? LIMIT 1)
			 OR EXISTS(SELECT 1 FROM idempotency_keys INDEXED BY idempotency_keys_expires_idx WHERE expires_at <= ? LIMIT 1)
			 OR EXISTS(SELECT 1 FROM audit_logs INDEXED BY audit_logs_created_idx WHERE created_at < ? LIMIT 1)
			 OR EXISTS(SELECT 1 FROM operation_task_runs INDEXED BY operation_task_runs_retention_idx
			  WHERE status IN ('succeeded','failed') AND completed_at < ? LIMIT 1)
			 OR EXISTS(SELECT 1 FROM inbound_provider_events INDEXED BY inbound_provider_events_retention_idx
			  WHERE status IN ('succeeded','ignored','ambiguous','dead') AND processed_at < ? LIMIT 1)
			 OR EXISTS(SELECT 1 FROM inbound_webhook_receipts INDEXED BY inbound_webhook_receipts_retention_idx WHERE received_at < ? LIMIT 1)
			 OR EXISTS(SELECT 1 FROM inbound_provider_deliveries delivery INDEXED BY inbound_provider_deliveries_retention_idx
			  WHERE delivery.received_at < ? AND NOT EXISTS (
			   SELECT 1 FROM inbound_provider_events event
			   WHERE event.source_id = delivery.source_id
			   AND event.provider_event_id = delivery.provider_event_id
			  ) LIMIT 1)) AS due`,
		)
		.bind(now, now, cutoff, taskRunCutoff, cutoff, cutoff, cutoff)
		.first<{ due: number }>();
	return row?.due === 1;
}

async function settleMaintenanceTasks(
	tasks: Array<{ run: () => Promise<unknown> }>,
) {
	const results: PromiseSettledResult<unknown>[] = new Array(tasks.length);
	let nextIndex = 0;
	const worker = async () => {
		while (nextIndex < tasks.length) {
			const index = nextIndex++;
			const task = tasks[index];
			if (!task) return;
			try {
				results[index] = { status: "fulfilled", value: await task.run() };
			} catch (reason) {
				results[index] = { status: "rejected", reason };
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(3, tasks.length) }, () => worker()),
	);
	return results;
}

async function runRetentionCleanup(
	db: D1Database,
	now: number,
	retentionAuditMs: number,
) {
	const taskRunCutoff = now - taskRunRetentionMs(retentionAuditMs);
	const deadline = performance.now() + RETENTION_MAX_DURATION_MS;
	let affectedRows = 0;
	while (affectedRows < RETENTION_MAX_ROWS && performance.now() < deadline) {
		const remaining = RETENTION_MAX_ROWS - affectedRows;
		const batchSize = Math.min(
			RETENTION_BATCH_SIZE,
			Math.max(1, Math.floor(remaining / 7)),
		);
		const statements = [
			db
				.prepare(
					`DELETE FROM rate_limit_counters WHERE id IN (
				 SELECT id FROM rate_limit_counters INDEXED BY rate_limit_counters_expires_idx
				 WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
				)`,
				)
				.bind(now, batchSize),
			db
				.prepare(
					`DELETE FROM idempotency_keys WHERE id IN (
				 SELECT id FROM idempotency_keys INDEXED BY idempotency_keys_expires_idx
				 WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
				)`,
				)
				.bind(now, batchSize),
			db
				.prepare(
					`DELETE FROM audit_logs WHERE id IN (
				 SELECT id FROM audit_logs INDEXED BY audit_logs_created_idx
				 WHERE created_at < ? ORDER BY created_at, id LIMIT ?
				)`,
				)
				.bind(now - retentionAuditMs, batchSize),
			db
				.prepare(
					`DELETE FROM operation_task_runs WHERE id IN (
				 SELECT id FROM operation_task_runs INDEXED BY operation_task_runs_retention_idx
				 WHERE status IN ('succeeded', 'failed') AND completed_at < ?
				 ORDER BY completed_at, id LIMIT ?
				)`,
				)
				.bind(taskRunCutoff, batchSize),
			db
				.prepare(
					`DELETE FROM inbound_provider_events WHERE id IN (
				 SELECT id FROM inbound_provider_events
				 INDEXED BY inbound_provider_events_retention_idx
				 WHERE status IN ('succeeded', 'ignored', 'ambiguous', 'dead')
				 AND processed_at < ? ORDER BY processed_at, id LIMIT ?
				)`,
				)
				.bind(now - retentionAuditMs, batchSize),
			db
				.prepare(
					`DELETE FROM inbound_webhook_receipts WHERE id IN (
				 SELECT id FROM inbound_webhook_receipts
				 INDEXED BY inbound_webhook_receipts_retention_idx
				 WHERE received_at < ? ORDER BY received_at, id LIMIT ?
				)`,
				)
				.bind(now - retentionAuditMs, batchSize),
			db
				.prepare(
					`DELETE FROM inbound_provider_deliveries WHERE id IN (
				 SELECT delivery.id FROM inbound_provider_deliveries delivery
				 INDEXED BY inbound_provider_deliveries_retention_idx
				 WHERE delivery.received_at < ? AND NOT EXISTS (
				  SELECT 1 FROM inbound_provider_events event
				  WHERE event.source_id = delivery.source_id
				  AND event.provider_event_id = delivery.provider_event_id
				 ) ORDER BY delivery.received_at, delivery.id LIMIT ?
				)`,
				)
				.bind(now - retentionAuditMs, batchSize),
		];
		const results = await db.batch(
			statements.slice(0, Math.min(statements.length, remaining)),
		);
		const changes = results.reduce(
			(sum, result) => sum + (result.meta.changes ?? 0),
			0,
		);
		affectedRows += changes;
		if (changes === 0) break;
	}
	return { affectedRows };
}

function taskRunRetentionMs(retentionAuditMs: number) {
	return Math.min(retentionAuditMs, MAX_TASK_RUN_RETENTION_MS);
}

async function runFrequentCleanup(
	db: D1Database,
	now: number,
	immediateReleaseMode: boolean,
) {
	const clearedReusableLocks = immediateReleaseMode
		? 0
		: await clearReusableReceivingMethodLockKeys(db, now);
	const lockCleanup = immediateReleaseMode
		? db
				.prepare(
					`DELETE FROM receiving_method_locks WHERE id IN (
					 SELECT id FROM receiving_method_locks INDEXED BY receiving_method_locks_expiry_idx
					 WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
					)`,
				)
				.bind(now, CLEANUP_BATCH_SIZE)
		: db
				.prepare(
					`UPDATE receiving_method_locks SET released_at = ? WHERE id IN (
					 SELECT id FROM receiving_method_locks INDEXED BY receiving_method_locks_expiry_idx
					 WHERE released_at IS NULL AND expires_at <= ?
					 ORDER BY expires_at LIMIT ?
					)`,
				)
				.bind(now, now, CLEANUP_BATCH_SIZE);
	const results = await db.batch([
		lockCleanup,
		db
			.prepare(
				`DELETE FROM rate_limit_counters WHERE id IN (
				 SELECT id FROM rate_limit_counters INDEXED BY rate_limit_counters_expires_idx
				 WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
				)`,
			)
			.bind(now, CLEANUP_BATCH_SIZE),
		db
			.prepare(
				`DELETE FROM idempotency_keys WHERE id IN (
				 SELECT id FROM idempotency_keys INDEXED BY idempotency_keys_expires_idx
				 WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
				)`,
			)
			.bind(now, CLEANUP_BATCH_SIZE),
	]);
	return {
		affectedRows:
			clearedReusableLocks +
			results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0),
	};
}

async function recordFailedTasks(
	db: D1Database,
	tasks: string[],
	invocationId: string,
	now: number,
) {
	await db.batch(
		tasks.map((task) =>
			db
				.prepare(
					`INSERT INTO audit_logs
					 (id, action, target_type, target_id, after, created_at)
					 VALUES (?, 'maintenance.task_failed', 'cron', NULL, ?, ?)`,
				)
				.bind(crypto.randomUUID(), JSON.stringify({ invocationId, task }), now),
		),
	);
}

async function recordSkippedTask(
	db: D1Database,
	error: OperationTaskAlreadyRunningError,
	invocationId: string,
	now: number,
) {
	await db
		.prepare(
			`INSERT INTO audit_logs
			 (id, action, target_type, target_id, after, created_at)
			 VALUES (?, 'maintenance.task_skipped', 'cron', ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			error.task,
			JSON.stringify({
				activeRunId: error.activeRunId,
				attemptId: error.attemptId,
				invocationId,
				reason: error.code,
			}),
			now,
		)
		.run();
}

type RateSyncDispatch = {
	category: "crypto" | "fiat";
	leaseKey: string;
	leaseUntil: number;
};

async function prepareRateSyncDispatch(
	db: D1Database,
	category: "crypto" | "fiat",
	now: number,
): Promise<RateSyncDispatch | null> {
	const leaseKey = `runtime.${category}_rate_sync_dispatch_lease`;
	const leaseUntil = now + EXTERNAL_DISPATCH_LEASE_MS;
	return (await claimDispatchLease(db, leaseKey, now, leaseUntil))
		? { category, leaseKey, leaseUntil }
		: null;
}

async function enqueueRateSync(
	env: Env,
	dispatch: RateSyncDispatch,
	now: number,
) {
	return sendPaymentQueueMessages(
		env,
		[
			{
				kind: "payment.rate_sync",
				version: 1,
				category: dispatch.category,
			} satisfies PaymentRateSyncMessage,
		],
		() =>
			releaseDispatchLease(env.DB, dispatch.leaseKey, dispatch.leaseUntil, now),
	);
}

type RpcHealthDispatch = {
	connectionIds: string[];
	leaseKey: string;
	leaseUntil: number;
};

async function prepareRpcHealthDispatch(
	db: D1Database,
	now: number,
	intervalMs: number,
): Promise<RpcHealthDispatch | null> {
	const dueBefore = now - intervalMs;
	const rows = await db
		.prepare(
			`SELECT connection.id FROM payment_ingresses connection
		 INDEXED BY payment_ingresses_health_due_idx
		 JOIN payment_rails rail ON rail.code = connection.rail_code
		 WHERE connection.enabled = 1 AND rail.kind = 'chain'
		 AND (connection.last_checked_at IS NULL OR connection.last_checked_at <= ?)
		 ORDER BY connection.last_checked_at IS NOT NULL,
		 connection.last_checked_at, connection.priority, connection.id LIMIT 20`,
		)
		.bind(dueBefore)
		.all<{ id: string }>();
	const connectionIds = rows.results.map(({ id }) => id);
	if (!connectionIds.length) return null;
	const leaseKey = "runtime.rpc_health_dispatch_lease";
	const leaseUntil = now + EXTERNAL_DISPATCH_LEASE_MS;
	return (await claimDispatchLease(db, leaseKey, now, leaseUntil))
		? { connectionIds, leaseKey, leaseUntil }
		: null;
}

async function enqueueRpcHealth(
	env: Env,
	dispatch: RpcHealthDispatch,
	now: number,
) {
	return sendPaymentQueueMessages(
		env,
		[
			{
				kind: "payment.rpc_health",
				version: 1,
				connectionIds: dispatch.connectionIds,
			} satisfies PaymentRpcHealthMessage,
		],
		() =>
			releaseDispatchLease(env.DB, dispatch.leaseKey, dispatch.leaseUntil, now),
	);
}

type EventSourceDispatch = {
	sourceIds: string[];
	leaseUntil: number;
};

async function preparePaymentEventSourceReconciliation(
	db: D1Database,
	now: number,
): Promise<EventSourceDispatch | null> {
	const sources = await db
		.prepare(
			`SELECT id FROM payment_ingresses INDEXED BY payment_ingresses_reconcile_idx
		 WHERE reconcile_required_at IS NOT NULL AND reconcile_required_at <= ?
		 ORDER BY reconcile_required_at, id LIMIT 4`,
		)
		.bind(now)
		.all<{ id: string }>();
	if (!sources.results.length) return null;
	const leaseUntil = now + EXTERNAL_DISPATCH_LEASE_MS;
	const claims = await db.batch(
		sources.results.map(({ id }) =>
			db
				.prepare(
					`UPDATE payment_ingresses SET reconcile_required_at = ?, updated_at = ?
				 WHERE id = ? AND reconcile_required_at IS NOT NULL
				 AND reconcile_required_at <= ?`,
				)
				.bind(leaseUntil, now, id, now),
		),
	);
	const sourceIds = sources.results.flatMap(({ id }, index) =>
		claims[index]?.meta.changes === 1 ? [id] : [],
	);
	return sourceIds.length ? { sourceIds, leaseUntil } : null;
}

async function enqueuePaymentEventSourceReconciliation(
	env: Env,
	dispatch: EventSourceDispatch,
	now: number,
) {
	return sendPaymentQueueMessages(
		env,
		dispatch.sourceIds.map(
			(sourceId) =>
				({
					kind: "payment.event_source_reconcile",
					version: 1,
					sourceId,
				}) satisfies PaymentEventSourceReconcileMessage,
		),
		() =>
			env.DB.batch(
				dispatch.sourceIds.map((id) =>
					env.DB.prepare(
						`UPDATE payment_ingresses SET reconcile_required_at = ?, updated_at = ?
					 WHERE id = ? AND reconcile_required_at = ?`,
					).bind(now, now, id, dispatch.leaseUntil),
				),
			),
	);
}

async function claimDispatchLease(
	db: D1Database,
	key: string,
	now: number,
	leaseUntil: number,
) {
	const result = await db
		.prepare(
			`INSERT INTO system_settings
			 (key, value, is_secret, updated_by, created_at, updated_at)
			 VALUES (?, ?, 0, NULL, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			 updated_at = excluded.updated_at
			 WHERE CAST(system_settings.value AS INTEGER) <= ?`,
		)
		.bind(key, String(leaseUntil), now, now, now)
		.run();
	return result.meta.changes === 1;
}

async function releaseDispatchLease(
	db: D1Database,
	key: string,
	leaseUntil: number,
	now: number,
) {
	await db
		.prepare(
			"UPDATE system_settings SET value = '0', updated_at = ? WHERE key = ? AND value = ?",
		)
		.bind(now, key, String(leaseUntil))
		.run();
}

async function sendPaymentQueueMessages(
	env: Env,
	messages: PaymentQueueMessage[],
	onFailure?: () => Promise<unknown>,
) {
	if (!env.PAYMENT_QUEUE)
		throw new DomainError(
			"binding_unavailable",
			503,
			"Payment Queue binding is unavailable",
		);
	try {
		await env.PAYMENT_QUEUE.sendBatch(messages.map((body) => ({ body })));
	} catch {
		await onFailure?.();
		throw new DomainError(
			"queue_enqueue_failed",
			502,
			"Payment Queue rejected the maintenance batch",
		);
	}
	console.info(
		JSON.stringify({
			event: "payment_maintenance_enqueued",
			messageCount: messages.length,
			estimatedQueueOperations: messages.length * 3,
			kinds: [...new Set(messages.map(({ kind }) => kind))],
		}),
	);
	return { enqueued: messages.length };
}

async function enqueuePaymentScans(
	env: Env,
	now: number,
	batchSize: number,
	reorgMonitorMs: number,
	paymentScanIntervalMs: number,
	webhookRecoveryIntervalMs: number,
) {
	if (!env.PAYMENT_QUEUE)
		throw new DomainError(
			"binding_unavailable",
			503,
			"Payment Queue binding is unavailable",
		);
	const monitorSince = now - reorgMonitorMs;
	const defaultScanBefore = now - paymentScanIntervalMs;
	const webhookRecoveryBefore = now - webhookRecoveryIntervalMs;
	const activeOrders = await env.DB.prepare(
		`SELECT o.id, ops.receiving_method_id, ops.asset_code
		 FROM orders o INDEXED BY orders_payment_scan_idx
		 CROSS JOIN order_payment_snapshots ops ON ops.order_id = o.id
		 LEFT JOIN payment_ingresses source
		  ON source.network = ops.rail_code AND source.provider = 'alchemy'
		  AND source.enabled = 1 AND source.mode = 'active'
		 WHERE o.status IN ('pending','confirming','partially_paid','paid','overpaid','expired')
		 AND (
		  ((o.status IN ('pending','partially_paid') AND o.expires_at > ?) OR o.status = 'confirming')
		  OR (o.status IN ('paid','overpaid') AND o.paid_at >= ?)
		  OR (o.status = 'expired' AND o.updated_at >= ?)
		 )
		 AND (o.last_payment_scan_at IS NULL OR o.last_payment_scan_at <= CASE
		  WHEN source.id IS NOT NULL AND source.health_status = 'healthy' THEN ?
		  ELSE ? END)
		 ORDER BY o.last_payment_scan_at ASC, o.created_at ASC, o.rowid ASC LIMIT ?`,
	)
		.bind(
			now,
			monitorSince,
			monitorSince,
			webhookRecoveryBefore,
			defaultScanBefore,
			batchSize,
		)
		.all<{
			id: string;
			receiving_method_id: string;
			asset_code: string;
		}>();
	if (!activeOrders.results.length) return;
	// Select the oldest due batch first; USDT priority must not starve other assets.
	const orders = activeOrders.results.sort(
		(left, right) =>
			Number(right.asset_code === "USDT") - Number(left.asset_code === "USDT"),
	);
	try {
		await env.PAYMENT_QUEUE.sendBatch(
			orders.map((order) => ({
				body: {
					kind: "payment.scan",
					version: 1,
					receivingMethodId: order.receiving_method_id,
					orderId: order.id,
				} satisfies PaymentScanMessage,
			})),
		);
	} catch {
		throw new DomainError(
			"queue_enqueue_failed",
			502,
			"Payment Queue rejected the scheduled scan batch",
		);
	}
	// Advance fairness only after Queue accepted the complete batch.
	await env.DB.batch(
		orders.map((order) =>
			env.DB.prepare(
				"UPDATE orders SET last_payment_scan_at = ? WHERE id = ?",
			).bind(now, order.id),
		),
	);
	return {
		enqueued: orders.length,
		affectedRows: orders.length,
	};
}

async function claimPaymentScan(
	db: D1Database,
	now: number,
	intervalMs: number,
) {
	const result = await db
		.prepare(
			`INSERT INTO system_settings
			 (key, value, is_secret, updated_by, created_at, updated_at)
			 VALUES ('runtime.last_payment_scan_at', ?, 0, NULL, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			 updated_at = excluded.updated_at
			 WHERE CAST(system_settings.value AS INTEGER) <= ?`,
		)
		.bind(String(now), now, now, now - Math.max(15_000, intervalMs))
		.run();
	return result.meta.changes > 0;
}
