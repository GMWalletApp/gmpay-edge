import type { ColumnDef } from "@tanstack/react-table";
import { ProTable } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
import { rbacActionLabel, systemModuleLabel } from "#/features/access/labels";
import {
	RBAC_REGISTERED_ACTION_MASK,
	rbacActionBits,
	rbacActions,
} from "#/features/access/rbac-bitmask";
import {
	type SystemRbacModule,
	systemRbacModuleIds,
} from "#/features/access/system-rbac";
import { PageHeader } from "#/layouts/components/page-header";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type ModuleRow = {
	module: SystemRbacModule;
	name: string;
	permissionMask: number;
};
type BitRow = {
	action: (typeof rbacActions)[number];
	name: string;
	bit: number;
};

export function PermissionModulesPage() {
	const tableUrlState = useCurrentProTableUrlState({
		searchColumnId: "module",
	});
	const rows = systemRbacModuleIds.map((module) => ({
		module,
		name: systemModuleLabel(module),
		permissionMask: RBAC_REGISTERED_ACTION_MASK,
	}));
	const columns: ColumnDef<ModuleRow>[] = [
		{
			accessorKey: "module",
			header: m.access_module_code(),
			meta: { search: true },
		},
		{ accessorKey: "name", header: m.common_name(), meta: { search: true } },
		{
			accessorKey: "permissionMask",
			header: m.access_permission_mask(),
			cell: ({ row }) => (
				<Badge variant="outline">{row.original.permissionMask}</Badge>
			),
		},
	];
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				title={m.access_permission_modules()}
				description={m.access_permission_modules_description()}
			/>
			<ProTable
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				className="min-h-0 flex-1"
				columns={columns}
				data={rows}
				toolbarSearch={{ columnId: "module", placeholder: m.common_search() }}
				table={{ stickyHeader: true }}
			/>
		</div>
	);
}

export function PermissionBitsPage() {
	const tableUrlState = useCurrentProTableUrlState({
		searchColumnId: "action",
	});
	const rows = rbacActions.map((action) => ({
		action,
		name: rbacActionLabel(action),
		bit: rbacActionBits[action],
	}));
	const columns: ColumnDef<BitRow>[] = [
		{
			accessorKey: "action",
			header: m.access_action_code(),
			meta: { search: true },
		},
		{ accessorKey: "name", header: m.common_name(), meta: { search: true } },
		{
			accessorKey: "bit",
			header: m.access_permission_bit(),
			cell: ({ row }) => <Badge variant="outline">{row.original.bit}</Badge>,
		},
	];
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				title={m.access_permission_bits()}
				description={m.access_permission_bits_description()}
			/>
			<ProTable
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				className="min-h-0 flex-1"
				columns={columns}
				data={rows}
				toolbarSearch={{ columnId: "action", placeholder: m.common_search() }}
				table={{ stickyHeader: true }}
			/>
		</div>
	);
}
