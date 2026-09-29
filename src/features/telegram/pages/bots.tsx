import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Send, Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { formBooleanValue, ModalForm } from "#/components/pro/form";
import { ProTable, type ProTableState } from "#/components/pro/table";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Switch } from "#/components/ui/switch";
import {
	createTelegramBotFn,
	deleteTelegramBotFn,
	listTelegramBotsFn,
	setTelegramBotEnabledFn,
	type TelegramBotRecord,
	testTelegramBotFn,
	updateTelegramBotFn,
} from "#/features/telegram/server/bots-admin";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";
import { showTelegramError } from "./form-fields";

export function TelegramBotsPage() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "name" });
	const client = useQueryClient();
	const [refreshKey, setRefreshKey] = useState(0);
	const snapshotRef = useRef<{ key: string; at: number } | null>(null);
	const [editingBot, setEditingBot] = useState<TelegramBotRecord | null>(null);
	const refresh = async () => {
		snapshotRef.current = null;
		await Promise.all(
			["bots", "notifications", "commands"].map((resource) =>
				client.invalidateQueries({
					queryKey: ["admin", "telegram", resource],
				}),
			),
		);
		setRefreshKey((value) => value + 1);
	};
	const request = useCallback(
		async (state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "name")?.value ?? "",
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
			return client.fetchQuery({
				queryKey: ["admin", "telegram", "bots", input],
				queryFn: () => listTelegramBotsFn({ data: input }),
			});
		},
		[client],
	);
	const enabled = useMutation({
		mutationFn: setTelegramBotEnabledFn,
		onSuccess: refresh,
		onError: showTelegramError,
	});
	const test = useMutation({
		mutationFn: testTelegramBotFn,
		onSuccess: (result) =>
			toast.success(
				m.telegram_connected_as({ username: result.username ?? "bot" }),
			),
		onError: showTelegramError,
	});
	const remove = useMutation({
		mutationFn: deleteTelegramBotFn,
		onSuccess: refresh,
		onError: showTelegramError,
	});
	const update = useMutation({
		mutationFn: updateTelegramBotFn,
		onSuccess: async (result) => {
			setEditingBot(null);
			await refresh();
			if (result.oldWebhookRemoved) toast.success(m.telegram_bot_updated());
			else toast.warning(m.telegram_old_webhook_cleanup_failed());
		},
		onError: showTelegramError,
	});
	const columns: ColumnDef<TelegramBotRecord>[] = [
		{
			accessorKey: "enabled",
			header: m.common_enabled(),
			cell: ({ row }) => (
				<Switch
					aria-label={`${m.common_enabled()} · ${row.original.name}`}
					checked={row.original.enabled}
					disabled={enabled.isPending}
					onCheckedChange={(value) =>
						enabled.mutate({ data: { id: row.original.id, enabled: value } })
					}
				/>
			),
		},
		{
			accessorKey: "name",
			header: m.telegram_bot(),
			meta: { search: true },
			cell: ({ row }) => (
				<div>
					<strong className="block">{row.original.name}</strong>
					<span className="text-muted-foreground text-xs">
						{row.original.username
							? `@${row.original.username}`
							: m.telegram_username_unavailable()}
					</span>
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
							>
								<MoreHorizontal />
							</ProButton>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => setEditingBot(row.original)}>
								<Pencil />
								{m.common_edit()}
							</DropdownMenuItem>
							<DropdownMenuItem
								disabled={test.isPending}
								onClick={() => test.mutate({ data: { id: row.original.id } })}
							>
								<Send />
								{m.telegram_test_connection()}
							</DropdownMenuItem>
							<DropdownMenuItem
								variant="destructive"
								disabled={remove.isPending}
								onClick={() => {
									if (window.confirm(m.telegram_delete_bot_confirm()))
										remove.mutate({ data: { id: row.original.id } });
								}}
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
				title={m.telegram_bot()}
				description={m.telegram_bots_description()}
				actions={<CreateBot onCreated={refresh} />}
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
					columnId: "name",
					placeholder: m.telegram_search_bots(),
				}}
				table={{ stickyHeader: true }}
			/>
			<ModalForm
				open={Boolean(editingBot)}
				onOpenChange={(open) => {
					if (!open) setEditingBot(null);
				}}
				title={m.telegram_edit_bot()}
				description={m.telegram_edit_bot_description()}
				schema={[
					{ name: "name", label: m.common_name(), required: true },
					{
						name: "token",
						label: m.telegram_bot_token(),
						valueType: "password",
						description: m.telegram_token_preserve_description(),
					},
				]}
				initialValues={editingBot ? { name: editingBot.name, token: "" } : {}}
				onFinish={async (values) => {
					if (!editingBot) return;
					const token = String(values.token ?? "").trim();
					await update.mutateAsync({
						data: {
							id: editingBot.id,
							name: String(values.name ?? ""),
							token: token || undefined,
						},
					});
				}}
				onFinishFailed={showTelegramError}
			/>
		</div>
	);
}

function CreateBot({ onCreated }: { onCreated: () => Promise<unknown> }) {
	return (
		<ModalForm
			title={m.telegram_add_bot()}
			description={m.telegram_add_bot_description()}
			trigger={<ProButton>{m.common_new()}</ProButton>}
			schema={[
				{ name: "name", label: m.common_name(), required: true },
				{
					name: "token",
					label: m.telegram_bot_token(),
					valueType: "password",
					required: true,
				},
				{ name: "enabled", label: m.common_enabled(), valueType: "switch" },
			]}
			initialValues={{ enabled: false }}
			onFinish={async (values) => {
				const result = await createTelegramBotFn({
					data: {
						name: String(values.name ?? ""),
						token: String(values.token ?? ""),
						enabled: formBooleanValue(values.enabled),
					},
				});
				await onCreated();
				if (result.synced === false)
					toast.warning(m.telegram_bot_added_sync_failed());
				else toast.success(m.telegram_bot_added());
			}}
			onFinishFailed={showTelegramError}
		/>
	);
}
