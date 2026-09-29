import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { CheckboxControl } from "#/components/pro/base/fields/checkbox";
import { ModalForm, type ProSchemaValueField } from "#/components/pro/form";
import { ProTable } from "#/components/pro/table";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "#/components/ui/accordion";
import { Badge } from "#/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Switch } from "#/components/ui/switch";
import { accessOperationErrorMessage } from "#/features/access/error-message";
import { rbacActionLabel, systemModuleLabel } from "#/features/access/labels";
import {
	systemAccessQueryKey,
	systemAccessQueryOptions,
} from "#/features/access/queries";
import {
	hasRbacAction,
	rbacActionBits,
	rbacActions,
} from "#/features/access/rbac-bitmask";
import {
	deleteSystemRoleFn,
	type listSystemAccessFn,
	saveSystemRoleFn,
	setSystemRoleEnabledFn,
} from "#/features/access/server/admin";
import {
	normalizeSystemPermissionGrants,
	type SystemPermissionGrant,
	systemRbacModules,
} from "#/features/access/system-rbac";
import { ConfirmDialog } from "#/layouts/components/confirm-dialog";
import { PageHeader } from "#/layouts/components/page-header";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type Access = Awaited<ReturnType<typeof listSystemAccessFn>>;
type Role = Access["roles"][number];

export function SystemAccessPage() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "name" });
	const client = useQueryClient();
	const [editingRole, setEditingRole] = useState<Role | null>(null);
	const [deletingRole, setDeletingRole] = useState<Role | null>(null);
	const query = useQuery(systemAccessQueryOptions);
	const refresh = () =>
		client.invalidateQueries({ queryKey: systemAccessQueryKey });
	const saveRole = useMutation({
		mutationFn: saveSystemRoleFn,
		onSuccess: async () => {
			setEditingRole(null);
			await refresh();
		},
		onError: showError,
	});
	const deleteRole = useMutation({
		mutationFn: deleteSystemRoleFn,
		onSuccess: async () => {
			setDeletingRole(null);
			await refresh();
		},
		onError: showError,
	});
	const setRoleEnabled = useMutation({
		mutationFn: setSystemRoleEnabledFn,
		onSuccess: refresh,
		onError: showError,
	});

	const roleColumns: ColumnDef<Role>[] = [
		{
			accessorKey: "enabled",
			header: m.common_enabled(),
			cell: ({ row }) => (
				<Switch
					aria-label={`${m.common_enabled()} · ${row.original.name}`}
					checked={row.original.enabled}
					disabled={row.original.protected || setRoleEnabled.isPending}
					onCheckedChange={(enabled) =>
						setRoleEnabled.mutate({
							data: { id: row.original.id, enabled },
						})
					}
				/>
			),
		},
		{
			accessorKey: "name",
			header: m.access_role(),
			meta: { search: true },
			cell: ({ row }) => (
				<div>
					<strong className="block">{row.original.name}</strong>
					<small className="text-muted-foreground">
						{row.original.description ?? "—"}
					</small>
				</div>
			),
		},
		{ accessorKey: "memberCount", header: m.admin_dashboard_users() },
		{
			id: "actions",
			header: m.common_actions(),
			cell: ({ row }) => (
				<ActionMenu
					disableDelete={row.original.protected || row.original.memberCount > 0}
					disableEdit={row.original.protected}
					onDelete={() => setDeletingRole(row.original)}
					onEdit={() => setEditingRole(row.original)}
				/>
			),
		},
	];

	async function submitRole(values: Record<string, unknown>) {
		await saveRole.mutateAsync({
			data: {
				id: editingRole?.id,
				name: String(values.name ?? ""),
				description: String(values.description ?? ""),
				permissions: selectedPermissions(values.permissions),
			},
		});
	}
	const roles = query.data?.roles ?? [];
	return (
		<>
			<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
				<PageHeader
					title={m.nav_role_management()}
					description={m.access_description()}
					actions={
						<ModalForm
							title={m.access_create_role()}
							trigger={<ProButton>{m.common_new()}</ProButton>}
							schema={roleSchema}
							initialValues={{ permissions: ["dashboard:1"] }}
							onFinish={submitRole}
						/>
					}
				/>
				<ProTable
					initialState={tableUrlState.initialState}
					onChange={tableUrlState.onChange}
					className="min-h-0 flex-1"
					columns={roleColumns}
					data={roles}
					loading={query.isLoading}
					onRefresh={() => query.refetch()}
					table={{ stickyHeader: true }}
					toolbarSearch={{
						columnId: "name",
						placeholder: m.access_search_roles(),
					}}
				/>
			</div>
			{editingRole ? (
				<ModalForm
					key={editingRole.id}
					open
					onOpenChange={(open) => !open && setEditingRole(null)}
					title={m.access_edit_role()}
					schema={roleSchema}
					initialValues={{
						name: editingRole.name,
						description: editingRole.description ?? "",
						permissions: encodePermissionGrants(editingRole.permissions),
					}}
					onFinish={submitRole}
				/>
			) : null}
			<ConfirmDialog
				open={Boolean(deletingRole)}
				onOpenChange={(open) => !open && setDeletingRole(null)}
				title={m.access_delete_role_title()}
				desc={m.access_delete_role_description({
					name: deletingRole?.name ?? "",
				})}
				confirmText={m.common_delete()}
				destructive
				isLoading={deleteRole.isPending}
				handleConfirm={() => {
					if (deletingRole)
						deleteRole.mutate({ data: { id: deletingRole.id } });
				}}
			/>
		</>
	);
}

