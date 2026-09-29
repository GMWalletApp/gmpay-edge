import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, RotateCcw, Send, Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ModalForm } from "#/components/pro/form";
import { ProTable, type ProTableState } from "#/components/pro/table";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Switch } from "#/components/ui/switch";
import {
	createTelegramCommandFn,
	deleteTelegramCommandFn,
	listTelegramCommandsFn,
	reconcileTelegramDefaultsFn,
	setTelegramCommandEnabledFn,
	syncTelegramCommandsFn,
	type TelegramCommandRecord,
	updateTelegramCommandFn,
} from "#/features/telegram/server/commands-admin";
import { PageHeader } from "#/layouts/components/page-header";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";
import {
	commandDescriptions,
	commandFormSchema,
	emptyTemplateTranslations,
	showTelegramError,
	telegramCommandValues,
	telegramOptionLabel,
} from "./form-fields";

type CommandConfiguration = {
	botCount: number;
};

export function TelegramCommandsPage() {
	const tableUrlState = useCurrentProTableUrlState({
		searchColumnId: "command",
	});
	const client = useQueryClient();
	const [refreshKey, setRefreshKey] = useState(0);
	const [configuration, setConfiguration] = useState<CommandConfiguration>({
		botCount: 0,
	});
	const [editing, setEditing] = useState<TelegramCommandRecord | null>(null);
	const snapshotRef = useRef<{ key: string; at: number } | null>(null);
	const refresh = async () => {
		snapshotRef.current = null;
		await client.invalidateQueries({
			queryKey: ["admin", "telegram", "commands"],
		});
		setRefreshKey((value) => value + 1);
	};
	const request = useCallback(
		async (state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "command")?.value ??
					"",
			);
			const key = `${search}:${state.pagination.pageSize}`;
			if (snapshotRef.current?.key !== key) {
				snapshotRef.current = { key, at: Date.now() };
			}
			const input = {
				pageIndex: state.pagination.pageIndex,
				pageSize: state.pagination.pageSize,
				search,
				beforeCreatedAt: snapshotRef.current.at,
			};
			const result = await client.fetchQuery({
				queryKey: ["admin", "telegram", "commands", input],
				queryFn: () => listTelegramCommandsFn({ data: input }),
			});
			setConfiguration({
				botCount: result.botCount,
			});
			return { data: result.data, total: result.total };
		},
		[client],
	);
	const toggle = useMutation({
		mutationFn: setTelegramCommandEnabledFn,
		onSuccess: refresh,
		onError: showTelegramError,
	});
	const remove = useMutation({
		mutationFn: deleteTelegramCommandFn,
		onSuccess: refresh,
		onError: showTelegramError,
	});
	const update = useMutation({
		mutationFn: updateTelegramCommandFn,
		onSuccess: async (result) => {
			setEditing(null);
			await refresh();
			showSynchronizationResult(result);
			toast.success(m.telegram_command_updated());
		},
		onError: showTelegramError,
	});
	const sync = useMutation({
		mutationFn: syncTelegramCommandsFn,
		onSuccess: showSynchronizationResult,
		onError: showTelegramError,
	});
	const reconcile = useMutation({
		mutationFn: reconcileTelegramDefaultsFn,
		onSuccess: async (result) => {
			await refresh();
			toast.success(m.telegram_defaults_reconciled({ count: result.added }));
		},
		onError: showTelegramError,
	});
	const columns: ColumnDef<TelegramCommandRecord>[] = [
		{
			accessorKey: "enabled",
			header: m.common_enabled(),
			cell: ({ row }) => (
				<Switch
					aria-label={`${m.common_enabled()} · /${row.original.command}`}
					checked={row.original.enabled}
					disabled={toggle.isPending}
					onCheckedChange={(enabled) =>
						toggle.mutate({ data: { id: row.original.id, enabled } })
					}
				/>
			),
		},
		{
			accessorKey: "command",
			header: m.telegram_command(),
			meta: { search: true },
			cell: ({ row }) => <code>/{row.original.command}</code>,
		},
		{
			accessorKey: "scope",
			header: m.telegram_scope(),
			cell: ({ row }) => telegramOptionLabel(row.original.scope),
		},
		{ accessorKey: "sortOrder", header: m.telegram_sort_order() },
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
							<DropdownMenuItem onClick={() => setEditing(row.original)}>
								<Pencil />
								{m.common_edit()}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								disabled={remove.isPending}
								onClick={() => remove.mutate({ data: { id: row.original.id } })}
							>
								<Trash2 />
								{m.common_delete()}
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
				title={m.nav_telegram_commands()}
				description={m.telegram_commands_description()}
				actions={
					<div className="flex gap-2">
						<ProButton
							variant="outline"
							disabled={reconcile.isPending}
							onClick={() => reconcile.mutate({ data: undefined })}
						>
							<RotateCcw />
							{m.telegram_reconcile_defaults()}
						</ProButton>
						<ProButton
							variant="outline"
							disabled={sync.isPending || configuration.botCount === 0}
							onClick={() => sync.mutate({ data: undefined })}
						>
							<Send />
							{m.telegram_sync_commands()}
						</ProButton>
						<CreateCommand onCreated={refresh} />
					</div>
				}
			/>
			<ProTable
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				className="min-h-0 flex-1"
				columns={columns}
				request={request}
				requestKey={refreshKey}
				onRefresh={refresh}
				toolbarSearch={{ columnId: "command", placeholder: m.common_search() }}
				table={{ stickyHeader: true }}
			/>
			<ModalForm
				open={Boolean(editing)}
				onOpenChange={(open) => {
					if (!open) setEditing(null);
				}}
				title={m.common_edit()}
				description={m.telegram_commands_description()}
				schema={commandFormSchema()}
				initialValues={
					editing
						? {
								command: editing.command,
								descriptions: JSON.stringify(commandDescriptions(editing)),
								templateTranslations: JSON.stringify(
									editing.templateTranslations,
								),
								scope: editing.scope,
								sortOrder: editing.sortOrder,
							}
						: {}
				}
				onFinish={async (values) => {
					if (!editing) return;
					await update.mutateAsync({
						data: { id: editing.id, ...telegramCommandValues(values) },
					});
				}}
				onFinishFailed={showTelegramError}
			/>
		</div>
	);
}

