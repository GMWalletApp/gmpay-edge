import { z } from "zod";
import {
	isRuntimeSecret,
	presentSettingValue,
	shouldPreserveRuntimeSecret,
} from "#/features/settings/secrecy";
import { invalidateSiteBrandCache } from "#/features/settings/server/site-brand";
import { DomainError } from "#/lib/domain-error";
import { supportedLocales } from "#/lib/locales";

export type SettingValue = string | number | boolean | string[];

const definitions = {
	"site.name": z.string().trim().min(1).max(80),
	"site.default_locale": z.enum(supportedLocales),
	"site.logo_url": z.string().max(2_048),
	"site.support_url": z.union([z.literal(""), z.url().max(2_048)]),
	"site.background_color": z.union([
		z.literal(""),
		z
			.string()
			.trim()
			.regex(/^(?:#[\da-f]{3,8}|(?:rgb|hsl)a?\([^)]{1,80}\))$/i),
	]),
	"site.background_image_url": z.union([
		z.literal(""),
		z.url().max(2_048),
		z.string().regex(/^\/api\/site-background(?:\?v=\d+)?$/),
	]),
	"orders.default_expiry_ms": z.number().int().min(60_000).max(86_400_000),
	"orders.max_expiry_ms": z.number().int().min(300_000).max(604_800_000),
	"payments.late_payment_policy": z.enum(["accept", "review", "reject"]),
	"security.allowed_hosts": z
		.array(
			z
				.string()
				.trim()
				.toLowerCase()
				.regex(
					/^(?:\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/,
					"Host must not include a scheme, path, query, or fragment",
				),
		)
		.max(100)
		.transform((hosts) => [...new Set(hosts)]),
	"webhooks.max_attempts": z.number().int().min(1).max(20),
	"webhooks.timeout_ms": z.number().int().min(1_000).max(30_000),
	"payments.scan_batch_size": z.number().int().min(1).max(100),
	"payments.scan_interval_ms": z.number().int().min(15_000).max(3_600_000),
	"payments.webhook_recovery_interval_ms": z
		.number()
		.int()
		.min(60_000)
		.max(3_600_000),
	"payments.rpc_health_interval_ms": z
		.number()
		.int()
		.min(60_000)
		.max(3_600_000),
	"payments.reorg_monitor_ms": z.number().int().min(3_600_000).max(604_800_000),
	"retention.audit_ms": z
		.number()
		.int()
		.min(2_592_000_000)
		.max(315_360_000_000),
	"runtime.better_auth_secret": z.string().min(32).max(512),
	"runtime.better_auth_url": z.url(),
	"runtime.api_key_pepper": z.string().min(16).max(512),
	"runtime.integration_config_secret": z.string().min(16).max(512),
} as const;

export type SettingKey = keyof typeof definitions;

const defaults: Record<SettingKey, SettingValue> = {
	"site.name": "GMPay Edge",
	"site.default_locale": "en-US",
	"site.logo_url": "",
	"site.support_url": "",
	"site.background_color": "",
	"site.background_image_url": "",
	"orders.default_expiry_ms": 900_000,
	"orders.max_expiry_ms": 86_400_000,
	"payments.late_payment_policy": "review",
	"security.allowed_hosts": [],
	"webhooks.max_attempts": 8,
	"webhooks.timeout_ms": 10_000,
	"payments.scan_batch_size": 100,
	"payments.scan_interval_ms": 60_000,
	"payments.webhook_recovery_interval_ms": 15 * 60_000,
	"payments.rpc_health_interval_ms": 15 * 60_000,
	"payments.reorg_monitor_ms": 86_400_000,
	"retention.audit_ms": 31_536_000_000,
	"runtime.better_auth_secret": "",
	"runtime.better_auth_url": "http://localhost:3000",
	"runtime.api_key_pepper": "",
	"runtime.integration_config_secret": "",
};

export async function listSystemSettings(db: D1Database) {
	const rows = await db
		.prepare("SELECT key, value, updated_at FROM system_settings ORDER BY key")
		.all<{ key: string; value: string; updated_at: number }>();
	const stored = new Map(rows.results.map((row) => [row.key, row]));
	return (Object.keys(definitions) as SettingKey[]).map((key) => {
		const row = stored.get(key);
		const value = row ? parseStored(row.value, defaults[key]) : defaults[key];
		return {
			key,
			...presentSettingValue(key, value),
			isDefault: !row,
			updatedAt: row ? new Date(row.updated_at).toISOString() : null,
		};
	});
}

export async function saveSystemSettings(
	items: Array<{ key: string; value: unknown }>,
	dependencies: {
		db: D1Database;
		cache?: KVNamespace;
		userId: string;
		requestId?: string | null;
		ipAddress?: string | null;
	},
) {
	if (new Set(items.map((item) => item.key)).size !== items.length)
		throw new DomainError("invalid_settings", 400, "Duplicate setting key");
	const parsed = items.flatMap((item) => {
		if (!(item.key in definitions))
			throw new DomainError("invalid_settings", 400, "Unknown setting key");
		const key = item.key as SettingKey;
		if (shouldPreserveRuntimeSecret(key, item.value)) return [];
		return [{ key, value: definitions[key].parse(item.value) as SettingValue }];
	});

	const now = Date.now();
	await dependencies.db.batch([
		...parsed.map((item) =>
			dependencies.db
				.prepare(`INSERT INTO system_settings
				(key, value, is_secret, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
				.bind(
					item.key,
					JSON.stringify(item.value),
					isRuntimeSecret(item.key) ? 1 : 0,
					dependencies.userId,
					now,
					now,
				),
		),
		dependencies.db
			.prepare(`INSERT INTO audit_logs
			(id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
			VALUES (?, ?, 'system_settings.updated', 'system_settings', NULL, ?, ?, ?, ?)`)
			.bind(
				crypto.randomUUID(),
				dependencies.userId,
				dependencies.requestId ?? null,
				dependencies.ipAddress ?? null,
				JSON.stringify({ updatedKeys: parsed.map((item) => item.key) }),
				now,
			),
	]);
	if (parsed.some(({ key }) => key.startsWith("site.")))
		await invalidateSiteBrandCache(dependencies.cache);
	return { updated: parsed.map((item) => item.key) };
}

function parseStored(value: string, fallback: SettingValue): SettingValue {
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			typeof parsed === "string" ||
			typeof parsed === "number" ||
			typeof parsed === "boolean"
		)
			return parsed;
		if (
			Array.isArray(parsed) &&
			parsed.every((item) => typeof item === "string")
		)
			return parsed;
		return fallback;
	} catch {
		return fallback;
	}
}
