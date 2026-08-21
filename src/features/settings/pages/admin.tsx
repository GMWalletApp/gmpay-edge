"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Switch } from "#/components/pro/base/fields/checkbox";
import { ProSchemaForm } from "#/components/pro/form";
import { Button } from "#/components/ui/button";
import { settingsErrorMessage } from "#/features/settings/error-message";
import {
	systemSettingsQueryKey,
	systemSettingsQueryOptions,
} from "#/features/settings/queries";
import { updateSystemSettingsFn } from "#/features/settings/server/admin";
import type {
	SettingKey,
	SettingValue,
} from "#/features/settings/server/system-settings";
import {
	type SystemSettingUnit,
	systemSettingUnit,
} from "#/features/settings/units";
import { PageHeader } from "#/layouts/components/page-header";
import { m } from "#/paraglide/messages";

type Section = "general" | "security" | "operations" | "runtime";
const fields: Record<
	Section,
	Array<{
		key: SettingKey;
		label: string;
		description: string;
		type: "text" | "password" | "number" | "select" | "origins" | "switch";
		required?: boolean;
		options?: string[];
		min?: number;
		max?: number;
	}>
> = {
	general: [
		{
			key: "orders.immediate_release_mode",
			label: m.settings_immediate_release_mode(),
			description: m.settings_immediate_release_mode_description(),
			type: "switch",
		},
		{
			key: "orders.fixed_expiry_ms",
			label: m.settings_order_expiry(),
			description: m.settings_order_expiry_description(),
			type: "number",
		},
		{
			key: "orders.default_expiry_ms",
			label: m.settings_default_expiry(),
			description: m.settings_default_expiry_description(),
			type: "number",
		},
		{
			key: "orders.max_expiry_ms",
			label: m.settings_max_expiry(),
			description: m.settings_max_expiry_description(),
			type: "number",
		},
		{
			key: "payments.late_payment_policy",
			label: m.settings_late_payment_policy(),
			description: m.settings_late_payment_policy_description(),
			type: "select",
			options: ["accept", "review", "reject"],
		},
		{
			key: "payments.checkout_amount_decimals",
			label: m.settings_checkout_amount_decimals(),
			description: m.settings_checkout_amount_decimals_description(),
			type: "number",
			min: 2,
			max: 8,
		},
	],
	security: [
		{
			key: "security.allowed_hosts",
			label: m.settings_allowed_hosts(),
			description: m.settings_allowed_hosts_description(),
			type: "origins",
		},
		{
			key: "webhooks.max_attempts",
			label: m.settings_webhook_attempts(),
			description: m.settings_webhook_attempts_description(),
			type: "number",
		},
		{
			key: "webhooks.timeout_ms",
			label: m.settings_webhook_timeout(),
			description: m.settings_webhook_timeout_description(),
			type: "number",
		},
	],
	operations: [
		{
			key: "payments.scan_batch_size",
			label: m.settings_scan_batch_size(),
			description: m.settings_scan_batch_size_description(),
			type: "number",
		},
		{
			key: "payments.scan_interval_ms",
			label: m.settings_scan_interval(),
			description: m.settings_scan_interval_description(),
			type: "number",
		},
		{
			key: "payments.webhook_recovery_interval_ms",
			label: m.settings_webhook_recovery_interval(),
			description: m.settings_webhook_recovery_interval_description(),
			type: "number",
		},
		{
			key: "payments.rpc_health_interval_ms",
			label: m.settings_rpc_health_interval(),
			description: m.settings_rpc_health_interval_description(),
			type: "number",
		},
		{
			key: "payments.reorg_monitor_ms",
			label: m.settings_reorg_monitor(),
			description: m.settings_reorg_monitor_description(),
			type: "number",
		},
		{
			key: "retention.audit_ms",
			label: m.settings_audit_retention(),
			description: m.settings_audit_retention_description(),
			type: "number",
		},
	],
	runtime: [
		{
			key: "runtime.better_auth_url",
			label: m.settings_application_url(),
			description: m.settings_application_url_description(),
			type: "text",
		},
		{
			key: "runtime.better_auth_secret",
			label: m.settings_auth_secret(),
			description: m.settings_auth_secret_description(),
			type: "password",
		},
		{
			key: "runtime.api_key_pepper",
			label: m.settings_api_key_pepper(),
			description: m.settings_api_key_pepper_description(),
			type: "password",
		},
		{
			key: "runtime.integration_config_secret",
			label: m.settings_integration_secret(),
			description: m.settings_integration_secret_description(),
			type: "password",
		},
	],
};