function CreateCommand({ onCreated }: { onCreated: () => Promise<unknown> }) {
	return (
		<ModalForm
			title={m.common_new()}
			description={m.telegram_add_command_description()}
			trigger={<ProButton>{m.common_new()}</ProButton>}
			schema={commandFormSchema()}
			initialValues={{
				scope: "default",
				sortOrder: 100,
				descriptions: JSON.stringify(emptyTemplateTranslations()),
				templateTranslations: JSON.stringify(emptyTemplateTranslations()),
			}}
			onFinish={async (values) => {
				const result = await createTelegramCommandFn({
					data: telegramCommandValues(values),
				});
				await onCreated();
				showSynchronizationResult(result);
				toast.success(m.telegram_command_added());
			}}
			onFinishFailed={showTelegramError}
		/>
	);
}

function showSynchronizationResult(result: {
	results: Array<
		| { ok: true; synced: number; botName: string }
		| { ok: false; botName: string }
	>;
}) {
	const successful = result.results.filter(
		(item): item is { ok: true; synced: number; botName: string } => item.ok,
	);
	const failed = result.results.filter((item) => !item.ok);
	toast.success(
		m.telegram_commands_synced({
			count: successful.reduce((total, item) => total + item.synced, 0),
		}),
	);
	if (failed.length) {
		toast.error(
			m.telegram_commands_sync_failed({
				bots: failed.map((item) => item.botName).join(", "),
			}),
		);
	}
}
