import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Settings2, Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ModalForm } from "#/components/pro/form";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
import { Switch } from "#/components/ui/switch";
import {
	createTelegramNotificationBindingFn,
	deleteTelegramNotificationBindingFn,
	listTelegramNotificationsFn,
	setTelegramNotificationEnabledFn,
	type TelegramNotificationBindingRecord,
	updateTelegramDefaultsFn,
	updateTelegramNotificationBindingFn,
} from "#/features/telegram/server/notifications-admin";
import { WebhookEventMatrix } from "#/features/webhooks/components/event-matrix";
import { webhookEventLabel } from "#/features/webhooks/event-label";
import { PageHeader } from "#/layouts/components/page-header";
import {
	localeLabels,
	type SupportedLocale,
	supportedLocales,
} from "#/lib/locales";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";
import {
	eventValues,
	isWebhookEventType,
	showTelegramError,
	telegramOptionLabel,
	templateContentFormField,
	templateTranslations,
} from "./form-fields";

type NotificationConfiguration = {
	bots: { id: string; name: string }[];
	defaults: {
		events: string[];
		templateTranslations: Record<SupportedLocale, string>;
	};
};

const emptyConfiguration: NotificationConfiguration = {
	bots: [],
	defaults: {
		events: ["*"],
		templateTranslations: Object.fromEntries(
			supportedLocales.map((locale) => [locale, ""]),
		) as Record<SupportedLocale, string>,
	},
};

export function TelegramNotificationsPage() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "name" });
	const client = useQueryClient();
	const [refreshKey, setRefreshKey] = useState(0);
	const [configuration, setConfiguration] =
		useState<NotificationConfiguration>(emptyConfiguration);
	const snapshotRef = useRef<{ key: string; at: number } | null>(null);
	const refresh = async () => {
		snapshotRef.current = null;
		await client.invalidateQueries({
			queryKey: ["admin", "telegram", "notifications"],
		});
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
			const result = await client.fetchQuery({
				queryKey: ["admin", "telegram", "notifications", input],
				queryFn: () => listTelegramNotificationsFn({ data: input }),
			});
			setConfiguration({
				bots: result.bots,
				defaults: result.defaults,
			});
			return { data: result.data, total: result.total };
		},
		[client],
	);
	const remove = useMutation({
		mutationFn: deleteTelegramNotificationBindingFn,
		onSuccess: refresh,
		onError: showTelegramError,
	});
	const toggle = useMutation({
		mutationFn: setTelegramNotificationEnabledFn,
		onSuccess: refresh,
		onError: showTelegramError,
	});
	const columns: ColumnDef<TelegramNotificationBindingRecord>[] = [
		{
			accessorKey: "enabled",
			header: m.common_enabled(),
			cell: ({ row }) => (
				<Switch
					aria-label={`${m.common_enabled()} · ${row.original.name}`}
					checked={row.original.enabled}
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
				<div>
					<div>{row.original.name}</div>
					{row.original.targetUsername ? (
						<div className="text-muted-foreground text-xs">
							@{row.original.targetUsername}
						</div>
					) : null}
				</div>
			),
		},
		{ accessorKey: "botName", header: m.telegram_bot() },
		{ accessorKey: "locale", header: m.telegram_locale() },
		{
			accessorKey: "targetId",
			header: m.telegram_target_id(),
			cell: ({ row }) => (
				<div>
					<Badge variant="outline">
						{telegramOptionLabel(row.original.targetType)}
					</Badge>
					<code className="ml-2 text-xs">{row.original.targetId}</code>
				</div>
			),
		},
		{
			accessorKey: "events",
			header: m.telegram_events(),
			cell: ({ row }) => (
				<div className="flex max-w-md flex-wrap gap-1">
					{row.original.events.map((event) => (
						<Badge key={event} variant="secondary">
							{webhookEventLabel(event)}
						</Badge>
					))}
				</div>
			),
		},
		{
			id: "actions",
			header: m.common_actions(),
			cell: ({ row }) => (
				<div className="flex justify-end gap-1">
					<EditNotification notification={row.original} onUpdated={refresh} />
					<ProButton
						size="icon-sm"
						variant="ghost"
						tooltip={m.common_delete()}
						disabled={remove.isPending}
						onClick={() => remove.mutate({ data: { id: row.original.id } })}
					>
						<Trash2 />
					</ProButton>
				</div>
			),
		},
	];

	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				title={m.nav_telegram_subscriptions()}
				description={m.telegram_notifications_description()}
				actions={
					<div className="flex gap-2">
						<DefaultSubscriptions
							configuration={configuration}
							onSaved={refresh}
						/>
						<CreateNotification
							configuration={configuration}
							onCreated={refresh}
						/>
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
				toolbarSearch={{
					columnId: "name",
					placeholder: m.telegram_search_bindings(),
				}}
				table={{ stickyHeader: true }}
			/>
		</div>
	);
}

