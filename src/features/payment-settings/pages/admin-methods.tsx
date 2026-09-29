import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	AssetLabel,
	NetworkLabel,
	ProviderLabel,
} from "#/components/crypto-icons/labels";
import { ProButton } from "#/components/pro/base/button";
import { Input } from "#/components/pro/base/fields/input";
import { Select } from "#/components/pro/base/fields/select";
import { ModalForm } from "#/components/pro/form";
import { ProTable } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Switch } from "#/components/ui/switch";
import { paymentSettingsOperationErrorMessage } from "#/features/payment-settings/error-message";
import { paymentSettingsError } from "#/features/payment-settings/errors";
import {
	createReceivingMethodFn,
	deleteReceivingMethodFn,
	listReceivingMethodOptionsFn,
	listReceivingMethodsFn,
	setReceivingMethodEnabledFn,
	updateReceivingMethodFn,
} from "#/features/payment-settings/server/methods";
import { ConfirmDialog } from "#/layouts/components/confirm-dialog";
import { Main } from "#/layouts/components/main";
import { PageHeader } from "#/layouts/components/page-header";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type MethodRow = Awaited<ReturnType<typeof listReceivingMethodsFn>>[number];

export function ReceivingMethodsPage() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "name" });
	const client = useQueryClient();
	const [editingMethod, setEditingMethod] = useState<MethodRow | null>(null);
	const [deletingMethod, setDeletingMethod] = useState<MethodRow | null>(null);
	const query = useQuery({
		queryKey: ["admin", "receiving-methods"],
		queryFn: () => listReceivingMethodsFn(),
	});
	const toggle = useMutation({
		mutationFn: setReceivingMethodEnabledFn,
		onSuccess: async () => {
			await client.invalidateQueries({
				queryKey: ["admin", "receiving-methods"],
			});
			toast.success(m.receiving_methods_saved());
		},
		onError: showError,
	});
	const remove = useMutation({
		mutationFn: deleteReceivingMethodFn,
		onSuccess: async (result) => {
			setDeletingMethod(null);
			if (!result.deleted) {
				toast.error(m.receiving_methods_delete_in_use());
				return;
			}
			await client.invalidateQueries({
				queryKey: ["admin", "receiving-methods"],
			});
			toast.success(m.receiving_methods_deleted());
		},
		onError: showError,
	});
	const rows = query.data ?? [];
	const columns: ColumnDef<MethodRow>[] = [
		{
			accessorKey: "enabled",
			header: m.common_enabled(),
			cell: ({ row }) => (
				<Switch
					aria-label={`${m.common_enabled()} · ${row.original.name}`}
					checked={Boolean(row.original.enabled)}
					disabled={toggle.isPending}
					onCheckedChange={(enabled) =>
						toggle.mutate({ data: { id: row.original.id, enabled } })
					}
				/>
			),
		},
		{
			accessorKey: "name",
			header: m.common_name(),
			meta: { search: true },
			cell: ({ row }) => (
				<span className="font-medium">{row.original.name}</span>
			),
		},
		{
			accessorKey: "rail_kind",
			header: m.common_type(),
			cell: ({ row }) => (
				<Badge
					variant="outline"
					className={kindBadgeClass(row.original.rail_kind)}
				>
					{kindLabel(row.original.rail_kind)}
				</Badge>
			),
		},
		{
			accessorKey: "rail_name",
			header: m.public_assets_provider(),
			cell: ({ row }) =>
				row.original.rail_kind === "chain" ? (
					<NetworkLabel
						displayName={row.original.rail_name}
						network={row.original.rail_code}
					/>
				) : (
					<ProviderLabel
						kind={row.original.rail_kind}
						name={row.original.rail_name}
						provider={row.original.rail_code}
					/>
				),
		},
		{
			id: "assets",
			header: m.common_currency(),
			cell: ({ row }) => (
				<div className="flex flex-wrap gap-2">
					{row.original.assets.map((asset) => (
						<AssetLabel
							key={asset.payment_method_id}
							label={asset.asset_code}
							network={row.original.rail_code}
							networkIndependent={row.original.rail_kind !== "chain"}
							symbol={asset.asset_code}
						/>
					))}
				</div>
			),
		},
		{
			accessorKey: "target_value",
			header: m.receiving_target(),
			cell: ({ row }) => (
				<code className="block max-w-64 truncate text-muted-foreground text-xs">
					{row.original.target_value}
				</code>
			),
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
							<DropdownMenuItem onClick={() => setEditingMethod(row.original)}>
								<Pencil />
								{m.common_edit()}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								disabled={remove.isPending}
								onClick={() => setDeletingMethod(row.original)}
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
		<Main fixed className="gap-4">
			<PageHeader
				title={m.receiving_methods_title()}
				description={m.receiving_methods_description()}
				actions={
					<CreateReceivingMethodForm
						onCreated={async () => {
							await client.invalidateQueries({
								queryKey: ["admin", "receiving-methods"],
							});
						}}
					/>
				}
			/>
			<ProTable
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				className="min-h-0 flex-1"
				columns={columns}
				data={rows}
				loading={query.isLoading}
				onRefresh={() => query.refetch()}
				toolbarSearch={{
					columnId: "name",
					placeholder: m.receiving_methods_search(),
				}}
				table={{ stickyHeader: true }}
			/>
			<ModalForm
				open={Boolean(editingMethod)}
				onOpenChange={(open) => {
					if (!open) setEditingMethod(null);
				}}
				title={m.common_edit()}
				description={m.receiving_methods_description()}
				schema={[
					{ name: "name", label: m.common_name(), required: true },
					{
						name: "minAmount",
						label: `${m.pro_field_minimumValue()} (USD)`,
					},
					{
						name: "maxAmount",
						label: `${m.pro_field_maximumValue()} (USD)`,
					},
				]}
				initialValues={
					editingMethod
						? {
								name: editingMethod.name,
								minAmount: editingMethod.min_amount ?? "",
								maxAmount: editingMethod.max_amount ?? "",
							}
						: {}
				}
				onFinish={async (values) => {
					if (!editingMethod) return;
					await updateReceivingMethodFn({
						data: {
							id: editingMethod.id,
							name: String(values.name ?? ""),
							minAmount: optionalString(values.minAmount),
							maxAmount: optionalString(values.maxAmount),
						},
					});
					setEditingMethod(null);
					await client.invalidateQueries({
						queryKey: ["admin", "receiving-methods"],
					});
					toast.success(m.receiving_methods_saved());
				}}
				onFinishFailed={showError}
			/>
			<ConfirmDialog
				open={Boolean(deletingMethod)}
				onOpenChange={(open) => !open && setDeletingMethod(null)}
				title={m.receiving_methods_delete_title()}
				desc={m.receiving_methods_delete_description({
					name: deletingMethod?.name ?? "",
				})}
				confirmText={m.common_delete()}
				destructive
				isLoading={remove.isPending}
				handleConfirm={() => {
					if (deletingMethod)
						remove.mutate({ data: { id: deletingMethod.id } });
				}}
			/>
		</Main>
	);
}

