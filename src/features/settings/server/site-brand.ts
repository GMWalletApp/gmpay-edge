import { z } from "zod";
import {
	defaultSiteBrand,
	type SiteBrand,
} from "#/features/settings/site-brand";
import { supportedLocales } from "#/lib/locales";
import { recordKvCacheMetric } from "#/server/cache-observability";

const cacheVersion = 1;
const cacheKey = `site-brand:v${cacheVersion}`;
const cacheTtlSeconds = 300;
const pendingLoads = new WeakMap<KVNamespace, Promise<SiteBrand>>();
const cacheGenerations = new WeakMap<KVNamespace, number>();
const brandSchema = z
	.object({
		name: z.string().min(1).max(80),
		logoUrl: z.string().max(2_048).refine(isSafeLogoUrl),
		title: z.string().min(1).max(80),
		supportUrl: z.string().max(2_048).refine(isSafeOptionalPublicUrl),
		backgroundColor: z.string().max(86).refine(isSafeBackgroundColor),
		backgroundImageUrl: z
			.string()
			.max(2_048)
			.refine(isSafeOptionalBackgroundImageUrl),
		defaultLocale: z.enum(supportedLocales),
	})
	.refine(({ name, title }) => name === title);
const cacheSchema = z.object({
	version: z.literal(cacheVersion),
	brand: brandSchema,
});

export async function loadSiteBrandOrDefault(
	db?: D1Database,
	cache?: KVNamespace,
) {
	if (!db) return defaultSiteBrand;
	try {
		return await loadSiteBrand(db, cache);
	} catch {
		// The install surface must remain available before its tables exist.
		return defaultSiteBrand;
	}
}

export async function loadSiteBrand(
	db: D1Database,
	cache?: KVNamespace,
): Promise<SiteBrand> {
	if (!cache) return querySiteBrand(db);
	const pending = pendingLoads.get(cache);
	if (pending) return pending;
	const generation = cacheGenerations.get(cache) ?? 0;
	const load = (async () => {
		const cached = await readCache(cache);
		if (cached) return cached;
		const brand = await querySiteBrand(db);
		if ((cacheGenerations.get(cache) ?? 0) === generation)
			await writeCache(cache, brand);
		return brand;
	})();
	pendingLoads.set(cache, load);
	try {
		return await load;
	} finally {
		if (pendingLoads.get(cache) === load) pendingLoads.delete(cache);
	}
}

export async function invalidateSiteBrandCache(cache?: KVNamespace) {
	if (!cache) return;
	cacheGenerations.set(cache, (cacheGenerations.get(cache) ?? 0) + 1);
	pendingLoads.delete(cache);
	const startedAt = performance.now();
	try {
		await cache.delete(cacheKey);
		recordKvCacheMetric(
			{ cache: "site_brand", operation: "delete", outcome: "success" },
			startedAt,
		);
	} catch {
		recordKvCacheMetric(
			{ cache: "site_brand", operation: "delete", outcome: "fallback" },
			startedAt,
		);
		// D1 remains authoritative when optional KV is unavailable.
	}
}

async function querySiteBrand(db: D1Database): Promise<SiteBrand> {
	const rows = await db
		.prepare(
			"SELECT key, value FROM system_settings WHERE key IN ('site.name', 'site.logo_url', 'site.support_url', 'site.background_color', 'site.background_image_url', 'site.default_locale')",
		)
		.all<{ key: string; value: string }>();
	const values = new Map(
		rows.results.map((row) => [row.key, parsePublicSetting(row.value)]),
	);
	const name = values.get("site.name") || defaultSiteBrand.name;
	const brand = brandSchema.safeParse({
		name,
		logoUrl: safeLogoUrl(values.get("site.logo_url")),
		title: name,
		supportUrl: safePublicUrl(values.get("site.support_url")),
		backgroundColor: values.get("site.background_color") || "",
		backgroundImageUrl: safeBackgroundImageUrl(
			values.get("site.background_image_url"),
		),
		defaultLocale:
			values.get("site.default_locale") || defaultSiteBrand.defaultLocale,
	});
	return brand.success ? brand.data : defaultSiteBrand;
}

async function readCache(cache: KVNamespace) {
	const startedAt = performance.now();
	try {
		const value = await cache.get(cacheKey);
		if (!value) {
			recordKvCacheMetric(
				{ cache: "site_brand", operation: "read", outcome: "miss" },
				startedAt,
			);
			return null;
		}
		const parsed = parseCache(value);
		recordKvCacheMetric(
			{
				cache: "site_brand",
				operation: "read",
				outcome: parsed ? "hit" : "corrupt",
			},
			startedAt,
		);
		return parsed;
	} catch {
		recordKvCacheMetric(
			{ cache: "site_brand", operation: "read", outcome: "fallback" },
			startedAt,
		);
		return null;
	}
}

function parseCache(value: string): SiteBrand | null {
	try {
		const parsed = cacheSchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data.brand : null;
	} catch {
		return null;
	}
}

async function writeCache(cache: KVNamespace, brand: SiteBrand) {
	const startedAt = performance.now();
	try {
		await cache.put(
			cacheKey,
			JSON.stringify({ version: cacheVersion, brand }),
			{
				expirationTtl: cacheTtlSeconds,
			},
		);
		recordKvCacheMetric(
			{ cache: "site_brand", operation: "write", outcome: "success" },
			startedAt,
		);
	} catch {
		recordKvCacheMetric(
			{ cache: "site_brand", operation: "write", outcome: "fallback" },
			startedAt,
		);
		// D1 remains authoritative when optional KV is unavailable.
	}
}

function parsePublicSetting(value: string) {
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "string" ? parsed.trim() : "";
	} catch {
		return "";
	}
}

function safeBackgroundImageUrl(value?: string) {
	if (/^\/api\/site-background(?:\?v=\d+)?$/.test(value ?? ""))
		return value ?? "";
	return safePublicUrl(value);
}

function safeLogoUrl(value?: string) {
	if (/^\/api\/site-logo(?:\?v=\d+)?$/.test(value ?? "")) return value ?? "";
	return safePublicUrl(value) || defaultSiteBrand.logoUrl;
}

function isSafeLogoUrl(value: string) {
	return (
		value === defaultSiteBrand.logoUrl ||
		/^\/api\/site-logo(?:\?v=\d+)?$/.test(value) ||
		isPublicUrl(value)
	);
}

function isSafeOptionalPublicUrl(value: string) {
	return value === "" || isPublicUrl(value);
}

function isSafeOptionalBackgroundImageUrl(value: string) {
	return (
		value === "" ||
		/^\/api\/site-background(?:\?v=\d+)?$/.test(value) ||
		isPublicUrl(value)
	);
}

function isSafeBackgroundColor(value: string) {
	return (
		value === "" ||
		/^(?:#[\da-f]{3,8}|(?:rgb|hsl)a?\([^)]{1,80}\))$/i.test(value)
	);
}

function isPublicUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

function safePublicUrl(value?: string) {
	if (!value) return "";
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:"
			? url.toString()
			: "";
	} catch {
		return "";
	}
}
