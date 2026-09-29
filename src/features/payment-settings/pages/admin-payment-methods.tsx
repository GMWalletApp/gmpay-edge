import { queryOptions, useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
	AssetLabel,
	NetworkLabel,
	ProviderLabel,
} from "#/components/crypto-icons/labels";
import { ProTable } from "#/components/pro/table";
import { listPaymentMethodsFn } from "#/features/payment-settings/server/payment-methods";
import { PageHeader } from "#/layouts/components/page-header";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type Kind = "chain" | "exchange" | "wallet";
type Method = Awaited<ReturnType<typeof listPaymentMethodsFn>>[number];
type MethodGroup = {
	kind: Kind;
	name: string;
	currencies: Method[];
	currencySearch: string;
};

export const paymentMethodsQueryOptions = queryOptions({
	queryKey: ["admin", "payment-methods"],
	queryFn: () => listPaymentMethodsFn(),
	staleTime: 5 * 60_000,
});

export function PaymentMethodsPage({
	search,
}: {
	search: Record<string, unknown>;
}) {
	const tableUrlState = useCurrentProTableUrlState({
		search,
		searchColumnId: "name",
	});
	const query = useQuery(paymentMethodsQueryOptions);
	const rows = groupMethods(query.data ?? []);
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				title={m.nav_payment_capabilities()}
				description={m.payment_methods_description()}
			/>
			<ProTable
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				className="min-h-0 flex-1"
				columns={methodColumns()}
				data={rows}
				loading={query.isPending}
				onRefresh={() => query.refetch()}
				toolbarSearch={{ columnId: "name", placeholder: m.common_search() }}
				table={{ stickyHeader: true }}
			/>
		</div>
	);
}

function methodColumns(): ColumnDef<MethodGroup>[] {
	return [
		{
			accessorKey: "kind",
			header: m.common_type(),
			cell: ({ row }) => kindLabel(row.original.kind),
		},
		{
			accessorKey: "name",
			header: m.public_assets_provider(),
			meta: { search: true },
			cell: ({ row }) =>
				row.original.kind === "chain" ? (
					<NetworkLabel
						displayName={row.original.name}
						network={row.original.currencies[0]?.rail_code ?? ""}
					/>
				) : (
					<ProviderLabel
						kind={row.original.kind}
						name={row.original.name}
						provider={row.original.currencies[0]?.rail_code ?? ""}
					/>
				),
		},
		{
			accessorKey: "currencySearch",
			header: m.common_currency(),
			meta: { search: true },
			cell: ({ row }) => (
				<div className="flex flex-wrap gap-2">
					{row.original.currencies.map((currency) => (
						<AssetLabel
							key={currency.id}
							contractAddress={currency.contract_address}
							label={currency.asset_code}
							network={currency.rail_code}
							networkIndependent={row.original.kind !== "chain"}
							symbol={currency.asset_code}
						/>
					))}
				</div>
			),
		},
	];
}

function groupMethods(methods: Method[]) {
	const groups = new Map<string, MethodGroup>();
	for (const method of methods) {
		const current = groups.get(method.rail_code);
		if (current) {
			current.currencies.push(method);
			current.currencySearch += ` ${method.asset_code}`;
			continue;
		}
		groups.set(method.rail_code, {
			kind: method.rail_kind,
			name: method.rail_name,
			currencies: [method],
			currencySearch: method.asset_code,
		});
	}
	return [...groups.values()];
}

function kindLabel(kind: Kind) {
	if (kind === "chain") return m.nav_networks();
	if (kind === "exchange") return m.nav_exchanges();
	return m.nav_wallets();
}