function CreateReceivingMethodForm({
	onCreated,
}: {
	onCreated: () => Promise<unknown>;
}) {
	const [open, setOpen] = useState(false);
	const options = useQuery({
		queryKey: ["admin", "receiving-method-options"],
		queryFn: () => listReceivingMethodOptionsFn(),
		enabled: open,
	});
	return (
		<ModalForm
			open={open}
			onOpenChange={setOpen}
			title={m.receiving_methods_new()}
			description={m.receiving_methods_new_description()}
			trigger={<ProButton>{m.common_new()}</ProButton>}
			schema={[
				{ name: "name", label: m.common_name(), required: true },
				{
					name: "paymentConfiguration",
					label: m.receiving_configuration(),
					required: true,
					render: (field) => (
						<ReceivingConfigurationFields
							methods={options.data?.methods ?? []}
							onChange={(value) => field.onChange(value)}
						/>
					),
				},
			]}
			onFinish={async (values) => {
				const selection = parsePaymentConfiguration(
					String(values.paymentConfiguration ?? ""),
				);
				await createReceivingMethodFn({
					data: {
						name: String(values.name ?? ""),
						paymentMethodIds: selection.paymentMethodIds,
						configuration: selection.configuration,
						minAmount: selection.minAmount,
						maxAmount: selection.maxAmount,
					},
				});
				await onCreated();
				toast.success(m.receiving_methods_created());
			}}
			onFinishFailed={showError}
		/>
	);
}

