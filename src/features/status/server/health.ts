import { createIsolateSnapshot } from "#/server/isolate-snapshot";

export interface HealthComponent {
	key:
		| "database"
		| "edge_cache"
		| "webhook_queue"
		| "payment_queue"
		| "object_storage"
		| "receiving_methods";
	status: "operational" | "degraded" | "unavailable";
	detail:
		| "cloudflare_d1"
		| "cloudflare_kv"
		| "async_delivery"
		| "transaction_scanning"
		| "r2_storage"
		| "binding_missing"
		| "query_failed"
		| "read_failed"
		| "ready_receiving_methods";
	count?: number;
	latencyMs?: number;
}

export interface HealthReport {
	status: "ok" | "degraded";
	service: "gmpay-edge";
	version: "v1";
	time: string;
	components: HealthComponent[];
}

export const healthSnapshotTtlMs = 10_000;

const livenessBody = JSON.stringify({
	status: "ok",
	service: "gmpay-edge",
	version: "v1",
});
const methodNotAllowedBody = JSON.stringify({ error: "method_not_allowed" });

/**
 * Liveness proves only that this Worker can execute a request. It deliberately
 * avoids bindings so external monitors cannot amplify D1 or KV reads.
 */
export function handleLivenessRequest(request: Request): Response | null {
	const { pathname } = new URL(request.url);
	if (pathname !== "/healthz") return null;
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response(methodNotAllowedBody, {
			status: 405,
			headers: {
				allow: "GET, HEAD",
				"cache-control": "no-store",
				"content-length": String(methodNotAllowedBody.length),
				"content-type": "application/json; charset=utf-8",
				pragma: "no-cache",
			},
		});

	return new Response(request.method === "HEAD" ? null : livenessBody, {
		headers: {
			"cache-control": "no-store",
			"content-length": String(livenessBody.length),
			"content-type": "application/json; charset=utf-8",
			pragma: "no-cache",
		},
	});
}

const healthSnapshot = createIsolateSnapshot<HealthReport>(healthSnapshotTtlMs);

export function getHealthSnapshot(
	env: Partial<Env>,
	now = Date.now(),
): Promise<HealthReport> {
	const cacheKey = env.DB ?? env.CACHE;
	if (!cacheKey) return checkHealth(env);
	return healthSnapshot(cacheKey, () => checkHealth(env), now);
}

export async function checkHealth(env: Partial<Env>): Promise<HealthReport> {
	const [databaseResult, edgeCache] = await Promise.all([
		checkDatabaseAndReceivingMethods(env.DB),
		checkKv(env.CACHE),
	]);
	const components: HealthComponent[] = [
		databaseResult.database,
		edgeCache,
		bindingStatus("webhook_queue", env.WEBHOOK_QUEUE, "async_delivery"),
		bindingStatus("payment_queue", env.PAYMENT_QUEUE, "transaction_scanning"),
		bindingStatus("object_storage", env.FILES, "r2_storage"),
	];
	if (databaseResult.receivingMethods)
		components.push(databaseResult.receivingMethods);

	return {
		status: components.some((component) => component.status !== "operational")
			? "degraded"
			: "ok",
		service: "gmpay-edge",
		version: "v1",
		time: new Date().toISOString(),
		components,
	};
}

async function checkDatabaseAndReceivingMethods(db?: D1Database): Promise<{
	database: HealthComponent;
	receivingMethods: HealthComponent | null;
}> {
	if (!db)
		return {
			database: {
				key: "database",
				status: "unavailable",
				detail: "binding_missing",
			},
			receivingMethods: null,
		};
	const started = Date.now();
	try {
		const row = await db
			.prepare(
				`SELECT COUNT(*) AS receiving_count FROM receiving_methods rm
				 JOIN receiving_method_assets link
				  ON link.receiving_method_id = rm.id
				 JOIN payment_assets pa ON pa.id = link.payment_asset_id
				 JOIN payment_rails rail ON rail.code = pa.rail_code
				 WHERE rm.enabled = 1 AND rm.target_value != ''
				 AND EXISTS (SELECT 1 FROM payment_ingresses pc
				  WHERE pc.rail_code = pa.rail_code AND pc.enabled = 1
				  AND (rail.kind IN ('exchange', 'wallet')
				   OR pc.health_status IN ('healthy', 'degraded')))`,
			)
			.first<{ receiving_count: number }>();
		const count = row?.receiving_count ?? 0;
		return {
			database: {
				key: "database",
				status: "operational",
				detail: "cloudflare_d1",
				latencyMs: Date.now() - started,
			},
			receivingMethods: {
				key: "receiving_methods",
				status: count > 0 ? "operational" : "degraded",
				detail: "ready_receiving_methods",
				count,
			},
		};
	} catch {
		return {
			database: {
				key: "database",
				status: "unavailable",
				detail: "query_failed",
				latencyMs: Date.now() - started,
			},
			receivingMethods: {
				key: "receiving_methods",
				status: "unavailable",
				detail: "query_failed",
			},
		};
	}
}

async function checkKv(kv?: KVNamespace): Promise<HealthComponent> {
	if (!kv)
		return {
			key: "edge_cache",
			status: "unavailable",
			detail: "binding_missing",
		};
	const started = Date.now();
	try {
		await kv.get("health:probe");
		return {
			key: "edge_cache",
			status: "operational",
			detail: "cloudflare_kv",
			latencyMs: Date.now() - started,
		};
	} catch {
		return {
			key: "edge_cache",
			status: "unavailable",
			detail: "read_failed",
			latencyMs: Date.now() - started,
		};
	}
}

function bindingStatus(
	key: HealthComponent["key"],
	binding: unknown,
	detail: HealthComponent["detail"],
): HealthComponent {
	return {
		key,
		status: binding ? "operational" : "unavailable",
		detail: binding ? detail : "binding_missing",
	};
}
