"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { ColorPicker } from "#/components/pro/base/fields/color-picker";
import { ProSchemaForm, type ProSchemaValueField } from "#/components/pro/form";
import { Button } from "#/components/ui/button";
import {
	SiteBackgroundField,
	SiteLogoField,
} from "#/features/settings/components/site-asset-field";
import { settingsErrorMessage } from "#/features/settings/error-message";
import {
	systemSettingsQueryKey,
	systemSettingsQueryOptions,
} from "#/features/settings/queries";
import { updateSystemSettingsFn } from "#/features/settings/server/admin";
import { PageHeader } from "#/layouts/components/page-header";
import { localeLabels, supportedLocales } from "#/lib/locales";
import { m } from "#/paraglide/messages";

const brandKeys = [
	"site.name",
	"site.default_locale",
	"site.support_url",
	"site.background_color",
] as const;

export function BrandSettingsPage() {
	const formId = "system-settings-brand";
	const client = useQueryClient();
	const router = useRouter();
	const query = useQuery(systemSettingsQueryOptions);
	const values = new Map(query.data?.map((item) => [item.key, item.value]));
	const invalidateSettings = async () => {
		await client.invalidateQueries({ queryKey: systemSettingsQueryKey });
		await router.invalidate({
			filter: (match) => match.routeId === "__root__",
		});
	};

	return (
		<div className="flex min-h-0 w-full flex-1 flex-col">
			<PageHeader
				title={m.settings_group_brand()}
				description={m.settings_group_brand_description()}
				actions={
					<Button form={formId} type="submit">
						<Save />
						{m.settings_save_changes()}
					</Button>
				}
			/>
			<div className="mt-6 min-h-0 flex-1 overflow-y-auto pe-3">
				<div className="grid w-full gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] xl:items-start">
					<div className="space-y-6">
						<SiteLogoField
							url={String(values.get("site.logo_url") ?? "")}
							onChanged={invalidateSettings}
						/>
						<SiteBackgroundField
							url={String(values.get("site.background_image_url") ?? "")}
							onChanged={invalidateSettings}
						/>
					</div>
					<ProSchemaForm
						id={formId}
						key={query.data?.map((item) => item.updatedAt).join(":")}
						schema={brandSchema}
						initialValues={Object.fromEntries(
							brandKeys.map((key) => [key, values.get(key)]),
						)}
						fieldsClassName="space-y-5"
						onFinish={async (formValues) => {
							await updateSystemSettingsFn({
								data: {
									items: brandKeys.map((key) => ({
										key,
										value: String(formValues[key] ?? "").trim(),
									})),
								},
							});
							await invalidateSettings();
							toast.success(m.settings_saved());
						}}
						onFinishFailed={(error) => toast.error(settingsErrorMessage(error))}
						submitter={false}
					/>
				</div>
			</div>
		</div>
	);
}

const brandSchema = [
	{
		name: "site.name",
		label: m.settings_product_name(),
		description: m.settings_product_name_description(),
		valueType: "text" as const,
		required: true,
	},
	{
		name: "site.default_locale",
		label: m.settings_default_language(),
		description: m.settings_default_language_description(),
		valueType: "select" as const,
		required: true,
		fieldProps: {
			options: supportedLocales.map((locale) => ({
				label: localeLabels[locale],
				value: locale,
			})),
		},
	},
	{
		name: "site.support_url",
		label: m.settings_base_support_url_label(),
		description: m.settings_support_url_description(),
		valueType: "text" as const,
		required: false,
	},
	{
		name: "site.background_color",
		label: m.settings_base_background_color_label(),
		description: m.settings_base_background_color_desc(),
		valueType: "text" as const,
		required: false,
		render: (valueField: ProSchemaValueField) => (
			<ColorPicker
				value={String(valueField.value ?? "")}
				onChange={valueField.onChange}
				label={m.settings_base_background_color_label()}
			/>
		),
	},
];
