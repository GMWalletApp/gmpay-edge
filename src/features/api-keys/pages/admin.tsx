import { useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Check, Copy, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { Checkbox } from "#/components/pro/base/fields/checkbox";
import { ModalForm } from "#/components/pro/form";
import { ProModal } from "#/components/pro/overlay";
import { ProTable, type ProTableState } from "#/components/pro/table";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "#/components/ui/accordion";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Switch } from "#/components/ui/switch";
import {
	hasSystemPermission,
	systemPermission,
} from "#/features/access/system-rbac";
import { apiKeyErrorMessage } from "#/features/api-keys/error-message";
import {
	createApiKeyFn,
	listApiKeysFn,
	revokeApiKeyFn,
	rotateApiKeyFn,
	setApiKeyEnabledFn,
} from "#/features/api-keys/server/admin";
import { ConfirmDialog } from "#/layouts/components/confirm-dialog";
import { Main } from "#/layouts/components/main";
import { useNavigation } from "#/layouts/components/navigation-context";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type ApiKeyRecord = Awaited<ReturnType<typeof listApiKeysFn>>["data"][number];
type RevealedKey = { pid: string; secret: string };
type PendingKeyAction = { kind: "rotate" | "revoke"; key: ApiKeyRecord };
const scopes = [
	"orders:create",
	"orders:read",
	"orders:update",
	"assets:read",
] as const;

export function ApiKeysPage() {
	const { permissions } = useNavigation();
	const canCreate = hasSystemPermission(
		permissions,
		systemPermission("api_keys", "create"),
	);
	const canRotate = hasSystemPermission(
		permissions,
		systemPermission("api_keys", "update"),
	);
	const canRevoke = hasSystemPermission(
		permissions,
		systemPermission("api_keys", "delete"),
	);
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "name" });
	const [refreshKey, setRefreshKey] = useState(0);
	const [revealed, setRevealed] = useState<RevealedKey | null>(null);
	const [pendingAction, setPendingAction] = useState<PendingKeyAction | null>(
		null,
	);
	const refresh = () => {
		setRefreshKey((value) => value + 1);
	};
	const request = useCallback(async (state: ProTableState) => {
		const search = String(
			state.columnFilters.find((filter) => filter.id === "name")?.value ?? "",
		);
		return listApiKeysFn({
			data: {
				pageIndex: state.pagination.pageIndex,
				pageSize: state.pagination.pageSize,
				search,
			},
		});
	}, []);
	const enabled = useMutation({
		mutationFn: setApiKeyEnabledFn,
		onSuccess: (result) => {
			refresh();
			toast.success(
				result.enabled
					? m.api_keys_enabled_success()
					: m.api_keys_disabled_success(),
			);
		},
		onError: showError,
	});
	const revoke = useMutation({
		mutationFn: revokeApiKeyFn,
		onSuccess: () => {
			setPendingAction(null);
			refresh();
		},
		onError: showError,
	});
	const rotate = useMutation({
		mutationFn: rotateApiKeyFn,
		onSuccess: (result) => {
			setPendingAction(null);
			setRevealed(result);
			refresh();
		},
		onError: showError,
	});
	const columns: ColumnDef<ApiKeyRecord>[] = [
		{
			accessorKey: "enabled",
			header: m.common_enabled(),
			cell: ({ row }) =>
				row.original.revokedAt ? (
					<Badge variant="secondary">{m.api_keys_revoked()}</Badge>
				) : (
					<Switch
						aria-label={m.api_keys_toggle({ name: row.original.name })}
						checked={row.original.enabled}
						disabled={!canRotate || enabled.isPending}
						onCheckedChange={(nextEnabled) =>
							enabled.mutate({
								data: { id: row.original.id, enabled: nextEnabled },
							})
						}
					/>
				),
		},
		{
			accessorKey: "name",
			header: m.common_name(),
			meta: { search: true },
			cell: ({ row }) => <strong>{row.original.name}</strong>,
		},
		{
			accessorKey: "pid",
			header: m.api_keys_key(),
			cell: ({ row }) => (
				<code className="text-muted-foreground text-xs">
					{row.original.pid}
				</code>
			),
		},
		{
			accessorKey: "scopes",
			header: m.api_keys_scopes(),
			cell: ({ row }) => (
				<div className="flex max-w-md flex-wrap gap-1">
					{row.original.scopes.map((scope) => (
						<Badge key={scope} variant="outline">
							{scopeLabel(scope)}
						</Badge>
					))}
				</div>
			),
		},
		{
			accessorKey: "lastUsedAt",
			header: m.api_keys_last_used(),
			cell: ({ row }) =>
				row.original.lastUsedAt
					? formatDateTime(row.original.lastUsedAt)
					: m.api_keys_never(),
		},
		{
			id: "actions",
			header: canRotate || canRevoke ? m.common_actions() : "",
			cell: ({ row }) =>
				!row.original.revokedAt && (canRotate || canRevoke) ? (
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
								{canRotate ? (
									<DropdownMenuItem
										disabled={rotate.isPending}
										onClick={() =>
											setPendingAction({
												kind: "rotate",
												key: row.original,
											})
										}
									>
										<RotateCcw />
										{m.api_keys_rotate()}
									</DropdownMenuItem>
								) : null}
								{canRevoke ? (
									<DropdownMenuItem
										variant="destructive"
										disabled={revoke.isPending}
										onClick={() =>
											setPendingAction({
												kind: "revoke",
												key: row.original,
											})
										}
									>
										<Trash2 />
										{m.api_keys_revoke()}
									</DropdownMenuItem>
								) : null}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				) : null,
		},
	];
	async function create(values: Record<string, unknown>) {
		const result = await createApiKeyFn({
			data: {
				name: String(values.name ?? ""),
				scopes: (Array.isArray(values.scopes) ? values.scopes : []).filter(
					(value): value is (typeof scopes)[number] =>
						scopes.includes(value as (typeof scopes)[number]),
				),
			},
		});
		setRevealed(result);
		refresh();
	}
	return (
		<>
			<Main fixed className="gap-4">
				<PageHeader
					title={m.api_keys_title()}
					description={m.api_keys_description()}
					actions={
						canCreate ? (
							<ModalForm
								title={m.api_keys_create()}
								description={m.api_keys_create_description()}
								trigger={<ProButton>{m.common_new()}</ProButton>}
								schema={apiKeySchema}
								initialValues={{ scopes: [...scopes] }}
								onFinish={create}
								onFinishFailed={showError}
							/>
						) : undefined
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
					toolbarSearch={{ columnId: "name", placeholder: m.api_keys_search() }}
					table={{ stickyHeader: true }}
				/>
			</Main>
			<ProModal
				open={Boolean(revealed)}
				onOpenChange={(open) => {
					if (!open) setRevealed(null);
				}}
				title={m.api_keys_save()}
				description={m.api_keys_secret_once()}
			>
				{revealed ? (
					<div className="grid gap-4 py-2">
						<SecretRow label={m.api_keys_key()} value={revealed.pid} />
						<SecretRow label={m.api_keys_secret()} value={revealed.secret} />
						<Button onClick={() => setRevealed(null)}>
							<Check />
							{m.api_keys_secret_saved()}
						</Button>
					</div>
				) : null}
			</ProModal>
			<ConfirmDialog
				open={Boolean(pendingAction)}
				onOpenChange={(open) => !open && setPendingAction(null)}
				title={
					pendingAction?.kind === "rotate"
						? m.api_keys_rotate_confirm_title()
						: m.api_keys_revoke_confirm_title()
				}
				desc={
					pendingAction?.kind === "rotate"
						? m.api_keys_rotate_confirm_description({
								name: pendingAction.key.name,
							})
						: m.api_keys_revoke_confirm_description({
								name: pendingAction?.key.name ?? "",
							})
				}
				confirmText={
					pendingAction?.kind === "rotate"
						? m.api_keys_rotate()
						: m.api_keys_revoke()
				}
				destructive
				isLoading={rotate.isPending || revoke.isPending}
				handleConfirm={() => {
					if (!pendingAction) return;
					if (pendingAction.kind === "rotate")
						rotate.mutate({ data: { id: pendingAction.key.id } });
					else revoke.mutate({ data: { id: pendingAction.key.id } });
				}}
			/>
		</>
	);
}

