import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Play } from "lucide-react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ProTable } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { operationsErrorMessage } from "#/features/operations/error-message";
import {
	formatScheduleInterval,
	nextTaskExecutionAt,
	type ScheduledTaskName,
	scheduledTaskCatalog,
} from "#/features/operations/schedule";
import {
	getOperationsOverviewFn,
	runOperationsTaskFn,
} from "#/features/operations/server/admin";
import type { OperationsTask } from "#/features/operations/server/run-task";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

type TaskRun = Awaited<
	ReturnType<typeof getOperationsOverviewFn>
>["taskRuns"][number];
type TaskRow = {
	task: ScheduledTaskName;
	schedule: string | null;
	manual: boolean;
	run: TaskRun | null;
	nextExecutionAt: string | null;
};

type TaskName = (typeof scheduledTaskCatalog)[number]["task"];

export function JobsPage() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "task" });
	const client = useQueryClient();
	const query = useQuery({
		queryKey: ["admin", "operations"],
		queryFn: () => getOperationsOverviewFn(),
		refetchInterval: 30_000,
	});
	const runTask = useMutation({
		mutationFn: runOperationsTaskFn,
		onSuccess: async (result) => {
			await client.invalidateQueries({ queryKey: ["admin", "operations"] });
			toast.success(m.jobs_task_completed({ task: taskLabel(result.task) }));
		},
		onError: (error) =>
			toast.error(operationsErrorMessage(error, m.jobs_task_failed)),
	});
	const latest = new Map(query.data?.taskRuns.map((run) => [run.task, run]));
	const rateIntervalsMs = query.data?.rateIntervals ?? {
		crypto: 3_600_000,
		fiat: 86_400_000,
	};
	const rows: TaskRow[] = scheduledTaskCatalog.map((entry) => {
		const run = latest.get(entry.task) ?? null;
		return {
			...entry,
			schedule: taskScheduleLabel(entry.task, rateIntervalsMs),
			run,
			nextExecutionAt: nextTaskExecutionAt(
				entry.task,
				run?.startedAt ?? null,
				rateIntervalsMs,
			),
		};
	});
	const columns: ColumnDef<TaskRow>[] = [
		{
			accessorKey: "task",
			header: m.jobs_task_name(),
			cell: ({ row }) => taskLabel(row.original.task),
			meta: { search: true },
		},
		{
			accessorKey: "schedule",
			header: m.jobs_schedule(),
			cell: ({ row }) => row.original.schedule ?? "—",
		},
		{
			id: "executedAt",
			header: m.jobs_last_execution(),
			cell: ({ row }) =>
				row.original.run ? formatDateTime(row.original.run.startedAt) : "—",
		},
		{
			accessorKey: "nextExecutionAt",
			header: m.jobs_next_execution(),
			cell: ({ row }) =>
				row.original.nextExecutionAt
					? formatDateTime(row.original.nextExecutionAt)
					: "—",
		},
		{
			id: "duration",
			header: m.common_duration(),
			cell: ({ row }) =>
				row.original.run?.durationMs == null
					? "—"
					: `${row.original.run.durationMs} ${m.unit_milliseconds()}`,
		},
		{
			id: "status",
			header: m.common_status(),
			cell: ({ row }) => <TaskStatus status={row.original.run?.status} />,
		},
		{
			id: "error",
			header: m.common_last_error(),
			cell: ({ row }) => taskErrorLabel(row.original.run?.errorCode),
		},
		{
			id: "actions",
			header: m.common_actions(),
			cell: ({ row }) =>
				row.original.manual ? (
					<div className="flex justify-end">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<ProButton
									variant="ghost"
									size="icon-sm"
									tooltip={m.common_actions()}
								>
									<MoreHorizontal />
								</ProButton>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-44">
								<DropdownMenuItem
									disabled={
										runTask.isPending || row.original.run?.status === "running"
									}
									onClick={() =>
										runTask.mutate({
											data: { task: row.original.task as OperationsTask },
										})
									}
								>
									<Play />
									{m.common_run_now()}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				) : null,
		},
	];
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				title={m.nav_scheduled_tasks()}
				description={m.jobs_description()}
			/>
			<ProTable
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				className="min-h-0 flex-1"
				columns={columns}
				data={rows}
				loading={query.isLoading}
				onRefresh={() => query.refetch()}
				pagination={false}
				toolbarSearch={{ columnId: "task", placeholder: m.common_search() }}
				table={{ stickyHeader: true }}
			/>
		</div>
	);
}

function taskScheduleLabel(
	task: TaskName,
	rateIntervalsMs: { crypto: number; fiat: number },
) {
	if (task === "payment_defaults") return null;
	let intervalMs = 60_000;
	if (task === "crypto_rate_sync") intervalMs = rateIntervalsMs.crypto;
	if (task === "fiat_rate_sync") intervalMs = rateIntervalsMs.fiat;
	return m.jobs_schedule_every({
		time: formatScheduleInterval(intervalMs, getLocale()),
	});
}

function taskErrorLabel(code: string | null | undefined) {
	if (!code) return "—";
	if (code === "already_running") return m.jobs_error_already_running();
	if (code === "binding_unavailable") return m.jobs_error_binding_unavailable();
	if (code === "timeout") return m.jobs_error_timeout();
	return m.jobs_error_failed();
}

function TaskStatus({ status }: { status: TaskRun["status"] | undefined }) {
	if (!status) return <span className="text-muted-foreground">—</span>;
	return (
		<Badge
			variant={
				status === "failed"
					? "destructive"
					: status === "running"
						? "secondary"
						: "default"
			}
		>
			{status === "failed"
				? m.status_failed()
				: status === "succeeded"
					? m.status_succeeded()
					: m.status_running()}
		</Badge>
	);
}

function taskLabel(task: TaskName | OperationsTask) {
	if (task === "order_expiration") return m.jobs_task_expire_orders();
	if (task === "webhook_outbox") return m.jobs_task_recover_webhooks();
	if (task === "rpc_health") return m.jobs_task_check_rpc();
	if (task === "crypto_rate_sync") return m.jobs_task_sync_crypto_rates();
	if (task === "fiat_rate_sync") return m.jobs_task_sync_fiat_rates();
	if (task === "payment_defaults")
		return m.jobs_task_restore_payment_defaults();
	if (task === "payment_scan_enqueue")
		return m.jobs_task_payment_scan_enqueue();
	if (task === "retention_cleanup") return m.jobs_task_retention_cleanup();
	return m.jobs_task_frequent_cleanup();
}
