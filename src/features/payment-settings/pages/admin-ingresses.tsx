"use client";

import {
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Activity, MoreHorizontal, Pencil } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { NetworkLabel, ProviderLabel } from "#/components/crypto-icons/labels";
import { ProButton } from "#/components/pro/base/button";
import { Input, Password } from "#/components/pro/base/fields/input";
import { Select } from "#/components/pro/base/fields/select";
import {
	FormItem,
	ModalForm,
	type ProSchemaValueField,
} from "#/components/pro/form";
import { ProTable } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
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
import {
	paymentConnectionHealthErrorMessage,
	paymentSettingsOperationErrorMessage,
} from "#/features/payment-settings/error-message";
import {
	createPaymentConnectionFn,
	getPaymentIngressesPageFn,
	setPaymentConnectionEnabledFn,
	testPaymentConnectionFn,
	updateChainConnectionFn,
	updateProviderConnectionFn,
} from "#/features/payment-settings/server/connection-functions";
import { webhookOperationErrorMessage } from "#/features/webhooks/error-message";
import {
	CreatePaymentEventSource,
	type EditableProviderWebhookIngress,
	EditPaymentEventSource,
} from "#/features/webhooks/pages/admin-event-sources";
import {
	reconcilePaymentEventSourceFn,
	updatePaymentEventSourceFn,
} from "#/features/webhooks/server/payment-event-sources";
import { useNavigation } from "#/layouts/components/navigation-context";
import { PageHeader } from "#/layouts/components/page-header";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type IngressRow = Awaited<
	ReturnType<typeof getPaymentIngressesPageFn>
>["ingresses"][number];

export const paymentIngressesQueryOptions = queryOptions({
	queryKey: ["admin", "payment-ingresses"],
	queryFn: () => getPaymentIngressesPageFn(),
	staleTime: 30_000,
});

