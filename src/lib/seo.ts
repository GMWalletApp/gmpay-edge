import { defaultSiteBrand } from "#/features/settings/site-brand";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { absoluteSiteUrl } from "./site-url";

type DefaultSeoInput = {
	title?: string;
	description?: string;
	path?: string;
	siteName?: string;
};

export function createDefaultSeoHead(input: DefaultSeoInput = {}) {
	const siteName = input.siteName ?? defaultSiteBrand.name;
	const title = input.title ?? `${siteName} – ${m.app_title_description()}`;
	const description = input.description ?? m.common_seo_description();
	const url = absoluteSiteUrl(input.path ?? "/");

	return {
		meta: [
			{
				title,
			},
			{
				name: "description",
				content: description,
			},
			{
				property: "og:type",
				content: "website",
			},
			{
				property: "og:site_name",
				content: siteName,
			},
			{
				property: "og:url",
				content: url,
			},
			{
				property: "og:locale",
				content: getLocale().replace("-", "_"),
			},
			{
				property: "og:title",
				content: title,
			},
			{
				property: "og:description",
				content: description,
			},
			{
				name: "twitter:card",
				content: "summary",
			},
			{
				name: "twitter:site",
				content: siteName,
			},
			{
				name: "twitter:title",
				content: title,
			},
			{
				name: "twitter:description",
				content: description,
			},
		],
		links: [
			{
				rel: "canonical",
				href: url,
			},
		],
	};
}

export function createHomeSeoHead(matches: readonly RouteLoaderMatch[]) {
	const siteName = siteNameFromMatches(matches);
	const head = createDefaultSeoHead({
		siteName,
		description: m.common_seo_description(),
		path: "/",
	});

	return {
		meta: head.meta,
		links: head.links,
	};
}

type RouteLoaderMatch = { loaderData?: unknown };

export function siteNameFromMatches(matches: readonly RouteLoaderMatch[]) {
	for (const match of matches) {
		const loaderData = match.loaderData;
		if (
			!loaderData ||
			typeof loaderData !== "object" ||
			!("name" in loaderData)
		)
			continue;
		const name = loaderData.name;
		if (typeof name === "string" && name.trim()) return name;
	}
	return defaultSiteBrand.name;
}
