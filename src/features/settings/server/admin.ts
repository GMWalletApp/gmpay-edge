import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { settingsAdminContext } from "#/features/settings/server/admin-context";
import {
	removeSiteAsset,
	uploadSiteAsset,
} from "#/features/settings/server/site-asset";
import {
	listSystemSettings,
	saveSystemSettings,
} from "#/features/settings/server/system-settings";
import { siteAssetContentTypes } from "#/features/settings/site-assets";
import { DomainError } from "#/lib/domain-error";

export const listSystemSettingsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db } = await settingsAdminContext(
			systemPermission("settings", "read"),
		);
		return listSystemSettings(db);
	},
);

const updateInput = z.object({
	items: z
		.array(
			z.object({
				key: z.string(),
				value: z.json(),
			}),
		)
		.min(1)
		.max(20),
});

export const updateSystemSettingsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof updateInput>) => updateInput.parse(input))
	.handler(async ({ data }) => {
		const context = await settingsAdminContext(
			systemPermission("settings", "update"),
		);
		return saveSystemSettings(data.items, {
			db: context.db,
			cache: context.env.CACHE,
			userId: context.user.id,
			requestId: context.request.headers.get("x-request-id"),
			ipAddress: context.request.headers.get("cf-connecting-ip"),
		});
	});

const siteLogoInput = z.object({
	contentType: z.enum(siteAssetContentTypes),
	base64: z.string().max(4_000_000),
});

export const uploadSiteLogoFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof siteLogoInput>) =>
		siteLogoInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await settingsAdminContext(
			systemPermission("settings", "update"),
		);
		return uploadSiteAsset("logo", data, siteAssetDependencies(context));
	});

export const removeSiteLogoFn = createServerFn({ method: "POST" }).handler(
	async () => {
		const context = await settingsAdminContext(
			systemPermission("settings", "update"),
		);
		return removeSiteAsset("logo", siteAssetDependencies(context));
	},
);

const siteBackgroundInput = z.object({
	contentType: z.enum(siteAssetContentTypes),
	base64: z.string().max(8_000_000),
});

export const uploadSiteBackgroundFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof siteBackgroundInput>) =>
		siteBackgroundInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await settingsAdminContext(
			systemPermission("settings", "update"),
		);
		return uploadSiteAsset("background", data, siteAssetDependencies(context));
	});

export const removeSiteBackgroundFn = createServerFn({
	method: "POST",
}).handler(async () => {
	const context = await settingsAdminContext(
		systemPermission("settings", "update"),
	);
	return removeSiteAsset("background", siteAssetDependencies(context));
});

function siteAssetDependencies(
	context: Awaited<ReturnType<typeof settingsAdminContext>>,
) {
	if (!context.env.FILES)
		throw new DomainError(
			"site_asset_storage_unavailable",
			503,
			"Site asset storage is unavailable",
		);
	return {
		db: context.db,
		bucket: context.env.FILES,
		cache: context.env.CACHE,
		userId: context.user.id,
		requestId: context.request.headers.get("x-request-id"),
		ipAddress: context.request.headers.get("cf-connecting-ip"),
	};
}