export function PaymentIngressesPage() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "name" });
	const client = useQueryClient();
	const { permissions } = useNavigation();
	const canUpdateProviderWebhook = hasSystemPermission(
		permissions,
		systemPermission("payment_settings", "update"),
	);
	const canCreateConnection = hasSystemPermission(
		permissions,
		systemPermission("payment_settings", "create"),
	);
	const [configuringProvider, setConfiguringProvider] =
		useState<IngressRow | null>(null);
	const [editingChain, setEditingChain] = useState<IngressRow | null>(null);
	const [editingProviderWebhook, setEditingProviderWebhook] =
		useState<EditableProviderWebhookIngress | null>(null);
	const [newConnectionRailCode, setNewConnectionRailCode] = useState("");
	const page = useQuery(paymentIngressesQueryOptions);
	const rows = page.data?.ingresses ?? [];
	const rails = page.data?.rails ?? [];
	const refresh = () =>
		client.invalidateQueries({ queryKey: ["admin", "payment-ingresses"] });
	const toggle = useMutation({
		mutationFn: setPaymentConnectionEnabledFn,
		onSuccess: async () => {
			await refresh();
			toast.success(m.payment_config_saved());
		},
		onError: showError,
	});
	const test = useMutation({
		mutationFn: testPaymentConnectionFn,
		onSuccess: async (health) => {
			await refresh();
			if (health.healthy)
				toast.success(
					m.infrastructure_rpc_healthy({ latency: health.latencyMs ?? 0 }),
				);
			else toast.error(paymentConnectionHealthErrorMessage(health.errorCode));
		},
		onError: showError,
	});
	const updateProviderWebhook = useMutation({
		mutationFn: updatePaymentEventSourceFn,
		onSuccess: async () => {
			setEditingProviderWebhook(null);
			await refresh();
			toast.success(m.webhooks_source_updated());
		},
		onError: (error) => toast.error(webhookOperationErrorMessage(error)),
	});
	const reconcileProviderWebhook = useMutation({
		mutationFn: reconcilePaymentEventSourceFn,
		onSuccess: async () => {
			await refresh();
			toast.success(m.webhooks_source_reconciled());
		},
		onError: (error) => toast.error(webhookOperationErrorMessage(error)),
	});
	const columns: ColumnDef<IngressRow>[] = [
		{
			accessorKey: "enabled",
			header: m.common_enabled(),
			cell: ({ row }) => (
				<Switch
					aria-label={`${m.common_enabled()} · ${row.original.name}`}
					checked={Boolean(row.original.enabled)}
					disabled={
						toggle.isPending ||
						row.original.kind !== "chain" ||
						row.original.type === "provider_webhook"
					}
					onCheckedChange={(enabled) =>
						toggle.mutate({
							data: { id: row.original.id, enabled, kind: row.original.kind },
						})
					}
				/>
			),
		},
		{
			accessorKey: "kind",
			header: m.common_type(),
			cell: ({ row }) => kindLabel(row.original.kind),
		},
		{
			accessorKey: "name",
			header: m.common_name(),
			meta: { search: true },
			cell: ({ row }) =>
				row.original.type === "provider_webhook"
					? m.payment_ingress_event_push()
					: row.original.name,
		},
		{
			id: "access",
			header: m.infrastructure_access(),
			cell: ({ row }) => (
				<div className="grid min-w-0 gap-1">
					<div className="flex items-center gap-2">
						<span className="font-medium">
							{row.original.kind === "chain" ? (
								<NetworkLabel
									displayName={row.original.rail_name}
									network={row.original.rail_code}
								/>
							) : (
								<ProviderLabel
									kind={row.original.kind}
									name={row.original.rail_name}
									provider={row.original.rail_code}
								/>
							)}
						</span>
						<Badge
							variant="outline"
							className={transportBadgeClass(row.original.transport)}
						>
							{transportLabel(row.original.transport)}
						</Badge>
						{row.original.type === "provider_webhook" ? (
							<Badge variant="secondary">Alchemy</Badge>
						) : null}
					</div>
					<code className="max-w-96 truncate text-muted-foreground text-xs">
						{row.original.endpoint ?? m.common_not_configured()}
					</code>
				</div>
			),
		},
		{
			accessorKey: "priority",
			header: m.infrastructure_priority(),
			cell: ({ row }) =>
				row.original.type === "provider_webhook" ? "—" : row.original.priority,
		},
		{
			accessorKey: "health_status",
			header: m.infrastructure_health(),
			cell: ({ row }) =>
				row.original.kind === "chain" ? (
					<Badge
						variant={
							row.original.health_status === "healthy" ? "default" : "secondary"
						}
					>
						{healthStatusLabel(row.original.health_status)}
					</Badge>
				) : (
					<span className="text-muted-foreground">—</span>
				),
		},
		{
			id: "actions",
			header: m.common_actions(),
			cell: ({ row }) => {
				return (
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
								{row.original.type === "provider_webhook" ? (
									<>
										<DropdownMenuItem
											disabled={!canUpdateProviderWebhook}
											onClick={() =>
												setEditingProviderWebhook(
													providerWebhookEditValue(row.original),
												)
											}
										>
											<Pencil />
											{m.common_edit()}
										</DropdownMenuItem>
										<DropdownMenuItem
											disabled={
												!canUpdateProviderWebhook ||
												reconcileProviderWebhook.isPending
											}
											onClick={() =>
												reconcileProviderWebhook.mutate({
													data: { id: row.original.id },
												})
											}
										>
											<Activity />
											{m.webhooks_reconcile()}
										</DropdownMenuItem>
									</>
								) : (
									<DropdownMenuItem
										onClick={() =>
											row.original.kind === "chain"
												? setEditingChain(row.original)
												: setConfiguringProvider(row.original)
										}
									>
										<Pencil />
										{m.common_edit()}
									</DropdownMenuItem>
								)}
								{row.original.kind === "chain" &&
								row.original.type !== "provider_webhook" ? (
									<DropdownMenuItem
										disabled={test.isPending}
										onClick={() =>
											test.mutate({
												data: { id: row.original.id, kind: "chain" },
											})
										}
									>
										<Activity />
										{m.infrastructure_test_access()}
									</DropdownMenuItem>
								) : null}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				);
			},
		},
	];
	return (
		<>
			<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
				<PageHeader
					title={m.nav_connection_config()}
					description={m.infrastructure_rpc_description()}
					actions={
						canCreateConnection ? (
							<div className="flex flex-wrap gap-2">
								<CreatePaymentEventSource
									trigger={
										<ProButton variant="outline">
											{m.webhooks_add_event_source()}
										</ProButton>
									}
									onCreated={refresh}
								/>
								<ModalForm
									title={m.infrastructure_connection_new()}
									description={m.infrastructure_connection_new_description()}
									onOpenChange={(open) => {
										if (!open) setNewConnectionRailCode("");
									}}
									trigger={
										<ProButton>{m.infrastructure_connection_new()}</ProButton>
									}
									schema={[
										{ name: "name", label: m.common_name(), required: true },
										{
											name: "railCode",
											label: m.infrastructure_access_target(),
											required: true,
											render: (field) => (
												<Select
													ariaLabel={m.infrastructure_access_target()}
													required
													searchable
													value={String(field.value ?? "")}
													onChange={(value) => {
														const railCode =
															typeof value === "string" ? value : "";
														field.onChange(railCode);
														setNewConnectionRailCode(railCode);
													}}
													options={rails
														.filter((rail) => rail.kind === "chain")
														.map((rail) => ({
															label: (
																<NetworkLabel
																	displayName={rail.name}
																	network={rail.code}
																/>
															),
															searchText: `${rail.name} ${rail.code}`,
															value: rail.code,
														}))}
												/>
											),
										},
										{
											name: "transport",
											render: (field) => (
												<NewConnectionTransportFields
													field={field}
													showEvmScanConfig={isEvmRail(newConnectionRailCode)}
												/>
											),
										},
									]}
									initialValues={{ transport: "http" }}
									onFinish={async (values) => {
										await createPaymentConnectionFn({
											data: {
												name: String(values.name ?? ""),
												railCode: String(values.railCode ?? ""),
												type: "rpc",
												transport: String(values.transport ?? "http") as
													| "http"
													| "websocket",
												endpoint: String(values.endpoint ?? ""),
												apiKey: String(values.apiKey ?? "") || undefined,
												priority: Number(values.priority ?? 100),
												...(isEvmRail(String(values.railCode ?? ""))
													? evmScanConfigValues(values)
													: {}),
											},
										});
										await refresh();
									}}
									onFinishFailed={showError}
								/>
							</div>
						) : undefined
					}
				/>
				<ProTable
					initialState={tableUrlState.initialState}
					onChange={tableUrlState.onChange}
					className="min-h-0 flex-1"
					columns={columns}
					data={rows}
					loading={page.isPending}
					onRefresh={() => page.refetch()}
					toolbarSearch={{
						columnId: "name",
						placeholder: m.infrastructure_search_rpc(),
					}}
					table={{ stickyHeader: true }}
				/>
			</div>
			{configuringProvider ? (
				<ProviderConfigurationForm
					key={configuringProvider.id}
					connection={configuringProvider}
					open
					onOpenChange={(open) => {
						if (!open) setConfiguringProvider(null);
					}}
					onSaved={async () => {
						setConfiguringProvider(null);
						await refresh();
					}}
				/>
			) : null}
			{editingChain ? (
				<ChainConnectionForm
					key={editingChain.id}
					connection={editingChain}
					open
					onOpenChange={(open) => {
						if (!open) setEditingChain(null);
					}}
					onSaved={async () => {
						setEditingChain(null);
						await refresh();
					}}
				/>
			) : null}
			{editingProviderWebhook ? (
				<EditPaymentEventSource
					source={editingProviderWebhook}
					onClose={() => setEditingProviderWebhook(null)}
					onFinish={(data) => updateProviderWebhook.mutateAsync({ data })}
				/>
			) : null}
		</>
	);
}