const apiKeySchema = [
	{
		name: "name",
		label: m.common_name(),
		required: true,
		fieldProps: { placeholder: m.api_keys_name_placeholder() },
	},
	{
		name: "scopes",
		required: true,
		render: (field: {
			value: unknown;
			onChange: (value: string[]) => void;
		}) => (
			<ApiScopeMatrix
				value={Array.isArray(field.value) ? field.value.map(String) : []}
				onChange={field.onChange}
			/>
		),
	},
];

const scopeGroups = [
	{
		id: "orders",
		label: () => m.api_keys_module_orders(),
		scopes: ["orders:create", "orders:read", "orders:update"] as const,
	},
	{
		id: "assets",
		label: () => m.api_keys_module_assets(),
		scopes: ["assets:read"] as const,
	},
] as const;

function ApiScopeMatrix({
	value,
	onChange,
}: {
	value: string[];
	onChange: (value: string[]) => void;
}) {
	return (
		<Accordion
			className="rounded-md border px-3"
			type="multiple"
			defaultValue={["orders"]}
		>
			{scopeGroups.map((group) => (
				<AccordionItem key={group.id} value={group.id}>
					<AccordionTrigger>{group.label()}</AccordionTrigger>
					<AccordionContent className="grid gap-3 sm:grid-cols-2">
						{group.scopes.map((scope) => (
							<div className="flex items-center gap-2 text-sm" key={scope}>
								<Checkbox
									value={value.includes(scope)}
									onChange={(checked) =>
										onChange(
											checked === true
												? [...new Set([...value, scope])]
												: value.filter((item) => item !== scope),
										)
									}
								/>
								{scopeLabel(scope)}
							</div>
						))}
					</AccordionContent>
				</AccordionItem>
			))}
		</Accordion>
	);
}

function scopeLabel(scope: string) {
	return (
		{
			"orders:create": m.api_keys_permission_orders_create(),
			"orders:read": m.api_keys_permission_orders_read(),
			"orders:update": m.api_keys_permission_orders_update(),
			"assets:read": m.api_keys_permission_assets_read(),
		}[scope] ?? m.common_unknown()
	);
}
function SecretRow({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<p className="mb-2 font-medium text-sm">{label}</p>
			<div className="flex gap-2">
				<code className="min-w-0 flex-1 break-all rounded-md border bg-muted p-3 text-xs">
					{value}
				</code>
				<Button
					aria-label={m.api_keys_copy({ label })}
					size="icon"
					variant="outline"
					onClick={async () => {
						await navigator.clipboard.writeText(value);
						toast.success(m.api_keys_copied({ label }));
					}}
				>
					<Copy />
				</Button>
			</div>
		</div>
	);
}
function showError(error: unknown) {
	toast.error(apiKeyErrorMessage(error));
}
