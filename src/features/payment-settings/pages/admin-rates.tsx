import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Settings } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ModalForm } from "#/components/pro/form";
import { ProTable } from "#/components/pro/table";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { paymentSettingsOperationErrorMessage } from "#/features/payment-settings/error-message";
import {
	getRatesPageFn,
	saveRateSyncSettingsFn,
	updateManualRatesFn,
} from "#/features/payment-settings/server/rate-functions";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime, formatDecimalAmount } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type View = "crypto" | "fiat";
type RatesPageData = Awaited<ReturnType<typeof getRatesPageFn>>;
type Rate = RatesPageData["rates"][number];

export const ratesPageQueryOptions = (view: View) =>
	queryOptions({
		queryKey: ["admin", "rates-page", view],
		queryFn: () => getRatesPageFn({ data: { category: view } }),
		staleTime: 30_000,
	});

export function RatesPage({ view }: { view: View }) {
	const [editingRate, setEditingRate] = useState<Rate | null>(null);
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "pair" });
	const page = useQuery(ratesPageQueryOptions(view));
	const refresh = () => page.refetch();
	const saveSyncSettings = useMutation({
		mutationFn: saveRateSyncSettingsFn,
		onSuccess: async (result) => {
			await refresh();
			if ("failed" in result) {
				toast.success(
					result.failed
						? m.infrastructure_rates_sync_partial(result)
						: m.infrastructure_rates_sync_success(result),
				);
				return;
			}
			toast.success(m.settings_saved());
		},
		onError: showError,
	});
	const rateColumns: ColumnDef<Rate>[] = [
		{
			id: "pair",
			header: m.infrastructure_pair(),
			accessorFn: (row) => `${row.base}/${row.quote}`,
			meta: { search: true },
		},
		{
			accessorKey: "raw_rate",
			header: m.rates_original_rate(),
			cell: ({ row }) =>
				row.original.raw_rate
					? formatDecimalAmount(row.original.raw_rate)
					: "—",
		},
		{
			accessorKey: "rate",
			header: m.infrastructure_rate(),
			cell: ({ row }) =>
				row.original.rate ? formatDecimalAmount(row.original.rate) : "—",
		},
		{
			accessorKey: "observed_at",
			header: m.infrastructure_synced_at(),
			cell: ({ row }) =>
				row.original.observed_at > 0
					? formatDateTime(new Date(row.original.observed_at).toISOString())
					: "—",
		},
		{
			id: "actions",
			header: m.common_actions(),
			cell: ({ row }: { row: { original: Rate } }) => (
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
							<DropdownMenuItem onClick={() => setEditingRate(row.original)}>
								<Pencil />
								{m.common_edit()}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			),
		} satisfies ColumnDef<Rate>,
	];
	const pageTitle = {
		crypto: m.nav_crypto_rates(),
		fiat: m.nav_fiat_rates(),
	}[view];
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				title={pageTitle}
				description={m.infrastructure_rates_description()}
				actions={
					<RateSyncSettingsForm
						category={view}
						settings={page.data?.syncSettings}
						pending={saveSyncSettings.isPending || page.isLoading}
						onSave={async (data) => saveSyncSettings.mutateAsync({ data })}
					/>
				}
			/>
			<ProTable
				className="min-h-0 flex-1"
				columns={rateColumns}
				data={page.data?.rates ?? []}
				loading={page.isLoading}
				onRefresh={refresh}
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				toolbarSearch={{
					columnId: "pair",
					placeholder: m.infrastructure_search_rates(),
				}}
				table={{ stickyHeader: true }}
			/>
			<ModalForm
				open={Boolean(editingRate)}
				onOpenChange={(open) => {
					if (!open) setEditingRate(null);
				}}
				title={m.rates_edit_rate()}
				description={m.rates_edit_rate_description()}
				schema={[
					{ name: "rate", label: m.infrastructure_rate(), required: true },
				]}
				initialValues={editingRate ? { rate: editingRate.rate ?? "" } : {}}
				onFinish={async (values) => {
					if (!editingRate) return;
					await updateManualRatesFn({
						data: {
							rates: [
								{
									id: editingRate.id,
									category: editingRate.category,
									rate: String(values.rate ?? ""),
								},
							],
						},
					});
					setEditingRate(null);
					await refresh();
				}}
				onFinishFailed={showError}
			/>
		</div>
	);
}

