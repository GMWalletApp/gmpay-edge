import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, Eye, MoreHorizontal, RotateCcw } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { CopyButton, ProButton } from "#/components/pro/base/button";
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
import { webhookOperationErrorMessage } from "#/features/webhooks/error-message";
import { webhookEventLabel } from "#/features/webhooks/event-label";
import {
	getAdminWebhookDeliveryFn,
	listAdminWebhooksFn,
	retryWebhookDeliveryFn,
} from "#/features/webhooks/server/admin";
import type { WebhookRequestSnapshot } from "#/features/webhooks/types";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { useVisiblePolling } from "#/lib/use-visible-polling";
import { m } from "#/paraglide/messages";

type Delivery = Awaited<
	ReturnType<typeof listAdminWebhooksFn>
>["items"][number];

export function WebhooksSection() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "type" });
	const client = useQueryClient();
	const [refreshKey, setRefreshKey] = useState(0);
	const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(
		null,
	);
	const detailsTriggerRef = useRef<HTMLButtonElement | null>(null);
	const snapshotRef = useRef<{ key: string; at: number } | null>(null);
	const { markFailure, markSuccess } = useVisiblePolling(() => {
		snapshotRef.current = null;
		setRefreshKey((value) => value + 1);
	});
	const request = useCallback(
		async (state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "type")?.value ?? "",
			);
			const key = `${search}:${state.pagination.pageSize}`;
			if (snapshotRef.current?.key !== key)
				snapshotRef.current = { key, at: Date.now() };
			try {
				const result = await listAdminWebhooksFn({
					data: {
						pageIndex: state.pagination.pageIndex,
						pageSize: state.pagination.pageSize,
						search,
						beforeCreatedAt: snapshotRef.current.at,
					},
				});
				markSuccess();
				return { data: result.items, total: result.total };
			} catch (error) {
				markFailure();
				throw error;
			}
		},
		[markFailure, markSuccess],
	);
	const refresh = async () => {
		snapshotRef.current = null;
		await client.invalidateQueries({ queryKey: ["admin", "webhooks"] });
		setRefreshKey((value) => value + 1);
	};
	const retry = useMutation({
		mutationFn: retryWebhookDeliveryFn,
		onSuccess: async () => {
			await refresh();
			toast.success(m.webhooks_retry_queued());
		},
		onError: (error) => toast.error(webhookOperationErrorMessage(error)),
	});
	const columns: ColumnDef<Delivery>[] = [
		{
			accessorKey: "type",
			header: m.webhooks_event(),
			meta: { search: true },
			cell: ({ row }) => (
				<div>
					<strong className="block">
						{webhookEventLabel(row.original.type)}
					</strong>
					<code className="text-muted-foreground text-xs">
						{row.original.eventId}
					</code>
				</div>
			),
		},
		{
			accessorKey: "url",
			header: m.api_notify_url(),
			cell: ({ row }) => (
				<div className="max-w-80">
					<span className="block truncate" title={row.original.url}>
						{row.original.url}
					</span>
					<code className="block truncate text-muted-foreground text-xs">
						{row.original.orderId}
					</code>
				</div>
			),
		},
		{
			accessorKey: "status",
			header: m.common_status(),
			cell: ({ row }) => (
				<div className="space-y-1">
					<DeliveryStatusBadge status={row.original.status} />
					<small className="block text-muted-foreground">
						{m.webhooks_attempts()}: {row.original.attemptCount}
					</small>
					<small className="block text-muted-foreground">
						{m.webhooks_response()}:{" "}
						{row.original.responseStatus ?? row.original.errorCode ?? "—"}
						{row.original.durationMs != null ? (
							<> · {row.original.durationMs} ms</>
						) : null}
					</small>
				</div>
			),
		},
		{
			accessorKey: "createdAt",
			header: m.common_created(),
			cell: ({ row }) => formatDateTime(row.original.createdAt),
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
								onClick={() => setSelectedDeliveryId(row.original.id)}
							>
								<Eye />
								{m.webhooks_view_details()}
							</DropdownMenuItem>
							{row.original.retryable ? (
								<DropdownMenuItem
									disabled={retry.isPending}
									onClick={() =>
										retry.mutate({ data: { id: row.original.id } })
									}
								>
									<RotateCcw />
									{m.webhooks_retry()}
								</DropdownMenuItem>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			),
		},
	];
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				title={m.webhooks_outbound_records_title()}
				description={m.webhooks_deliveries_description()}
			/>
			<ProTable
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				className="min-h-0 flex-1"
				columns={columns}
				request={request}
				requestKey={refreshKey}
				onRefresh={refresh}
				toolbarSearch={{
					columnId: "type",
					placeholder: m.webhooks_search_deliveries(),
				}}
				table={{ stickyHeader: true }}
			/>
			<WebhookDeliveryDetailsDialog
				deliveryId={selectedDeliveryId}
				onClose={() => setSelectedDeliveryId(null)}
				restoreFocusTo={detailsTriggerRef.current}
			/>
		</div>
	);
}

