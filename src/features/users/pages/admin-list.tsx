import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ModalForm } from "#/components/pro/form";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Switch } from "#/components/ui/switch";
import {
	systemAccessQueryKey,
	systemAccessQueryOptions,
} from "#/features/access/queries";
import { userOperationErrorMessage } from "#/features/users/error-message";
import {
	adminUsersQueryKey,
	adminUsersQueryOptions,
} from "#/features/users/queries";
import {
	deleteUserFn,
	saveUserFn,
	setUserEnabledFn,
	setUserRolesFn,
} from "#/features/users/server/admin";
import type { AdminUserRecord } from "#/features/users/server/users";
import { ConfirmDialog } from "#/layouts/components/confirm-dialog";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

export function UsersPage() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "email" });
	const queryClient = useQueryClient();
	const [refreshKey, setRefreshKey] = useState(0);
	const [editingUser, setEditingUser] = useState<AdminUserRecord | null>(null);
	const [deletingUser, setDeletingUser] = useState<AdminUserRecord | null>(
		null,
	);
	const access = useQuery(systemAccessQueryOptions);
	const roleOptions = (access.data?.roles ?? []).map((role) => ({
		label: role.name,
		value: role.id,
	}));

	const refresh = async () => {
		await queryClient.invalidateQueries({ queryKey: adminUsersQueryKey });
		setRefreshKey((value) => value + 1);
	};
	const saveUserMutation = useMutation({
		mutationFn: saveUserFn,
	});
	const deleteUserMutation = useMutation({
		mutationFn: deleteUserFn,
		onSuccess: async () => {
			setDeletingUser(null);
			await Promise.all([
				refresh(),
				queryClient.invalidateQueries({ queryKey: systemAccessQueryKey }),
			]);
		},
		onError: (error) => toast.error(userOperationErrorMessage(error)),
	});
	const request = useCallback(
		async (state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "email")?.value ??
					"",
			);
			const input = {
				pageIndex: state.pagination.pageIndex,
				pageSize: state.pagination.pageSize,
				search,
			};

			return await queryClient.fetchQuery(adminUsersQueryOptions(input));
		},
		[queryClient],
	);
	const columns: ColumnDef<AdminUserRecord>[] = [
		{
			accessorKey: "enabled",
			header: m.common_enabled(),
			cell: ({ row }) => (
				<UserEnabledSwitch user={row.original} onChanged={refresh} />
			),
		},
		{
			accessorKey: "name",
			header: m.admin_users_name(),
		},
		{
			accessorKey: "email",
			header: m.common_email(),
		},
		{
			accessorKey: "roles",
			header: m.admin_users_roles(),
			cell: ({ row }) => (
				<div className="flex flex-wrap gap-1">
					{row.original.roles.map((role) => (
						<Badge key={role} variant="outline">
							{role}
						</Badge>
					))}
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
								variant="ghost"
								size="icon-sm"
								tooltip={m.common_actions()}
							>
								<MoreHorizontal />
							</ProButton>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-44">
							<DropdownMenuItem onClick={() => setEditingUser(row.original)}>
								<Pencil />
								{m.common_edit()}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								onClick={() => setDeletingUser(row.original)}
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

	async function saveUser(values: Record<string, unknown>) {
		const saved = await saveUserMutation.mutateAsync({
			data: {
				...(editingUser ? { id: editingUser.id } : {}),
				name: String(values.name ?? ""),
				email: String(values.email ?? ""),
				enabled: editingUser?.enabled ?? values.enabled === "true",
				password: String(values.password ?? ""),
			},
		});
		await setUserRolesFn({
			data: {
				userId: saved.id,
				roleIds: Array.isArray(values.roles) ? values.roles.map(String) : [],
			},
		});
		setEditingUser(null);
		await Promise.all([
			refresh(),
			queryClient.invalidateQueries({ queryKey: systemAccessQueryKey }),
		]);
	}

	return (
		<>
			<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
				<PageHeader
					title={m.nav_user_management()}
					description={m.admin_users_description()}
					actions={
						<ModalForm
							key="create-user"
							trigger={<ProButton>{m.common_new()}</ProButton>}
							title={m.admin_users_newUser()}
							schema={userSchema({ mode: "create", roleOptions })}
							initialValues={{ enabled: true }}
							onFinish={saveUser}
							onFinishFailed={(error) =>
								toast.error(userOperationErrorMessage(error))
							}
						/>
					}
				/>
				<ProTable
					initialState={tableUrlState.initialState}
					onChange={tableUrlState.onChange}
					onRefresh={refresh}
					columns={columns}
					request={request}
					requestKey={refreshKey}
					toolbarSearch={{
						columnId: "email",
						placeholder: m.admin_users_search(),
					}}
					table={{ stickyHeader: true }}
					className="min-h-0 flex-1"
				/>
			</div>
			{editingUser && (
				<ModalForm
					key={editingUser.id}
					open
					onOpenChange={(open) => {
						if (!open) setEditingUser(null);
					}}
					title={m.admin_users_editUser()}
					schema={userSchema({ mode: "edit", roleOptions })}
					initialValues={{
						name: editingUser.name,
						email: editingUser.email,
						enabled: editingUser.enabled,
						roles: roleOptions
							.filter((option) => editingUser.roles.includes(option.label))
							.map((option) => option.value),
					}}
					onFinish={saveUser}
					onFinishFailed={(error) =>
						toast.error(userOperationErrorMessage(error))
					}
				/>
			)}
			<ConfirmDialog
				open={Boolean(deletingUser)}
				onOpenChange={(open) => !open && setDeletingUser(null)}
				title={m.admin_users_delete_title()}
				desc={m.admin_users_delete_description({
					email: deletingUser?.email ?? "",
				})}
				confirmText={m.common_delete()}
				destructive
				isLoading={deleteUserMutation.isPending}
				handleConfirm={() => {
					if (deletingUser)
						deleteUserMutation.mutate({ data: { id: deletingUser.id } });
				}}
			/>
		</>
	);
}

function UserEnabledSwitch({
	user,
	onChanged,
}: {
	user: AdminUserRecord;
	onChanged: () => void | Promise<void>;
}) {
	const [confirmDisable, setConfirmDisable] = useState(false);
	const setEnabledMutation = useMutation({
		mutationFn: setUserEnabledFn,
		onSuccess: async () => {
			setConfirmDisable(false);
			await onChanged();
		},
		onError: async (error) => {
			setConfirmDisable(false);
			toast.error(userOperationErrorMessage(error));
			await onChanged();
		},
	});

	return (
		<>
			<Switch
				aria-label={m.admin_users_toggleLabel({ email: user.email })}
				checked={user.enabled}
				disabled={setEnabledMutation.isPending}
				onCheckedChange={(enabled) => {
					if (!enabled) {
						setConfirmDisable(true);
						return;
					}
					setEnabledMutation.mutate({ data: { id: user.id, enabled: true } });
				}}
			/>
			<ConfirmDialog
				open={confirmDisable}
				onOpenChange={setConfirmDisable}
				title={m.admin_users_disable_title()}
				desc={m.admin_users_disable_description({ email: user.email })}
				confirmText={m.admin_users_disable_title()}
				destructive
				isLoading={setEnabledMutation.isPending}
				handleConfirm={() =>
					setEnabledMutation.mutate({ data: { id: user.id, enabled: false } })
				}
			/>
		</>
	);
}

function userSchema({
	mode,
	roleOptions,
}: {
	mode: "create" | "edit";
	roleOptions: Array<{ label: string; value: string }>;
}) {
	return [
		{ name: "name", label: m.admin_users_name(), required: true },
		{
			name: "email",
			label: m.common_email(),
			valueType: "email" as const,
			required: true,
		},
		...(mode === "create"
			? [
					{
						name: "enabled",
						label: m.common_enabled(),
						valueType: "switch" as const,
						initialValue: true,
					},
				]
			: []),
		{
			name: "roles",
			label: m.admin_users_roles(),
			valueType: "multiSelect" as const,
			fieldProps: { options: roleOptions },
		},
		{
			name: "password",
			label:
				mode === "create" ? m.common_password() : m.admin_users_newPassword(),
			valueType: "password" as const,
			required: mode === "create",
			initialValue: "",
			extra: mode === "edit" ? m.admin_users_passwordExtra() : undefined,
		},
	];
}
