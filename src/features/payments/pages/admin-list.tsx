import { useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Check, MoreHorizontal, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { AssetLabel } from "#/components/crypto-icons/labels";
import { ProButton } from "#/components/pro/base/button";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { StatusBadge } from "#/components/status-badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { paymentOperationErrorMessage } from "#/features/payments/error-message";
import {
	listAdminPaymentsFn,
	resolveLatePaymentFn,
} from "#/features/payments/server/admin";
import { Main } from "#/layouts/components/main";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime, formatDecimalAmount } from "#/lib/format";
import { unitsToDecimal } from "#/lib/money";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { useVisiblePolling } from "#/lib/use-visible-polling";
import { m } from "#/paraglide/messages";

type PaymentRecord = Awaited<
	ReturnType<typeof listAdminPaymentsFn>
>["items"][number];

export function PaymentsPage() {
	const tableUrlState = useCurrentProTableUrlState({
		searchColumnId: "transactionId",
	});
	const [refreshKey, setRefreshKey] = useState(0);
	const snapshotRef = useRef<{
		key: string;
		at: number;
		cursors: Map<number, { detectedAt: number; id: string }>;
	} | null>(null);
	const { markFailure, markSuccess } = useVisiblePolling(() => {
		snapshotRef.current = null;
		setRefreshKey((value) => value + 1);
	});
	const request = useCallback(
		async (state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "transactionId")
					?.value ?? "",
			);
			const key = `${search}:${state.pagination.pageSize}`;
			if (snapshotRef.current?.key !== key)
				snapshotRef.current = { key, at: Date.now(), cursors: new Map() };
			const snapshot = snapshotRef.current;
			try {
				const result = await listAdminPaymentsFn({
					data: {
						pageIndex: state.pagination.pageIndex,
						pageSize: state.pagination.pageSize,
						search,
						beforeDetectedAt: snapshot.at,
						cursor: snapshot.cursors.get(state.pagination.pageIndex),
					},
				});
				if (result.nextCursor)
					snapshot.cursors.set(
						state.pagination.pageIndex + 1,
						result.nextCursor,
					);
				markSuccess();
				return { data: result.items, total: result.total };
			} catch (error) {
				markFailure();
				throw error;
			}
		},
		[markFailure, markSuccess],
	);
	const refresh = () => {
		snapshotRef.current = null;
		setRefreshKey((value) => value + 1);
	};
	const resolve = useMutation({
		mutationFn: resolveLatePaymentFn,
		onSuccess: () => {
			refresh();
			toast.success(m.payments_decision_saved());
		},
		onError: (error) => toast.error(paymentOperationErrorMessage(error)),
	});
	const columns: ColumnDef<PaymentRecord>[] = [
		{
			accessorKey: "transactionId",
			header: m.payments_transaction(),
			meta: { search: true },
			cell: ({ row }) => (
				<div className="max-w-64">
					<code
						className="block truncate text-xs"
						title={row.original.transactionId}
					>
						{row.original.transactionId}
					</code>
					<small className="text-muted-foreground uppercase">
						{row.original.network}
					</small>
				</div>
			),
		},
		{
			accessorKey: "externalOrderId",
			header: m.orders_order(),
			cell: ({ row }) => (
				<div>
					<code className="block text-xs">{row.original.orderId}</code>
					<small className="text-muted-foreground">
						{row.original.externalOrderId}
					</small>
				</div>
			),
		},
		{
			id: "amount",
			header: m.payments_amount(),
			cell: ({ row }) => (
				<AssetLabel
					label={`${formatDecimalAmount(unitsToDecimal(BigInt(row.original.amountUnits), row.original.decimals), row.original.decimals)} ${row.original.assetCode}`}
					network={row.original.network}
					symbol={row.original.assetCode}
				/>
			),
		},
		{
			accessorKey: "status",
			header: m.common_status(),
			cell: ({ row }) => <StatusBadge value={row.original.status} />,
		},
		{
			accessorKey: "confirmations",
			header: m.payment_config_confirmations(),
		},
		{
			accessorKey: "detectedAt",
			header: m.payments_detected(),
			cell: ({ row }) => formatDateTime(row.original.detectedAt),
		},
		{
			id: "actions",
			header: m.common_actions(),
			cell: ({ row }) =>
				row.original.status === "pending_review" ? (
					<div className="flex justify-end">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<ProButton
									size="icon-sm"
									variant="ghost"
									tooltip={m.payments_review()}
								>
									<MoreHorizontal />
								</ProButton>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									disabled={resolve.isPending}
									onClick={() =>
										resolve.mutate({
											data: {
												paymentId: row.original.id,
												decision: "accept",
											},
										})
									}
								>
									<Check /> {m.payments_accept()}
								</DropdownMenuItem>
								<DropdownMenuItem
									variant="destructive"
									disabled={resolve.isPending}
									onClick={() =>
										resolve.mutate({
											data: {
												paymentId: row.original.id,
												decision: "reject",
											},
										})
									}
								>
									<X /> {m.payments_reject()}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				) : null,
		},
	];
	return (
		<Main fixed className="gap-4">
			<PageHeader
				title={m.system_nav_payments()}
				description={m.payments_description()}
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
					columnId: "transactionId",
					placeholder: m.payments_search(),
				}}
				table={{ stickyHeader: true }}
			/>
		</Main>
	);
}