type DeliveryDetails = Awaited<ReturnType<typeof getAdminWebhookDeliveryFn>>;

export function WebhookDeliveryDetailsDialog({
	deliveryId,
	onClose,
	restoreFocusTo,
}: {
	deliveryId: string | null;
	onClose: () => void;
	restoreFocusTo?: HTMLElement | null;
}) {
	const details = useQuery({
		queryKey: ["admin", "webhooks", deliveryId],
		queryFn: () =>
			getAdminWebhookDeliveryFn({ data: { id: deliveryId ?? "" } }),
		enabled: deliveryId !== null,
	});
	return (
		<Dialog
			open={deliveryId !== null}
			onOpenChange={(open) => !open && onClose()}
		>
			<DialogContent
				className="max-h-[90vh] overflow-y-auto sm:max-w-4xl"
				onCloseAutoFocus={(event) => {
					if (!restoreFocusTo) return;
					event.preventDefault();
					restoreFocusTo.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle>{m.webhooks_delivery_details()}</DialogTitle>
					<DialogDescription className="break-all">
						{deliveryId}
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
							{m.webhooks_details_load_failed()}
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
					<WebhookDeliveryDetails details={details.data} />
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function WebhookDeliveryDetails({ details }: { details: DeliveryDetails }) {
	return (
		<div className="space-y-6">
			<section className="space-y-3">
				<h3 className="font-semibold text-sm">
					{m.webhooks_delivery_overview()}
				</h3>
				<dl className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-3">
					<DetailValue label={m.common_status()}>
						<DeliveryStatusBadge status={details.status} />
					</DetailValue>
					<DetailValue
						label={m.webhooks_protocol()}
						value={details.protocol ?? "—"}
					/>
					<DetailValue
						label={m.webhooks_api_key()}
						value={`${details.apiKey.name} (${details.apiKey.pid})`}
					/>
					<DetailValue
						label={m.webhooks_event()}
						value={webhookEventLabel(details.event.type)}
					/>
					<DetailValue
						label={m.webhooks_external_order()}
						value={details.order.externalOrderId}
					/>
					<DetailValue
						label={m.webhooks_attempts()}
						value={String(details.attemptCount)}
					/>
					<DetailValue
						label={m.common_created()}
						value={formatDateTime(details.createdAt)}
					/>
					<DetailValue
						label={m.webhooks_updated_at()}
						value={formatDateTime(details.updatedAt)}
					/>
					<DetailValue
						label={m.webhooks_next_attempt_at()}
						value={formatOptionalDate(details.nextAttemptAt)}
					/>
					<DetailValue
						label={m.webhooks_completed_at()}
						value={formatOptionalDate(details.completedAt)}
					/>
					<DetailValue
						className="sm:col-span-2 lg:col-span-3"
						label={m.api_notify_url()}
						value={details.url}
					/>
					<DetailValue label={m.webhooks_delivery_id()} value={details.id} />
					<DetailValue label={m.webhooks_event_id()} value={details.event.id} />
					<DetailValue label={m.checkout_order_id()} value={details.order.id} />
				</dl>
			</section>
			<CodeBlock
				label={m.webhooks_event_payload()}
				value={details.event.payload}
			/>
			<section className="space-y-3">
				<h3 className="font-semibold text-sm">
					{m.webhooks_attempt_history()}
				</h3>
				{details.attempts.length ? (
					<div className="space-y-3">
						{details.attempts.map((attempt) => (
							<AttemptDetails key={attempt.attempt} attempt={attempt} />
						))}
					</div>
				) : (
					<p className="rounded-lg border p-4 text-muted-foreground text-sm">
						{m.webhooks_no_attempts()}
					</p>
				)}
			</section>
		</div>
	);
}

function AttemptDetails({
	attempt,
}: {
	attempt: DeliveryDetails["attempts"][number];
}) {
	return (
		<article className="space-y-4 rounded-lg border p-4">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div>
					<h4 className="font-medium text-sm">
						{m.webhooks_attempt_number({ attempt: attempt.attempt })}
					</h4>
					<p className="text-muted-foreground text-xs">
						{m.webhooks_attempted_at()}: {formatDateTime(attempt.attemptedAt)}
					</p>
				</div>
				<Badge variant={attempt.errorCode ? "destructive" : "outline"}>
					{attempt.responseStatus ?? attempt.errorCode ?? "—"}
				</Badge>
			</div>
			<dl className="grid gap-3 sm:grid-cols-3">
				<DetailValue
					label={m.webhooks_request_id()}
					value={attempt.requestId}
				/>
				<DetailValue
					label={m.common_duration()}
					value={attempt.durationMs == null ? "—" : `${attempt.durationMs} ms`}
				/>
				<DetailValue
					label={m.webhooks_error_code()}
					value={attempt.errorCode ?? "—"}
				/>
			</dl>
			<RequestSnapshot snapshot={attempt.requestSnapshot} />
			{attempt.responseExcerpt ? (
				<CodeBlock
					label={m.webhooks_response_excerpt()}
					value={attempt.responseExcerpt}
				/>
			) : null}
		</article>
	);
}

function RequestSnapshot({
	snapshot,
}: {
	snapshot: WebhookRequestSnapshot | null;
}) {
	if (!snapshot)
		return (
			<div className="rounded-md bg-muted p-3 text-muted-foreground text-sm">
				{m.webhooks_request_snapshot_unavailable()}
			</div>
		);
	return (
		<div className="space-y-3">
			<div>
				<h5 className="font-medium text-sm">{m.webhooks_request_snapshot()}</h5>
				<code className="block break-all text-muted-foreground text-xs">
					{snapshot.method} {snapshot.url}
				</code>
			</div>
			<CodeBlock
				label={m.webhooks_request_headers()}
				value={snapshot.headers}
			/>
			<CodeBlock
				label={
					snapshot.method === "GET"
						? m.webhooks_request_query()
						: m.webhooks_request_body()
				}
				value={snapshot.method === "GET" ? snapshot.query : snapshot.body}
			/>
		</div>
	);
}

function CodeBlock({ label, value }: { label: string; value: unknown }) {
	const text =
		typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return (
		<div className="overflow-hidden rounded-md border">
			<div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-3 py-2">
				<span className="font-medium text-xs">{label}</span>
				<CopyButton
					copy={text ?? ""}
					icon={<Copy />}
					size="icon-xs"
					tooltip={m.common_copy()}
					variant="ghost"
				/>
			</div>
			<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-xs">
				{text ?? "—"}
			</pre>
		</div>
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

function DeliveryStatusBadge({ status }: { status: string }) {
	return (
		<Badge
			variant={
				status === "succeeded"
					? "default"
					: ["failed", "dead"].includes(status)
						? "destructive"
						: "secondary"
			}
		>
			{statusLabel(status)}
		</Badge>
	);
}

function formatOptionalDate(value: string | null) {
	return value ? formatDateTime(value) : "—";
}

function statusLabel(status: string) {
	if (status === "succeeded") return m.status_succeeded();
	if (status === "failed") return m.status_failed();
	if (status === "dead") return m.status_stopped();
	if (status === "queued") return m.webhooks_status_pending();
	if (status === "delivering") return m.status_retrying();
	return m.common_unknown();
}