type SyncSettings = RatesPageData["syncSettings"];
type SyncSettingsInput = Parameters<typeof saveRateSyncSettingsFn>[0]["data"];

function RateSyncSettingsForm({
	category,
	settings,
	pending,
	onSave,
}: {
	category: "crypto" | "fiat";
	settings: SyncSettings | undefined;
	pending: boolean;
	onSave: (data: SyncSettingsInput) => Promise<unknown>;
}) {
	const runNowRef = useRef(false);
	return (
		<ModalForm
			title={m.settings()}
			description={
				category === "crypto" ? m.nav_crypto_rates() : m.nav_fiat_rates()
			}
			trigger={
				<ProButton disabled={pending}>
					<Settings />
					{m.settings()}
				</ProButton>
			}
			schema={[
				{
					name: "enabled",
					label: m.rates_auto_sync(),
					valueType: "switch",
					description: m.rates_auto_sync_description(),
					fieldProps: { autoFocus: true },
				},
				{
					name: "provider",
					label: m.infrastructure_source(),
					valueType: "select",
					required: true,
					fieldProps: {
						options:
							category === "crypto"
								? [
										{ label: "Binance", value: "binance" },
										{ label: "OKX", value: "okx" },
									]
								: [{ label: "exchangerate.host", value: "exchangerate_host" }],
					},
				},
				{
					name: "apiKey",
					label: m.api_key_secret(),
					valueType: "password",
					hidden: category !== "fiat",
					required:
						category === "fiat" &&
						!(settings?.category === "fiat" && settings.hasCredentials),
					description:
						settings?.category === "fiat" && settings.hasCredentials
							? m.settings_secret_configured()
							: undefined,
				},
				{
					name: "intervalValue",
					label: m.rates_sync_interval(),
					required: true,
					fieldProps: {
						type: "number",
						min: category === "crypto" ? 60 : 300,
						step: 60,
						suffix: m.unit_seconds(),
					},
				},
				{
					name: "adjustmentBps",
					label: m.rates_adjustment_bps(),
					description: m.rates_adjustment_bps_description(),
					required: true,
					fieldProps: {
						type: "number",
						min: -9999,
						max: 100000,
						step: 1,
						suffix: m.unit_basis_points(),
					},
				},
			]}
			initialValues={{
				enabled: settings?.enabled ?? true,
				provider:
					settings?.provider ??
					(category === "crypto" ? "binance" : "exchangerate_host"),
				intervalValue:
					(settings?.intervalMs ??
						(category === "crypto" ? 3_600_000 : 86_400_000)) / 1_000,
				adjustmentBps: settings?.adjustmentBps ?? 0,
			}}
			onFinish={async (values) => {
				const runNow = runNowRef.current;
				const enabled = values.enabled !== "false";
				try {
					if (category === "crypto") {
						await onSave({
							category,
							enabled,
							provider: String(values.provider ?? "binance") as
								| "binance"
								| "okx",
							intervalMs: Number(values.intervalValue ?? 3_600) * 1_000,
							adjustmentBps: Number(values.adjustmentBps ?? 0),
							runNow,
						});
						return;
					}
					await onSave({
						category,
						enabled,
						provider: "exchangerate_host",
						intervalMs: Number(values.intervalValue ?? 86_400) * 1_000,
						adjustmentBps: Number(values.adjustmentBps ?? 0),
						apiKey: String(values.apiKey ?? "").trim() || undefined,
						runNow,
					});
				} finally {
					runNowRef.current = false;
				}
			}}
			onFinishFailed={showError}
			submitter={({ submitting }) => (
				<>
					<ProButton
						type="submit"
						variant="outline"
						loading={submitting && runNowRef.current}
						disabled={submitting}
						onClick={() => {
							runNowRef.current = true;
						}}
					>
						{m.rates_sync_now()}
					</ProButton>
					<ProButton
						type="submit"
						loading={submitting && !runNowRef.current}
						disabled={submitting}
						onClick={() => {
							runNowRef.current = false;
						}}
					>
						{m.pro_form_submit()}
					</ProButton>
				</>
			)}
		/>
	);
}

function showError(error: unknown) {
	toast.error(paymentSettingsOperationErrorMessage(error));
}