function providerWebhookEditValue(
	ingress: IngressRow,
): EditableProviderWebhookIngress {
	if (!ingress.external_source_id || !ingress.mode)
		throw new Error("Provider Webhook ingress configuration is incomplete");
	return {
		id: ingress.id,
		externalSourceId: ingress.external_source_id,
		mode: ingress.mode,
		enabled: Boolean(ingress.enabled),
	};
}

function NewConnectionTransportFields({
	field,
	showEvmScanConfig,
}: {
	field: ProSchemaValueField;
	showEvmScanConfig: boolean;
}) {
	const transport = field.value === "websocket" ? "websocket" : "http";
	const [priority, setPriority] = useState("100");

	return (
		<div className="space-y-4">
			<FormItem label={m.infrastructure_transport()} required>
				<Select
					ariaLabel={m.infrastructure_transport()}
					required
					value={transport}
					onChange={(value) => {
						const nextTransport = value === "websocket" ? "websocket" : "http";
						field.onChange(nextTransport);
						setPriority(nextTransport === "websocket" ? "200" : "100");
					}}
					options={[
						{ label: "HTTPS", value: "http" },
						{ label: "WSS", value: "websocket" },
					]}
				/>
			</FormItem>
			<FormItem
				htmlFor="connection-endpoint"
				label={
					transport === "websocket"
						? m.infrastructure_wss_endpoint()
						: m.infrastructure_https_endpoint()
				}
				required
			>
				<Input id="connection-endpoint" name="endpoint" required type="url" />
			</FormItem>
			<FormItem
				htmlFor="connection-api-key"
				label={m.infrastructure_provider_api_key()}
			>
				<Password id="connection-api-key" name="apiKey" />
			</FormItem>
			<FormItem
				htmlFor="connection-priority"
				label={m.infrastructure_priority()}
				required
			>
				<Input
					id="connection-priority"
					name="priority"
					type="number"
					min={0}
					max={10000}
					required
					value={priority}
					onChange={(event) => setPriority(event.target.value)}
				/>
			</FormItem>
			{showEvmScanConfig ? <EvmScanConfigFields /> : null}
		</div>
	);
}

