import { useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { StatusBadge } from "#/components/status-badge";
import { Badge } from "#/components/ui/badge";
import {
	hasSystemPermission,
	systemPermission,
} from "#/features/access/system-rbac";
import { webhookOperationErrorMessage } from "#/features/webhooks/error-message";
import {
	listPaymentProviderEventsFn,
	retryPaymentProviderEventFn,
} from "#/features/webhooks/server/payment-event-sources";
import { useNavigation } from "#/layouts/components/navigation-context";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { m } from "#/paraglide/messages";

type PaymentProviderEvent = Awaited<
	ReturnType<typeof listPaymentProviderEventsFn>
>["items"][number];

const networkOptions = [
	{ label: "Ethereum", value: "ethereum" },
	{ label: "Base", value: "base" },
	{ label: "BNB Smart Chain", value: "bsc" },
	{ label: "Polygon", value: "polygon" },
];

export function PaymentProviderEventsPage({ sourceId }: { sourceId?: string }) {
	const { permissions } = useNavigation();
	const canUpdate = hasSystemPermission(
		permissions,
		systemPermission("webhooks", "update"),
	);
	const [refreshKey, setRefreshKey] = useState(0);
	const retry = useMutation({
		mutationFn: retryPaymentProviderEventFn,
		onSuccess: () => {
			setRefreshKey((value) => value + 1);
			toast.success(m.webhooks_retry_queued());
		},
		onError: (error) => toast.error(webhookOperationErrorMessage(error)),
	});
	const request = useCallback(
		async (state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "transactionHash")
					?.value ?? "",
			);
			const result = await listPaymentProviderEventsFn({
				data: {
					pageIndex: state.pagination.pageIndex,
					pageSize: state.pagination.pageSize,
					search,
					sourceId,
				},
			});
			return { data: result.items, total: result.total };
		},
		[sourceId],
	);
	const columns: ColumnDef<PaymentProviderEvent>[] = [
		{
			accessorKey: "network",
			header: m.infrastructure_source(),
			cell: ({ row }) => (
				<div>
					<strong className="block">
						{networkLabel(row.original.network)}
					</strong>
					<code className="text-muted-foreground text-xs">
						{row.original.providerEventId}
					</code>
				</div>
			),
		},
		{
			accessorKey: "transactionHash",
			header: m.payments_transaction(),
			meta: { search: true },
			cell: ({ row }) => (
				<div>
					<code
						className="block max-w-64 truncate text-xs"
						title={row.original.transactionHash}
					>
						{row.original.transactionHash}
					</code>
					<span className="text-muted-foreground text-xs">
						#{row.original.eventIndex}
					</span>
				</div>
			),
		},
		{
			accessorKey: "status",
			header: m.common_status(),
			cell: ({ row }) => <StatusBadge value={row.original.status} />,
		},
		{
			accessorKey: "ingestMode",
			header: m.webhooks_event_mode(),
			cell: ({ row }) => (
				<Badge variant="outline">
					{row.original.ingestMode === "active"
						? m.webhooks_mode_active()
						: m.webhooks_mode_shadow()}
				</Badge>
			),
		},
		{
			accessorKey: "attemptCount",
			header: m.webhooks_attempts(),
			cell: ({ row }) => (
				<div>
					<span>{row.original.attemptCount}</span>
					{row.original.lastErrorCode ? (
						<code className="block max-w-48 truncate text-destructive text-xs">
							{row.original.lastErrorCode}
						</code>
					) : null}
				</div>
			),
		},
		{
			accessorKey: "receivedAt",
			header: m.webhooks_received_at(),
			cell: ({ row }) => formatDateTime(row.original.receivedAt),
		},
		{
			id: "actions",
			header: canUpdate ? m.common_actions() : "",
			cell: ({ row }) =>
				canUpdate && row.original.retryable ? (
					<ProButton
						size="sm"
						variant="outline"
						loading={
							retry.isPending && retry.variables?.data.id === row.original.id
						}
						disabled={retry.isPending}
						onClick={() => retry.mutate({ data: { id: row.original.id } })}
					>
						<RefreshCw />
						{m.webhooks_retry()}
					</ProButton>
				) : null,
		},
	];
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				title={m.webhooks_provider_events_title()}
				description={m.webhooks_provider_events_description()}
			/>
			<ProTable
				className="min-h-0 flex-1"
				columns={columns}
				request={request}
				requestKey={refreshKey}
				onRefresh={() => setRefreshKey((value) => value + 1)}
				toolbarSearch={{
					columnId: "transactionHash",
					placeholder: m.payments_search(),
				}}
				table={{ stickyHeader: true }}
			/>
		</div>
	);
}

function networkLabel(network: string) {
	return (
		networkOptions.find((option) => option.value === network)?.label ?? network
	);
}