function DefaultSubscriptions({
	configuration,
	onSaved,
}: {
	configuration: NotificationConfiguration;
	onSaved: () => Promise<unknown>;
}) {
	return (
		<ModalForm
			title={m.telegram_default_subscriptions()}
			description={m.telegram_default_subscriptions_description()}
			modalClassName="sm:max-w-3xl"
			trigger={
				<ProButton variant="outline">
					<Settings2 />
					{m.system_nav_settings()}
				</ProButton>
			}
			initialValues={{
				events: configuration.defaults.events,
				templateTranslations: JSON.stringify(
					configuration.defaults.templateTranslations,
				),
			}}
			schema={[
				{
					name: "events",
					label: m.telegram_events(),
					render: (field) => (
						<WebhookEventMatrix
							flatItems
							value={eventValues(field.value)}
							onChange={field.onChange}
						/>
					),
				},
				templateContentFormField("templateTranslations", false),
			]}
			onFinish={async (values) => {
				await updateTelegramDefaultsFn({
					data: {
						templateTranslations: templateTranslations(
							values.templateTranslations,
						),
						events: eventValues(values.events).filter(isWebhookEventType),
					},
				});
				await onSaved();
				toast.success(m.payment_config_saved());
			}}
			onFinishFailed={showTelegramError}
		/>
	);
}

function CreateNotification({
	configuration,
	onCreated,
}: {
	configuration: NotificationConfiguration;
	onCreated: () => Promise<unknown>;
}) {
	return (
		<ModalForm
			title={m.common_new()}
			description={m.telegram_add_binding_description()}
			modalClassName="sm:max-w-3xl"
			fieldsClassName="grid gap-4 space-y-0 sm:grid-cols-2"
			trigger={<ProButton>{m.common_new()}</ProButton>}
			schema={[
				{ name: "name", label: m.common_name(), required: true },
				{
					name: "locale",
					label: m.telegram_locale(),
					valueType: "select",
					required: true,
					fieldProps: {
						options: supportedLocales.map((value) => ({
							label: localeLabels[value],
							value,
						})),
					},
				},
				{
					name: "botId",
					label: m.telegram_bot(),
					valueType: "select",
					required: true,
					fieldProps: {
						options: configuration.bots.map((bot) => ({
							label: bot.name,
							value: bot.id,
						})),
					},
				},
				{
					name: "targetType",
					label: m.telegram_target_type(),
					valueType: "select",
					required: true,
					fieldProps: {
						options: ["private", "group", "channel"].map((value) => ({
							label: telegramOptionLabel(value),
							value,
						})),
					},
				},
				{
					name: "targetId",
					label: m.telegram_target_id(),
					required: true,
					formItemProps: { className: "sm:col-span-2" },
				},
				{
					name: "events",
					label: m.telegram_events(),
					required: true,
					formItemProps: { className: "sm:col-span-2" },
					render: (field) => (
						<WebhookEventMatrix
							flatItems
							value={eventValues(field.value)}
							onChange={field.onChange}
						/>
					),
				},
				{
					...templateContentFormField("templateTranslations"),
					formItemProps: { className: "sm:col-span-2" },
				},
			]}
			initialValues={{
				events: ["*"],
				locale: "en-US",
				targetType: "private",
				templateTranslations: JSON.stringify(
					configuration.defaults.templateTranslations,
				),
			}}
			onFinish={async (values) => {
				await createTelegramNotificationBindingFn({
					data: {
						botId: String(values.botId ?? ""),
						templateTranslations: templateTranslations(
							values.templateTranslations,
						),
						name: String(values.name ?? ""),
						targetType: String(values.targetType ?? "private") as
							| "private"
							| "group"
							| "channel",
						targetId: String(values.targetId ?? ""),
						locale: String(values.locale ?? "en-US") as SupportedLocale,
						events: eventValues(values.events).filter(isWebhookEventType),
					},
				});
				await onCreated();
				toast.success(m.telegram_binding_added());
			}}
			onFinishFailed={showTelegramError}
		/>
	);
}

function EditNotification({
	notification,
	onUpdated,
}: {
	notification: TelegramNotificationBindingRecord;
	onUpdated: () => Promise<unknown>;
}) {
	return (
		<ModalForm
			title={m.common_edit()}
			description={m.telegram_notifications_description()}
			modalClassName="sm:max-w-3xl"
			trigger={
				<ProButton size="icon-sm" variant="ghost" tooltip={m.common_edit()}>
					<Settings2 />
				</ProButton>
			}
			schema={[
				{
					name: "locale",
					label: m.telegram_locale(),
					valueType: "select",
					required: true,
					fieldProps: {
						options: supportedLocales.map((value) => ({
							label: localeLabels[value],
							value,
						})),
					},
				},
				{
					name: "events",
					label: m.telegram_events(),
					required: true,
					render: (field) => (
						<WebhookEventMatrix
							flatItems
							value={eventValues(field.value)}
							onChange={field.onChange}
						/>
					),
				},
				templateContentFormField("templateTranslations"),
			]}
			initialValues={{
				events: notification.events,
				locale: notification.locale,
				templateTranslations: JSON.stringify(notification.templateTranslations),
			}}
			onFinish={async (values) => {
				await updateTelegramNotificationBindingFn({
					data: {
						id: notification.id,
						templateTranslations: templateTranslations(
							values.templateTranslations,
						),
						locale: String(values.locale ?? "en-US") as SupportedLocale,
						events: eventValues(values.events).filter(isWebhookEventType),
					},
				});
				await onUpdated();
				toast.success(m.payment_config_saved());
			}}
			onFinishFailed={showTelegramError}
		/>
	);
}
