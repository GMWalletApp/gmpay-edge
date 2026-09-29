import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Check, Eye, MoreHorizontal, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { AssetLabel } from "#/components/crypto-icons/labels";
import { ProButton } from "#/components/pro/base/button";
import { Input, Textarea } from "#/components/pro/base/fields/input";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { StatusBadge } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { paymentReviewErrorMessage } from "#/features/payment-reviews/error-message";
import {
	listPaymentReviewsFn,
	resolvePaymentReviewFn,
} from "#/features/payment-reviews/server/admin";
import { Main } from "#/layouts/components/main";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { useVisiblePolling } from "#/lib/use-visible-polling";
import { m } from "#/paraglide/messages";

type Review = Awaited<ReturnType<typeof listPaymentReviewsFn>>["items"][number];

export function PaymentReviewsPage() {
	const tableUrlState = useCurrentProTableUrlState({
		searchColumnId: "externalOrderId",
	});
	const client = useQueryClient();
	const [refreshKey, setRefreshKey] = useState(0);
	const snapshotRef = useRef<{ key: string; at: number } | null>(null);
	const [selected, setSelected] = useState<Review | null>(null);
	const [transactionHash, setTransactionHash] = useState("");
	const [note, setNote] = useState("");
	const { markFailure, markSuccess } = useVisiblePolling(() => {
		snapshotRef.current = null;
		setRefreshKey((value) => value + 1);
	});
	const request = useCallback(
		async (state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "externalOrderId")
					?.value ?? "",
			);
			const key = `${search}:${state.pagination.pageSize}`;
			if (snapshotRef.current?.key !== key)
				snapshotRef.current = { key, at: Date.now() };
			try {
				const result = await listPaymentReviewsFn({
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
		await client.invalidateQueries({ queryKey: ["admin", "payment-reviews"] });
		setRefreshKey((value) => value + 1);
	};
	const resolve = useMutation({
		mutationFn: resolvePaymentReviewFn,
		onSuccess: async () => {
			setSelected(null);
			await refresh();
			toast.success(m.payment_reviews_resolved());
		},
		onError: (error) => toast.error(paymentReviewErrorMessage(error)),
	});
	const open = (review: Review) => {
		setSelected(review);
		setTransactionHash(review.transactionHash ?? "");
		setNote("");
	};
	const columns: ColumnDef<Review>[] = [
		{
			accessorKey: "externalOrderId",
			header: m.orders_order(),
			meta: { search: true },
			cell: ({ row }) => (
				<div>
					<code className="block text-xs">{row.original.orderId}</code>
					<span className="text-muted-foreground text-xs">
						{row.original.externalOrderId}
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
			id: "amount",
			header: m.payments_amount(),
			cell: ({ row }) => (
				<AssetLabel
					label={`${row.original.paymentAmount} ${row.original.assetCode}`}
					network={row.original.network}
					symbol={row.original.assetCode}
				/>
			),
		},
		{
			accessorKey: "description",
			header: m.payment_reviews_details(),
			cell: ({ row }) => (
				<p className="max-w-72 truncate" title={row.original.description}>
					{row.original.description}
				</p>
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
							>
								<MoreHorizontal />
							</ProButton>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => open(row.original)}>
								<Eye /> {m.payment_reviews_view()}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			),
		},
	];
	const decide = (decision: "approve" | "reject") => {
		if (!selected || note.trim().length < 3) return;
		resolve.mutate({
			data: {
				reviewId: selected.id,
				decision,
				transactionHash: transactionHash.trim() || undefined,
				note: note.trim(),
			},
		});
	};
	return (
		<Main fixed className="gap-4">
			<PageHeader
				title={m.payment_reviews_title()}
				description={m.payment_reviews_description()}
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
					columnId: "externalOrderId",
					placeholder: m.payment_reviews_search(),
				}}
				table={{ stickyHeader: true }}
			/>
			<Dialog
				onOpenChange={(open) => !open && setSelected(null)}
				open={Boolean(selected)}
			>
				<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>{m.payment_reviews_review_title()}</DialogTitle>
						<DialogDescription>{selected?.description}</DialogDescription>
					</DialogHeader>
					{selected ? (
						<div className="space-y-4">
							<img
								alt={m.payment_reviews_evidence_alt()}
								className="max-h-80 w-full rounded-lg border object-contain"
								src={`/api/admin/payment-reviews/${selected.id}/evidence`}
							/>
							<div className="space-y-2">
								<label
									className="font-medium text-sm"
									htmlFor="review-transaction-hash"
								>
									{m.checkout_tx_hash_label()}
								</label>
								<Input
									disabled={selected.status !== "pending"}
									id="review-transaction-hash"
									onChange={(event) => setTransactionHash(event.target.value)}
									value={transactionHash}
								/>
							</div>
							<div className="space-y-2">
								<label
									className="font-medium text-sm"
									htmlFor="review-resolution-note"
								>
									{m.payment_reviews_resolution_note()}
								</label>
								<Textarea
									className="min-h-20"
									disabled={selected.status !== "pending"}
									id="review-resolution-note"
									maxLength={1000}
									onChange={(event) => setNote(event.target.value)}
									value={
										selected.status === "pending"
											? note
											: (selected.resolutionNote ?? "")
									}
								/>
							</div>
						</div>
					) : null}
					{selected?.status === "pending" ? (
						<DialogFooter>
							<Button
								disabled={resolve.isPending || note.trim().length < 3}
								onClick={() => decide("reject")}
								variant="destructive"
							>
								<X /> {m.payments_reject()}
							</Button>
							<Button
								disabled={
									resolve.isPending ||
									note.trim().length < 3 ||
									transactionHash.trim().length < 8
								}
								onClick={() => decide("approve")}
							>
								<Check /> {m.payments_accept()}
							</Button>
						</DialogFooter>
					) : null}
				</DialogContent>
			</Dialog>
		</Main>
	);
}