function ChainConnectionForm({
	connection,
	open,
	onOpenChange,
	onSaved,
}: {
	connection: IngressRow;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved: () => Promise<unknown>;
}) {
	return (
		<ModalForm
			open={open}
			onOpenChange={onOpenChange}
			title={m.infrastructure_edit_connection()}
			description={m.infrastructure_edit_connection_description()}
			schema={[
				{ name: "name", label: m.common_name(), required: true },
				{
					name: "transport",
					label: m.infrastructure_transport(),
					valueType: "select",
					required: true,
					fieldProps: {
						options: [
							{ label: "HTTPS", value: "http" },
							{ label: "WSS", value: "websocket" },
						],
					},
				},
				{
					name: "endpoint",
					label: m.infrastructure_https_endpoint(),
					required: true,
				},
				{
					name: "apiKey",
					label: m.infrastructure_provider_api_key(),
					valueType: "password",
					description: m.infrastructure_rpc_edit_key_description(),
				},
				{
					name: "clearApiKey",
					label: m.infrastructure_rpc_clear_key(),
					valueType: "checkbox",
				},
				{
					name: "priority",
					label: m.infrastructure_priority(),
					valueType: "text",
					required: true,
					fieldProps: { type: "number", min: 0, max: 10000 },
				},
				...(isEvmRail(connection.rail_code) ? evmScanConfigSchemaFields() : []),
			]}
			initialValues={{
				name: connection.name,
				transport: connection.transport,
				endpoint: connection.endpoint ?? "",
				priority: connection.priority,
				clearApiKey: false,
				...(isEvmRail(connection.rail_code)
					? {
							timeoutMs: connection.timeout_ms ?? 30_000,
							blockLookback: connection.block_lookback ?? 3000,
							logBlockRange: connection.log_block_range ?? 500,
							maxScanTransactions: connection.max_scan_transactions ?? 1000,
						}
					: {}),
			}}
			onFinish={async (values) => {
				await updateChainConnectionFn({
					data: {
						id: connection.id,
						name: String(values.name ?? ""),
						transport: String(values.transport ?? "http") as
							| "http"
							| "websocket",
						endpoint: String(values.endpoint ?? ""),
						apiKey: String(values.apiKey ?? "") || undefined,
						clearApiKey: String(values.clearApiKey ?? "false") === "true",
						priority: Number(values.priority ?? 100),
						...(isEvmRail(connection.rail_code)
							? evmScanConfigValues(values)
							: {}),
					},
				});
				await onSaved();
				toast.success(m.payment_config_saved());
			}}
			onFinishFailed={showError}
		/>
	);
}