const roleSchema = [
	{ name: "name", label: m.common_name(), required: true },
	{
		name: "description",
		label: m.access_role_description(),
		valueType: "textarea" as const,
	},
	{
		name: "permissions",
		required: true,
		render: (field: ProSchemaValueField) => (
			<PermissionMatrix
				value={selectedPermissions(field.value)}
				onChange={(value) => field.onChange(encodePermissionGrants(value))}
			/>
		),
	},
];

function PermissionMatrix({
	value,
	onChange,
}: {
	value: SystemPermissionGrant[];
	onChange: (value: SystemPermissionGrant[]) => void;
}) {
	return (
		<Accordion
			className="overflow-hidden rounded-lg border px-3"
			type="multiple"
		>
			{systemRbacModules.map((module) => {
				const selectedMask =
					value.find((permission) => permission.module === module.id)
						?.permissionMask ?? 0;
				return (
					<AccordionItem key={module.id} value={module.id}>
						<AccordionTrigger>
							<span>{systemModuleLabel(module.id)}</span>
							<Badge className="ms-auto" variant="outline">
								{selectedMask}
							</Badge>
						</AccordionTrigger>
						<AccordionContent>
							<div className="grid gap-3 sm:grid-cols-2">
								{rbacActions.map((action) => {
									return (
										<div
											className="flex items-center gap-3 rounded-md border p-3"
											key={action}
										>
											<CheckboxControl
												aria-label={`${systemModuleLabel(module.id)} · ${rbacActionLabel(action)}`}
												checked={hasRbacAction(selectedMask, action)}
												onCheckedChange={(checked) =>
													onChange(
														updatePermissionMask(
															value,
															module.id,
															action,
															checked === true,
														),
													)
												}
											/>
											<span>{rbacActionLabel(action)}</span>
											<code className="ms-auto text-muted-foreground">
												{rbacActionBits[action]}
											</code>
										</div>
									);
								})}
							</div>
						</AccordionContent>
					</AccordionItem>
				);
			})}
		</Accordion>
	);
}

function ActionMenu({
	disableDelete,
	disableEdit,
	onDelete,
	onEdit,
}: {
	disableDelete?: boolean;
	disableEdit?: boolean;
	onDelete: () => void;
	onEdit: () => void;
}) {
	return (
		<div className="flex justify-end">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<ProButton
						size="icon-sm"
						tooltip={m.common_actions()}
						variant="ghost"
					>
						<MoreHorizontal />
					</ProButton>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem disabled={Boolean(disableEdit)} onClick={onEdit}>
						<Pencil /> {m.common_edit()}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						disabled={Boolean(disableDelete)}
						onClick={onDelete}
						variant="destructive"
					>
						<Trash2 /> {m.common_delete()}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

function selectedPermissions(value: unknown): SystemPermissionGrant[] {
	if (!Array.isArray(value)) return [];
	return normalizeSystemPermissionGrants(
		value.flatMap((candidate) => {
			const match = /^([a-z_]+):(\d+)$/.exec(String(candidate));
			if (!match) return [];
			return [
				{
					module: match[1] as SystemPermissionGrant["module"],
					permissionMask: Number(match[2]),
				},
			];
		}),
	);
}

function encodePermissionGrants(value: SystemPermissionGrant[]) {
	return value.map(
		(permission) => `${permission.module}:${permission.permissionMask}`,
	);
}

function updatePermissionMask(
	value: SystemPermissionGrant[],
	module: SystemPermissionGrant["module"],
	action: (typeof rbacActions)[number],
	checked: boolean,
) {
	const current =
		value.find((item) => item.module === module)?.permissionMask ?? 0;
	const bit = rbacActionBits[action];
	const permissionMask = checked ? current | bit : current & ~bit;
	return normalizeSystemPermissionGrants([
		...value.filter((item) => item.module !== module),
		{ module, permissionMask },
	]);
}
function showError(error: unknown) {
	toast.error(accessOperationErrorMessage(error));
}
