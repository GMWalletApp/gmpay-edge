import type { ColumnDef } from "@tanstack/react-table";
import { Download } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { operationsErrorMessage } from "#/features/operations/error-message";
import {
	type AuditLogRecord,
	exportAuditLogsFn,
	listAuditLogsFn,
} from "#/features/operations/server/admin";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

export function AuditLogsPage() {
	const tableUrlState = useCurrentProTableUrlState({
		searchColumnId: "action",
	});
	const [refreshKey, setRefreshKey] = useState(0);
	const snapshotRef = useRef<{ key: string; at: number } | null>(null);
	const [exporting, setExporting] = useState(false);
	const exportLogs = async () => {
		setExporting(true);
		try {
			const result = await exportAuditLogsFn();
			toast.success(
				m.audit_export_succeeded({
					count: result.recordCount,
					key: result.key,
				}),
			);
		} catch (error) {
			toast.error(operationsErrorMessage(error, m.audit_export_failed));
		} finally {
			setExporting(false);
		}
	};
	const request = useCallback(async (state: ProTableState) => {
		const search = String(
			state.columnFilters.find((filter) => filter.id === "action")?.value ?? "",
		);
		const key = `${search}:${state.pagination.pageSize}`;
		if (snapshotRef.current?.key !== key)
			snapshotRef.current = { key, at: Date.now() };
		const result = await listAuditLogsFn({
			data: {
				page: state.pagination.pageIndex + 1,
				pageSize: state.pagination.pageSize,
				search,
				beforeCreatedAt: snapshotRef.current.at,
			},
		});
		return { data: result.items, total: result.total };
	}, []);
	const columns: ColumnDef<AuditLogRecord>[] = [
		{
			accessorKey: "createdAt",
			header: m.audit_time(),
			cell: ({ row }) => formatDateTime(row.original.createdAt),
		},
		{
			id: "actor",
			header: m.audit_actor(),
			cell: ({ row }) => (
				<div>
					<strong className="block">
						{row.original.actorName ?? m.audit_system()}
					</strong>
					<span className="text-muted-foreground text-xs">
						{row.original.actorEmail ?? m.audit_automated_task()}
					</span>
				</div>
			),
		},
		{
			accessorKey: "action",
			header: m.audit_action(),
			cell: ({ row }) => (
				<Badge variant="secondary">{row.original.action}</Badge>
			),
		},
		{
			id: "target",
			header: m.audit_target(),
			cell: ({ row }) => (
				<div>
					<span className="block">{row.original.targetType}</span>
					<code className="text-muted-foreground text-xs">
						{row.original.targetId ?? "—"}
					</code>
				</div>
			),
		},
		{
			id: "context",
			header: m.audit_context(),
			cell: ({ row }) => (
				<div className="text-muted-foreground text-xs">
					<span className="block">{row.original.ipAddress ?? "—"}</span>
					{row.original.requestId ? (
						<code>{row.original.requestId}</code>
					) : null}
				</div>
			),
		},
	];
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				title={m.nav_audit_logs()}
				description={m.audit_description()}
				actions={
					<Button variant="outline" disabled={exporting} onClick={exportLogs}>
						<Download />
						{exporting ? m.audit_exporting() : m.audit_export()}
					</Button>
				}
			/>
			<ProTable
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				onRefresh={() => {
					snapshotRef.current = null;
					setRefreshKey((value) => value + 1);
				}}
				columns={columns}
				request={request}
				requestKey={refreshKey}
				toolbarSearch={{
					columnId: "action",
					placeholder: m.audit_search(),
				}}
				table={{ stickyHeader: true }}
				className="min-h-0 flex-1"
			/>
		</div>
	);
}