function EvmScanConfigFields() {
	return (
		<div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
			{evmScanConfigSchemaFields().map((item) => (
				<FormItem
					key={item.name}
					htmlFor={`connection-${item.name}`}
					label={item.label}
				>
					<Input
						id={`connection-${item.name}`}
						name={item.name}
						{...item.fieldProps}
						defaultValue={String(item.initialValue)}
					/>
				</FormItem>
			))}
		</div>
	);
}

function evmScanConfigSchemaFields() {
	return [
		{
			name: "timeoutMs",
			label: m.infrastructure_evm_timeout_ms(),
			initialValue: 30_000,
			fieldProps: { type: "number", min: 1000, max: 30_000 },
		},
		{
			name: "blockLookback",
			label: m.infrastructure_evm_block_lookback(),
			initialValue: 3000,
			fieldProps: { type: "number", min: 1, max: 20_000 },
		},
		{
			name: "logBlockRange",
			label: m.infrastructure_evm_log_block_range(),
			initialValue: 500,
			fieldProps: { type: "number", min: 1, max: 20_000 },
		},
		{
			name: "maxScanTransactions",
			label: m.infrastructure_evm_max_scan_transactions(),
			initialValue: 1000,
			fieldProps: { type: "number", min: 1, max: 10_000 },
		},
	];
}

function evmScanConfigValues(values: Record<string, unknown>) {
	return {
		timeoutMs: Number(values.timeoutMs ?? 30_000),
		blockLookback: Number(values.blockLookback ?? 3000),
		logBlockRange: Number(values.logBlockRange ?? 500),
		maxScanTransactions: Number(values.maxScanTransactions ?? 1000),
	};
}

function isEvmRail(railCode: string) {
	return ["ethereum", "base", "bsc", "polygon"].includes(railCode);
}

function ProviderConfigurationForm({
	connection,
	open,
	onOpenChange,
	onSaved,
}: {
	connection: IngressRow;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved: () => Promise<unknown>;
}) {
	return (
		<ModalForm
			open={open}
			onOpenChange={onOpenChange}
			title={m.infrastructure_configure_provider()}
			description={m.infrastructure_configure_provider_description()}
			schema={[
				{ name: "name", label: m.common_name(), required: true },
				{
					name: "apiUrl",
					label: m.infrastructure_provider_api_url(),
					required: true,
				},
				{
					name: "priority",
					label: m.infrastructure_priority(),
					valueType: "text",
					required: true,
					fieldProps: { type: "number", min: 0, max: 10000 },
				},
			]}
			initialValues={{
				name: connection.name,
				apiUrl: connection.endpoint ?? providerDefaultUrl(connection.rail_code),
				priority: connection.priority,
			}}
			onFinish={async (values) => {
				await updateProviderConnectionFn({
					data: {
						id: connection.id,
						kind: connection.kind as "exchange" | "wallet",
						name: String(values.name ?? ""),
						endpoint: String(values.apiUrl ?? ""),
						priority: Number(values.priority ?? 100),
					},
				});
				await onSaved();
				toast.success(m.payment_config_saved());
			}}
			onFinishFailed={showError}
		/>
	);
}

function providerDefaultUrl(railCode: string) {
	if (railCode === "binance") return "https://api-gcp.binance.com";
	if (railCode === "okx") return "https://www.okx.com";
	return "https://api.okaypay.me/shop";
}

function kindLabel(kind: IngressRow["kind"]) {
	if (kind === "chain") return m.nav_networks();
	if (kind === "exchange") return m.nav_exchanges();
	return m.nav_wallets();
}

function transportBadgeClass(transport: IngressRow["transport"]) {
	if (transport === "websocket")
		return "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300";
	if (transport === "webhook")
		return "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300";
	return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

function transportLabel(transport: IngressRow["transport"]) {
	if (transport === "websocket") return "WSS";
	if (transport === "webhook") return "Webhook";
	return "HTTPS";
}

function healthStatusLabel(status: IngressRow["health_status"]) {
	if (status === "healthy") return m.infrastructure_healthy();
	if (status === "degraded") return m.infrastructure_health_degraded();
	if (status === "unhealthy") return m.infrastructure_unhealthy();
	return m.infrastructure_health_unknown();
}

function showError(error: unknown) {
	toast.error(paymentSettingsOperationErrorMessage(error));
}
