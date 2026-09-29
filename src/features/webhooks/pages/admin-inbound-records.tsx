import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, MoreHorizontal, RotateCcw } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { ProButton } from "#/components/pro/base/button";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	getInboundWebhookReceiptFn,
	listInboundWebhookReceiptsFn,
} from "#/features/webhooks/server/admin";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type InboundNotificationRecord = Awaited<
	ReturnType<typeof listInboundWebhookReceiptsFn>
>["items"][number];

export function InboundNotificationRecordsPage() {
	const tableUrlState = useCurrentProTableUrlState({
		searchColumnId: "requestId",
	});
	const [refreshKey, setRefreshKey] = useState(0);
	const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(
		null,
	);
	const detailsTriggerRef = useRef<HTMLButtonElement | null>(null);
	const request = useCallback(async (state: ProTableState) => {
		const search = String(
			state.columnFilters.find((filter) => filter.id === "requestId")?.value ??
				"",
		);
		const result = await listInboundWebhookReceiptsFn({
			data: {
				pageIndex: state.pagination.pageIndex,
				pageSize: state.pagination.pageSize,
				search,
			},
		});
		return { data: result.items, total: result.total };
	}, []);
	const columns: ColumnDef<InboundNotificationRecord>[] = [
		{
			accessorKey: "endpointCode",
			header: m.webhooks_inbound_endpoint(),
			cell: ({ row }) => (
				<div>
					<strong className="block">
						{endpointNameLabel(row.original.endpointCode)}
					</strong>
					<code className="text-muted-foreground text-xs">
						{row.original.requestPath}
					</code>
				</div>
			),
		},
		{
			accessorKey: "requestId",
			header: m.webhooks_request_id(),
			meta: { search: true },
			cell: ({ row }) => (
				<code className="block max-w-56 truncate text-xs">
					{row.original.requestId}
				</code>
			),
		},
		{
			accessorKey: "processingStatus",
			header: m.common_status(),
			cell: ({ row }) => (
				<div className="space-y-1">
					<Badge
						variant={
							row.original.processingStatus === "failed"
								? "destructive"
								: "secondary"
						}
					>
						{processingStatusLabel(row.original.processingStatus)}
					</Badge>
					<small className="block text-muted-foreground">
						{m.webhooks_signature()}:{" "}
						{signatureStatusLabel(row.original.signatureStatus)}
					</small>
				</div>
			),
		},
		{
			accessorKey: "responseStatus",
			header: m.webhooks_response(),
			cell: ({ row }) => (
				<div>
					<span>{row.original.responseStatus}</span>
					<small className="block text-muted-foreground">
						{row.original.durationMs} ms
						{row.original.errorCode ? ` · ${row.original.errorCode}` : ""}
					</small>
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
			header: m.common_actions(),
			cell: ({ row }) => (
				<div className="flex justify-end">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<ProButton
								size="icon-sm"
								variant="ghost"
								tooltip={m.common_actions()}
								onFocus={(event) => {
									detailsTriggerRef.current = event.currentTarget;
								}}
								onClick={(event) => {
									detailsTriggerRef.current = event.currentTarget;
								}}
							>
								<MoreHorizontal />
							</ProButton>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								onClick={() => setSelectedReceiptId(row.original.id)}
							>
								<Eye />
								{m.webhooks_view_details()}
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
				title={m.webhooks_inbound_records_title()}
				description={m.webhooks_inbound_records_description()}
			/>
			<ProTable
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				className="min-h-0 flex-1"
				columns={columns}
				request={request}
				requestKey={refreshKey}
				onRefresh={() => setRefreshKey((value) => value + 1)}
				toolbarSearch={{
					columnId: "requestId",
					placeholder: m.webhooks_search_receipts(),
				}}
				table={{ stickyHeader: true }}
			/>
			<InboundWebhookReceiptDetailsDialog
				receiptId={selectedReceiptId}
				onClose={() => setSelectedReceiptId(null)}
				restoreFocusTo={detailsTriggerRef.current}
			/>
		</div>
	);
}

type ReceiptDetails = Awaited<ReturnType<typeof getInboundWebhookReceiptFn>>;

export function InboundWebhookReceiptDetailsDialog({
	receiptId,
	onClose,
	restoreFocusTo,
}: {
	receiptId: string | null;
	onClose: () => void;
	restoreFocusTo?: HTMLElement | null;
}) {
	const details = useQuery({
		queryKey: ["admin", "inbound-webhook-receipts", receiptId],
		queryFn: () =>
			getInboundWebhookReceiptFn({ data: { id: receiptId ?? "" } }),
		enabled: receiptId !== null,
	});
	return (
		<Dialog
			open={receiptId !== null}
			onOpenChange={(open) => !open && onClose()}
		>
			<DialogContent
				className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
				onCloseAutoFocus={(event) => {
					if (!restoreFocusTo) return;
					event.preventDefault();
					restoreFocusTo.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle>{m.webhooks_inbound_record_details()}</DialogTitle>
					<DialogDescription className="break-all">
						{receiptId}
					</DialogDescription>
				</DialogHeader>
				{details.isLoading ? (
					<p className="py-8 text-center text-muted-foreground">
						{m.common_loading()}
					</p>
				) : null}
				{details.isError ? (
					<div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 p-6 text-center">
						<p className="text-destructive">
							{m.webhooks_inbound_record_details_load_failed()}
						</p>
						<ProButton
							variant="outline"
							loading={details.isFetching}
							onClick={() => details.refetch()}
						>
							<RotateCcw />
							{m.webhooks_retry_load()}
						</ProButton>
					</div>
				) : null}
				{details.data ? (
					<InboundWebhookReceiptDetails details={details.data} />
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function InboundWebhookReceiptDetails({
	details,
}: {
	details: ReceiptDetails;
}) {
	return (
		<section className="space-y-3">
			<h3 className="font-semibold text-sm">
				{m.webhooks_inbound_record_overview()}
			</h3>
			<dl className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-3">
				<DetailValue label={m.webhooks_inbound_endpoint()}>
					<div>
						<strong className="block font-medium">
							{endpointNameLabel(details.endpointCode)}
						</strong>
						<code className="text-muted-foreground text-xs">
							{details.endpointCode}
						</code>
					</div>
				</DetailValue>
				<DetailValue
					label={m.common_status()}
					value={processingStatusLabel(details.processingStatus)}
				/>
				<DetailValue
					label={m.webhooks_signature()}
					value={signatureStatusLabel(details.signatureStatus)}
				/>
				<DetailValue
					label={m.webhooks_request_id()}
					value={details.requestId}
				/>
				<DetailValue label={m.webhooks_method()} value={details.method} />
				<DetailValue
					label={m.webhooks_response()}
					value={String(details.responseStatus)}
				/>
				<DetailValue
					label={m.common_duration()}
					value={`${details.durationMs} ms`}
				/>
				<DetailValue
					label={m.webhooks_error_code()}
					value={details.errorCode ?? "—"}
				/>
				<DetailValue
					label={m.webhooks_received_at()}
					value={formatDateTime(details.receivedAt)}
				/>
				<DetailValue
					className="sm:col-span-2 lg:col-span-3"
					label={m.webhooks_path()}
					value={details.requestPath}
				/>
			</dl>
		</section>
	);
}

function DetailValue({
	label,
	value,
	children,
	className,
}: {
	label: string;
	value?: string;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div className={className}>
			<dt className="text-muted-foreground text-xs">{label}</dt>
			<dd className="mt-1 break-all font-mono text-xs">
				{children ?? value ?? "—"}
			</dd>
		</div>
	);
}

function endpointNameLabel(code: string) {
	if (code === "okpay.notify") return m.webhooks_endpoint_okpay();
	if (code === "alchemy.address_activity") return m.webhooks_endpoint_alchemy();
	if (code === "telegram.update") return m.webhooks_endpoint_telegram();
	return m.common_unknown();
}

function signatureStatusLabel(status: string) {
	if (status === "valid") return m.webhooks_signature_valid();
	if (status === "invalid") return m.webhooks_signature_invalid();
	if (status === "not_applicable") return m.webhooks_signature_not_applicable();
	return m.common_unknown();
}

function processingStatusLabel(status: string) {
	if (status === "succeeded") return m.status_succeeded();
	if (status === "rejected") return m.webhooks_processing_rejected();
	if (status === "failed") return m.status_failed();
	return m.common_unknown();
}