export function SystemSettingsSection({ group }: { group: SettingsGroup }) {
	const section = sectionForGroup(group);
	const formId = `system-settings-${group}`;
	const client = useQueryClient();
	const query = useQuery(systemSettingsQueryOptions);
	const values = new Map(query.data?.map((item) => [item.key, item.value]));
	const configuredSecrets = new Map(
		query.data?.map((item) => [item.key, item.configured]),
	);
	const storedImmediateReleaseMode =
		values.get("orders.immediate_release_mode") === true;
	const [immediateReleaseMode, setImmediateReleaseMode] = useState(
		storedImmediateReleaseMode,
	);
	useEffect(
		() => setImmediateReleaseMode(storedImmediateReleaseMode),
		[storedImmediateReleaseMode],
	);
	const selected = fields[section].filter(
		(field) =>
			groupForSetting(field.key) === group &&
			orderSettingVisible(field.key, immediateReleaseMode),
	);
	const initialValues = Object.fromEntries(
		selected.map((field) => {
			const value =
				field.key === "orders.immediate_release_mode"
					? immediateReleaseMode
					: values.get(field.key);
			return [
				field.key,
				Array.isArray(value)
					? value.join("\n")
					: displaySettingValue(field.key, value),
			];
		}),
	);
	async function save(formValues: Record<string, unknown>) {
		await updateSystemSettingsFn({
			data: {
				items: selected.map((field) => ({
					key: field.key,
					value: storageSettingValue(
						field.key,
						normalizeValue(formValues[field.key], field.type),
					),
				})),
			},
		});
		await client.invalidateQueries({ queryKey: systemSettingsQueryKey });
		toast.success(m.settings_saved());
	}
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col">
			<PageHeader
				title={groupMeta(group).title}
				description={groupMeta(group).description}
				actions={
					<Button form={formId} type="submit">
						<Save />
						{m.settings_save_changes()}
					</Button>
				}
			/>
			<div className="mt-6 min-h-0 flex-1 overflow-y-auto pe-3">
				<div className="w-full space-y-6">
					<ProSchemaForm
						id={formId}
						key={`${group}-${immediateReleaseMode}-${query.data?.map((item) => item.updatedAt).join(":")}`}
						schema={settingsSchema(
							selected,
							configuredSecrets,
							setImmediateReleaseMode,
						)}
						initialValues={initialValues}
						onFinish={save}
						onFinishFailed={(error) => toast.error(settingsErrorMessage(error))}
						submitter={false}
					/>
				</div>
			</div>
		</div>
	);
}

function orderSettingVisible(key: SettingKey, immediateReleaseMode: boolean) {
	if (key === "orders.fixed_expiry_ms") return immediateReleaseMode;
	if (key === "orders.default_expiry_ms" || key === "orders.max_expiry_ms")
		return !immediateReleaseMode;
	return true;
}

type SettingsGroup =
	| "orders"
	| "payment"
	| "access"
	| "webhook"
	| "auth"
	| "secrets"
	| "scanning"
	| "retention";
function sectionForGroup(group: SettingsGroup): Section {
	if (["orders", "payment"].includes(group)) return "general";
	if (["access", "webhook"].includes(group)) return "security";
	if (["auth", "secrets"].includes(group)) return "runtime";
	return "operations";
}
function groupForSetting(key: SettingKey): SettingsGroup {
	if (key.startsWith("orders.")) return "orders";
	if (
		key === "payments.late_payment_policy" ||
		key === "payments.checkout_amount_decimals"
	)
		return "payment";
	if (key === "security.allowed_hosts") return "access";
	if (key.startsWith("webhooks.")) return "webhook";
	if (key === "runtime.better_auth_secret" || key === "runtime.better_auth_url")
		return "auth";
	if (key.startsWith("runtime.")) return "secrets";
	if (key.startsWith("retention.")) return "retention";
	return "scanning";
}
function groupMeta(group: SettingsGroup) {
	const values = {
		orders: [m.settings_group_orders(), m.settings_group_orders_description()],
		payment: [
			m.settings_group_payment(),
			m.settings_group_payment_description(),
		],
		access: [m.settings_group_access(), m.settings_group_access_description()],
		webhook: [
			m.settings_group_webhook(),
			m.settings_group_webhook_description(),
		],
		auth: [m.settings_group_auth(), m.settings_group_auth_description()],
		secrets: [
			m.settings_group_secrets(),
			m.settings_group_secrets_description(),
		],
		scanning: [
			m.settings_group_scanning(),
			m.settings_group_scanning_description(),
		],
		retention: [
			m.settings_group_retention(),
			m.settings_group_retention_description(),
		],
	} as const;
	return { title: values[group][0], description: values[group][1] };
}

