import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, RotateCcw } from "lucide-react";
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
	getQueueOverviewFn,
	retryQueueFn,
} from "#/features/operations/server/admin";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type Row = Awaited<ReturnType<typeof getQueueOverviewFn>>[number];
export function QueuesPage() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "name" });
	const client = useQueryClient();
	const query = useQuery({
		queryKey: ["admin", "operations", "queues"],
		queryFn: () => getQueueOverviewFn(),
		refetchInterval: 30_000,
	});
	const retry = useMutation({
		mutationFn: retryQueueFn,
		onSuccess: async (result) => {
			await client.invalidateQueries({
				queryKey: ["admin", "operations", "queues"],
			});
			toast.success(m.queue_retry_queued({ count: result.queued }));
		},
		onError: (error) =>
			toast.error(operationsErrorMessage(error, m.common_operation_failed)),
	});
	const columns: ColumnDef<Row>[] = [
		{ accessorKey: "name", header: m.queue_name(), meta: { search: true } },
		{
			accessorKey: "available",
			header: m.common_status(),
			cell: ({ row }) => (
				<Badge variant={row.original.available ? "default" : "destructive"}>
					{row.original.available ? m.queue_available() : m.queue_unavailable()}
				</Badge>
			),
		},
		{ accessorKey: "pending", header: m.queue_pending() },
		{ accessorKey: "processing", header: m.queue_processing() },
		{ accessorKey: "failed", header: m.status_failed() },
		{
			accessorKey: "dead",
			header: m.queue_dead(),
			cell: ({ row }) => row.original.dead ?? "—",
		},
		{
			accessorKey: "lastConsumedAt",
			header: m.queue_last_consumed(),
			cell: ({ row }) =>
				row.original.lastConsumedAt
					? formatDateTime(row.original.lastConsumedAt)
					: "—",
		},
		{
			accessorKey: "lastError",
			header: m.common_last_error(),
			cell: ({ row }) => (
				<span
					className="block max-w-64 truncate"
					title={row.original.lastError ?? undefined}
				>
					{row.original.lastError ?? "—"}
				</span>
			),
		},
		{
			id: "actions",
			header: m.common_actions(),
			cell: ({ row }) => (
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
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								disabled={retry.isPending || !row.original.available}
								onClick={() =>
									retry.mutate({ data: { queue: row.original.id } })
								}
							>
								<RotateCcw />
								{m.queue_retry()}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			),
		},
	];
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				title={m.nav_queue_monitoring()}
				description={m.queue_description()}
			/>
			<ProTable
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				className="min-h-0 flex-1"
				columns={columns}
				data={query.data ?? []}
				loading={query.isLoading}
				onRefresh={() => query.refetch()}
				pagination={false}
				toolbarSearch={{ columnId: "name", placeholder: m.common_search() }}
				table={{ stickyHeader: true }}
			/>
		</div>
	);
}
