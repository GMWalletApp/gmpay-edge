import type { RuntimeDatabase } from "#/server/runtime/types";

const requestSettingsKeys = [
	"runtime.better_auth_secret",
	"runtime.better_auth_url",
	"runtime.api_key_pepper",
	"runtime.integration_config_secret",
	"security.allowed_hosts",
] as const;

type RequestSettings = ReadonlyMap<string, string>;

const pendingSettings = new WeakMap<Request, Promise<RequestSettings>>();

/**
 * Load request-scoped settings once so authority and Better Auth share one D1
 * read. D1 remains authoritative; this memo only covers one request lifetime.
 */
export function loadRequestSettings(
	request: Request,
	db: RuntimeDatabase,
): Promise<RequestSettings> {
	const cached = pendingSettings.get(request);
	if (cached) return cached;
	const pending = db
		.prepare(
			`SELECT key, value FROM system_settings WHERE key IN (${requestSettingsKeys
				.map(() => "?")
				.join(",")})`,
		)
		.bind(...requestSettingsKeys)
		.all<{ key: string; value: string }>()
		.then((rows) => new Map(rows.results.map((row) => [row.key, row.value])));
	pendingSettings.set(request, pending);
	return pending;
}
