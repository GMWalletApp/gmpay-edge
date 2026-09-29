import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { ProTable } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
import { webhookOperationErrorMessage } from "#/features/webhooks/error-message";
import { listInboundWebhookEndpointsFn } from "#/features/webhooks/server/admin";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type Endpoint = Awaited<
	ReturnType<typeof listInboundWebhookEndpointsFn>
>[number];
export function InboundWebhookEndpointsPage() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "name" });
	const query = useQuery({
		queryKey: ["admin", "inbound-webhooks"],
		queryFn: () => listInboundWebhookEndpointsFn(),
	});
	const columns: ColumnDef<Endpoint>[] = [
		{
			accessorKey: "name",
			header: m.webhooks_inbound_endpoint(),
			meta: { search: true },
			cell: ({ row }) => (
				<div>
					<strong className="font-medium">
						{endpointNameLabel(row.original.code)}
					</strong>
					<code className="block text-muted-foreground text-xs">
						{row.original.code}
					</code>
				</div>
			),
		},
		{
			accessorKey: "path",
			header: m.webhooks_path(),
			cell: ({ row }) => <code className="text-xs">{row.original.path}</code>,
		},
		{
			accessorKey: "kind",
			header: m.common_type(),
			cell: ({ row }) => (
				<Badge variant="outline">{inboundKindLabel(row.original.kind)}</Badge>
			),
		},
		{
			accessorKey: "receiptCount",
			header: m.webhooks_receipts(),
		},
		{
			accessorKey: "lastReceivedAt",
			header: m.webhooks_last_received(),
			cell: ({ row }) =>
				row.original.lastReceivedAt
					? formatDateTime(row.original.lastReceivedAt)
					: "—",
		},
	];
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				title={m.webhooks_inbound_title()}
				description={
					query.error
						? webhookOperationErrorMessage(query.error)
						: m.webhooks_inbound_description()
				}
			/>
			<ProTable
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				className="min-h-0 flex-1"
				columns={columns}
				data={query.data ?? []}
				loading={query.isLoading}
				onRefresh={() => query.refetch()}
				toolbarSearch={{
					columnId: "name",
					placeholder: m.webhooks_search_inbound(),
				}}
				table={{ stickyHeader: true }}
			/>
		</div>
	);
}

function endpointNameLabel(code: string) {
	if (code === "okpay.notify") return m.webhooks_endpoint_okpay();
	if (code === "alchemy.address_activity") return m.webhooks_endpoint_alchemy();
	if (code === "telegram.update") return m.webhooks_endpoint_telegram();
	return m.common_unknown();
}

function inboundKindLabel(kind: string) {
	if (kind === "provider") return m.webhooks_kind_provider();
	if (kind === "telegram") return m.system_nav_telegram();
	return m.common_unknown();
}