function settingsSchema(
	selected: (typeof fields)[Section],
	configuredSecrets: Map<SettingKey, boolean | undefined>,
	setImmediateReleaseMode: (enabled: boolean) => void,
) {
	return selected.map((field) => {
		let fieldProps: Record<string, unknown> | undefined;
		if (field.type === "select")
			fieldProps = {
				options: (field.options ?? []).map((option) => ({
					label: settingOptionLabel(option),
					value: option,
				})),
			};
		else if (field.type === "origins") fieldProps = { rows: 6 };
		else if (field.type === "number")
			fieldProps = {
				inputMode: "numeric",
				suffix: displaySettingUnit(field.key),
				...(field.min == null ? {} : { min: field.min }),
				...(field.max == null ? {} : { max: field.max }),
			};
		else if (field.type === "password" && configuredSecrets.get(field.key))
			fieldProps = { placeholder: m.settings_secret_configured() };

		return {
			name: field.key,
			label: field.label,
			description: field.description,
			valueType:
				field.type === "switch"
					? ("switch" as const)
					: field.type === "select"
						? ("select" as const)
						: field.type === "password"
							? ("password" as const)
							: field.type === "origins"
								? ("textarea" as const)
								: ("text" as const),
			required: field.required ?? field.type !== "password",
			...(field.key === "orders.immediate_release_mode"
				? {
						render: (control: {
							value: unknown;
							onChange: (value: boolean) => void;
						}) => (
							<Switch
								id="orders-immediate-release-mode"
								aria-label={m.settings_immediate_release_mode()}
								value={control.value === true}
								onChange={(enabled) => {
									control.onChange(enabled);
									setImmediateReleaseMode(enabled);
								}}
							/>
						),
					}
				: {}),
			...(fieldProps ? { fieldProps } : {}),
		};
	});
}

function localizedUnit(unit: SystemSettingUnit | undefined) {
	if (unit === "milliseconds") return m.unit_milliseconds();
	return undefined;
}

const durationDisplay = {
	"orders.fixed_expiry_ms": { divisor: 60_000, unit: "minutes" },
	"orders.default_expiry_ms": { divisor: 60_000, unit: "minutes" },
	"orders.max_expiry_ms": { divisor: 3_600_000, unit: "hours" },
	"webhooks.timeout_ms": { divisor: 1_000, unit: "seconds" },
	"payments.scan_interval_ms": { divisor: 1_000, unit: "seconds" },
	"payments.webhook_recovery_interval_ms": {
		divisor: 1_000,
		unit: "seconds",
	},
	"payments.rpc_health_interval_ms": { divisor: 1_000, unit: "seconds" },
	"payments.reorg_monitor_ms": { divisor: 3_600_000, unit: "hours" },
	"retention.audit_ms": { divisor: 86_400_000, unit: "days" },
} as const;

function displaySettingValue(key: SettingKey, value: SettingValue | undefined) {
	const display = durationDisplay[key as keyof typeof durationDisplay];
	return display && typeof value === "number" ? value / display.divisor : value;
}

function storageSettingValue(key: SettingKey, value: SettingValue) {
	const display = durationDisplay[key as keyof typeof durationDisplay];
	return display && typeof value === "number" ? value * display.divisor : value;
}

function displaySettingUnit(key: SettingKey) {
	const display = durationDisplay[key as keyof typeof durationDisplay];
	if (!display) return localizedUnit(systemSettingUnit(key));
	if (display.unit === "seconds") return m.unit_seconds();
	if (display.unit === "minutes") return m.unit_minutes();
	if (display.unit === "hours") return m.unit_hours();
	return m.unit_days();
}

function settingOptionLabel(option: string) {
	if (option === "accept") return m.settings_policy_accept();
	if (option === "review") return m.settings_policy_review();
	if (option === "reject") return m.settings_policy_reject();
	return option;
}

function normalizeValue(
	value: unknown,
	type: "text" | "password" | "number" | "select" | "origins" | "switch",
): SettingValue {
	if (type === "switch") return value === true || value === "true";
	const text = String(value ?? "").trim();
	if (type === "number") return Number(text);
	if (type === "origins")
		return text
			.split(/\r?\n/)
			.map((item) => item.trim())
			.filter(Boolean);
	return text;
}