function ReceivingConfigurationFields({
	methods,
	onChange,
}: {
	methods: Array<{
		id: string;
		name: string;
		rail_code: string;
		rail_name: string;
		asset_code: string;
		decimals: number;
		rail_kind: "chain" | "exchange" | "wallet";
	}>;
	onChange: (value: string) => void;
}) {
	const [kind, setKind] = useState<"chain" | "exchange" | "wallet">("chain");
	const [railCode, setRailCode] = useState("");
	const [methodIds, setMethodIds] = useState<string[]>([]);
	const [configuration, setConfiguration] = useState<Record<string, string>>(
		{},
	);
	const [minAmount, setMinAmount] = useState("");
	const [maxAmount, setMaxAmount] = useState("");
	const available = methods.filter((method) => method.rail_kind === kind);
	const rails = Array.from(
		new Map(
			available.map((method) => [
				method.rail_code,
				{
					label:
						method.rail_kind === "chain" ? (
							<NetworkLabel
								displayName={method.rail_name}
								network={method.rail_code}
							/>
						) : (
							<ProviderLabel
								kind={method.rail_kind}
								name={method.rail_name}
								provider={method.rail_code}
							/>
						),
					searchText: `${method.rail_name} ${method.rail_code}`,
					value: method.rail_code,
				},
			]),
		).values(),
	);
	const assets = available.filter((method) => method.rail_code === railCode);
	const selected = methods.filter((method) => methodIds.includes(method.id));
	const fields = configurationFields(kind, railCode);
	const update = (
		nextMethodIds: string[],
		nextConfiguration: Record<string, string>,
		nextMinAmount = minAmount,
		nextMaxAmount = maxAmount,
	) => {
		onChange(
			JSON.stringify({
				paymentMethodIds: nextMethodIds,
				configuration: nextConfiguration,
				minAmount: nextMinAmount,
				maxAmount: nextMaxAmount,
			}),
		);
	};
	return (
		<div className="grid gap-4">
			<div className="grid gap-1.5 text-sm font-medium">
				<span>{m.common_type()}</span>
				<Select
					ariaLabel={m.common_type()}
					value={kind}
					onChange={(value) => {
						const next = String(value) as typeof kind;
						setKind(next);
						setRailCode("");
						setMethodIds([]);
						setConfiguration({});
						setMinAmount("");
						setMaxAmount("");
						onChange("");
					}}
					options={[
						{ label: m.nav_networks(), value: "chain" },
						{ label: m.nav_exchanges(), value: "exchange" },
						{ label: m.nav_wallets(), value: "wallet" },
					]}
				/>
			</div>
			<div className="grid gap-1.5 text-sm font-medium">
				<span>{kindLabel(kind)}</span>
				<Select
					ariaLabel={kindLabel(kind)}
					value={railCode}
					onChange={(value) => {
						setRailCode(String(value ?? ""));
						setMethodIds([]);
						setConfiguration({});
						setMinAmount("");
						setMaxAmount("");
						onChange("");
					}}
					options={rails}
				/>
			</div>
			<div className="grid gap-1.5 text-sm font-medium">
				<span>{m.common_currency()}</span>
				<Select
					ariaLabel={m.common_currency()}
					value={methodIds}
					multiple
					onChange={(value) => {
						const next = Array.isArray(value) ? value.map(String) : [];
						setMethodIds(next);
						setConfiguration({});
						setMinAmount("");
						setMaxAmount("");
						update(next, {}, "", "");
					}}
					disabled={!railCode}
					options={assets.map((method) => ({
						searchText: `${method.asset_code} ${method.name}`,
						label: (
							<AssetLabel
								label={method.asset_code}
								network={method.rail_code}
								symbol={method.asset_code}
							/>
						),
						value: method.id,
					}))}
				/>
			</div>
			{methodIds.length
				? fields.map((field) => (
						<label
							htmlFor={`receiving-${field.name}`}
							key={field.name}
							className="grid gap-1.5 text-sm font-medium"
						>
							{field.label}
							<Input
								id={`receiving-${field.name}`}
								type={field.secret ? "password" : "text"}
								value={configuration[field.name] ?? ""}
								required
								onChange={(event) => {
									const next = {
										...configuration,
										[field.name]: event.target.value,
									};
									setConfiguration(next);
									update(methodIds, next);
								}}
							/>
							{field.description ? (
								<span className="font-normal text-muted-foreground text-xs">
									{field.description}
								</span>
							) : null}
						</label>
					))
				: null}
			{selected.length ? (
				<div className="grid gap-4 sm:grid-cols-2">
					<label
						htmlFor="receiving-min-amount"
						className="grid gap-1.5 text-sm font-medium"
					>
						{m.pro_field_minimumValue()} (USD)
						<Input
							id="receiving-min-amount"
							inputMode="decimal"
							suffix="USD"
							value={minAmount}
							onChange={(event) => {
								const next = event.target.value;
								setMinAmount(next);
								update(methodIds, configuration, next, maxAmount);
							}}
						/>
					</label>
					<label
						htmlFor="receiving-max-amount"
						className="grid gap-1.5 text-sm font-medium"
					>
						{m.pro_field_maximumValue()} (USD)
						<Input
							id="receiving-max-amount"
							inputMode="decimal"
							suffix="USD"
							value={maxAmount}
							onChange={(event) => {
								const next = event.target.value;
								setMaxAmount(next);
								update(methodIds, configuration, minAmount, next);
							}}
						/>
					</label>
				</div>
			) : null}
		</div>
	);
}

function kindLabel(kind: "chain" | "exchange" | "wallet") {
	if (kind === "chain") return m.nav_networks();
	if (kind === "exchange") return m.nav_exchanges();
	return m.nav_wallets();
}

function kindBadgeClass(kind: "chain" | "exchange" | "wallet") {
	if (kind === "chain")
		return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
	if (kind === "exchange")
		return "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300";
	return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

function configurationFields(
	kind: "chain" | "exchange" | "wallet",
	railCode?: string,
) {
	if (kind === "chain")
		return [
			{
				name: "address",
				label: m.receiving_address(),
				secret: false,
				description: undefined,
			},
		];
	if (railCode === "binance")
		return [
			{
				name: "receiverUid",
				label: m.receiving_binance_uid(),
				secret: false,
				description: m.receiving_binance_uid_help(),
			},
			{
				name: "apiKey",
				label: m.infrastructure_provider_api_key(),
				secret: true,
				description: m.receiving_binance_api_help(),
			},
			{
				name: "secretKey",
				label: m.infrastructure_provider_secret_key(),
				secret: true,
				description: m.receiving_secret_help(),
			},
		];
	if (railCode === "okx")
		return [
			{
				name: "accountUid",
				label: m.receiving_okx_uid(),
				secret: false,
				description: m.receiving_okx_uid_help(),
			},
			{
				name: "apiKey",
				label: m.infrastructure_provider_api_key(),
				secret: true,
				description: m.receiving_okx_api_help(),
			},
			{
				name: "secretKey",
				label: m.infrastructure_provider_secret_key(),
				secret: true,
				description: m.receiving_secret_help(),
			},
			{
				name: "passphrase",
				label: m.infrastructure_provider_passphrase(),
				secret: true,
				description: m.receiving_okx_passphrase_help(),
			},
		];
	if (railCode === "okpay")
		return [
			{
				name: "shopId",
				label: m.receiving_okpay_shop_id(),
				secret: false,
				description: m.receiving_okpay_id_help(),
			},
			{
				name: "apiKey",
				label: m.infrastructure_provider_api_key(),
				secret: true,
				description: m.receiving_okpay_api_help(),
			},
		];
	return [
		{
			name: kind === "exchange" ? "accountId" : "providerId",
			label:
				kind === "exchange"
					? m.receiving_account_id()
					: m.receiving_provider_id(),
			secret: false,
			description: undefined,
		},
	];
}

function parsePaymentConfiguration(value: string) {
	const parsed = JSON.parse(value) as {
		paymentMethodIds?: unknown;
		configuration?: unknown;
		minAmount?: unknown;
		maxAmount?: unknown;
	};
	if (
		!Array.isArray(parsed.paymentMethodIds) ||
		!parsed.paymentMethodIds.length ||
		!parsed.paymentMethodIds.every((item) => typeof item === "string") ||
		!parsed.configuration ||
		typeof parsed.configuration !== "object" ||
		Array.isArray(parsed.configuration)
	)
		throw paymentSettingsError("receiving_method_configuration_required");
	return {
		paymentMethodIds: parsed.paymentMethodIds,
		configuration: parsed.configuration as Record<string, string>,
		minAmount:
			typeof parsed.minAmount === "string" && parsed.minAmount.trim()
				? parsed.minAmount.trim()
				: undefined,
		maxAmount:
			typeof parsed.maxAmount === "string" && parsed.maxAmount.trim()
				? parsed.maxAmount.trim()
				: undefined,
	};
}

function optionalString(value: unknown) {
	const normalized = String(value ?? "").trim();
	return normalized || undefined;
}

function showError(error: unknown) {
	toast.error(paymentSettingsOperationErrorMessage(error));
}
