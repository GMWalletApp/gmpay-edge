import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { paymentSettingsPermission } from "#/features/access/system-rbac";
import { paymentSettingsError } from "#/features/payment-settings/errors";
import {
	createPaymentConnectionInput,
	paymentConnectionIdInput,
	updateChainPaymentConnectionInput,
	updateProviderPaymentConnectionInput,
} from "#/features/payment-settings/schema";
import { adminContext } from "#/features/payment-settings/server/admin-context";
import { testPaymentConnection } from "#/features/payment-settings/server/connection-health";

const railKindSchema = z.enum(["chain", "exchange", "wallet"]);
type RailKind = z.infer<typeof railKindSchema>;
const evmRailCodes = new Set(["ethereum", "base", "bsc", "polygon"]);

type PaymentIngressRow = {
	id: string;
	name: string;
	rail_code: string;
	rail_name: string;
	kind: RailKind;
	type: "rpc" | "provider" | "provider_webhook";
	transport: "http" | "websocket" | "webhook";
	endpoint: string | null;
	priority: number;
	enabled: number;
	health_status: "unknown" | "healthy" | "degraded" | "unhealthy";
	last_latency_ms: number | null;
	last_checked_at: number | null;
	last_error_code: string | null;
	timeout_ms: number | null;
	block_lookback: number | null;
	log_block_range: number | null;
	max_scan_transactions: number | null;
	has_api_key: number;
	external_source_id: string | null;
	mode: "shadow" | "active" | null;
};

type PaymentRailRow = {
	code: string;
	name: string;
	kind: RailKind;
};

export const getPaymentIngressesPageFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await adminContext(paymentSettingsPermission("read"));
	const [ingresses, rails] = await db.batch([
		db.prepare(
			`SELECT pc.id, pc.name, COALESCE(pc.rail_code, pc.network) AS rail_code,
				 COALESCE(pr.name, pc.network) AS rail_name, pr.kind,
				 pc.type, pc.transport, COALESCE(pc.endpoint, pc.external_source_id) AS endpoint,
				 pc.priority, pc.enabled, pc.health_status,
				 pc.last_latency_ms, pc.last_checked_at, pc.last_error_code,
				 pc.timeout_ms, pc.block_lookback, pc.log_block_range, pc.max_scan_transactions,
				 pc.external_source_id, pc.mode,
				 CASE WHEN pc.api_key IS NOT NULL AND pc.api_key != '' THEN 1 ELSE 0 END AS has_api_key
				 FROM payment_ingresses pc
				 JOIN payment_rails pr ON pr.code = COALESCE(pc.rail_code, pc.network)
				 ORDER BY pr.kind, pc.rail_code, pc.priority, pc.name`,
		),
		db.prepare(
			"SELECT code, name, kind FROM payment_rails ORDER BY kind, name",
		),
	]);
	return {
		ingresses: (ingresses as D1Result<PaymentIngressRow>).results,
		rails: (rails as D1Result<PaymentRailRow>).results,
	};
});

export const updateProviderConnectionFn = createServerFn({ method: "POST" })
	.validator(
		(
			input: z.input<typeof updateProviderPaymentConnectionInput> & {
				kind: "exchange" | "wallet";
			},
		) =>
			updateProviderPaymentConnectionInput
				.extend({ kind: z.enum(["exchange", "wallet"]) })
				.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(paymentSettingsPermission("update"));
		const connection = await context.db
			.prepare(
				`SELECT connection.rail_code, connection.endpoint, rail.kind
				 FROM payment_ingresses connection
				 JOIN payment_rails rail ON rail.code = connection.rail_code
				 WHERE connection.id = ? AND connection.type = 'provider' LIMIT 1`,
			)
			.bind(data.id)
			.first<{
				rail_code: string;
				endpoint: string | null;
				kind: "chain" | "exchange" | "wallet";
			}>();
		if (!connection || connection.kind !== data.kind)
			throw paymentSettingsError("payment_connection_not_found");
		const connectivityChanged = connection.endpoint !== data.endpoint;
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare(
					`UPDATE payment_ingresses
					 SET name = ?, endpoint = ?, priority = ?, enabled = ?,
					 health_status = ?, last_checked_at = ?, last_latency_ms = ?,
					 last_error_code = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.bind(
					data.name,
					data.endpoint,
					data.priority,
					true,
					"unknown",
					null,
					null,
					null,
					now,
					data.id,
				),
			context.db
				.prepare(
					`INSERT INTO audit_logs
					 (id, actor_user_id, action, target_type, target_id, request_id,
					  ip_address, after, created_at)
					 VALUES (?, ?, 'payment_connection.updated', 'payment_connection',
					  ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					context.user.id,
					data.id,
					context.request.headers.get("x-request-id"),
					context.request.headers.get("cf-connecting-ip"),
					JSON.stringify({
						railCode: connection.rail_code,
						name: data.name,
						endpoint: data.endpoint,
						priority: data.priority,
						connectivityChanged,
					}),
					now,
				),
		]);
		return { id: data.id, connectivityChanged };
	});

export const updateChainConnectionFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof updateChainPaymentConnectionInput>) =>
		updateChainPaymentConnectionInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(paymentSettingsPermission("update"));
		const current = await context.db
			.prepare(
				`SELECT connection.name, connection.rail_code, connection.transport,
				 connection.endpoint, connection.api_key, connection.priority,
				 connection.enabled, connection.health_status,
				 connection.last_checked_at, connection.last_latency_ms,
				 connection.last_error_code, connection.timeout_ms,
				 connection.block_lookback, connection.log_block_range,
				 connection.max_scan_transactions, rail.kind
				 FROM payment_ingresses connection
				 JOIN payment_rails rail ON rail.code = connection.rail_code
				 WHERE connection.id = ? AND connection.type = 'rpc' LIMIT 1`,
			)
			.bind(data.id)
			.first<{
				name: string;
				rail_code: string;
				transport: "http" | "websocket";
				endpoint: string | null;
				api_key: string | null;
				priority: number;
				enabled: number;
				health_status: "unknown" | "healthy" | "degraded" | "unhealthy";
				last_checked_at: number | null;
				last_latency_ms: number | null;
				last_error_code: string | null;
				timeout_ms: number | null;
				block_lookback: number | null;
				log_block_range: number | null;
				max_scan_transactions: number | null;
				kind: "chain" | "exchange" | "wallet";
			}>();
		if (!current || current.kind !== "chain")
			throw paymentSettingsError("payment_connection_not_found");
		if (
			data.transport === "websocket" &&
			!["ethereum", "base", "bsc", "polygon", "solana"].includes(
				current.rail_code,
			)
		)
			throw paymentSettingsError("payment_connection_transport_unsupported");
		const replacementApiKey = data.apiKey?.trim() || null;
		const credentialChanged = data.clearApiKey || replacementApiKey !== null;
		const connectivityChanged =
			current.transport !== data.transport ||
			current.endpoint !== data.endpoint ||
			credentialChanged;
		const nextApiKey = data.clearApiKey
			? null
			: (replacementApiKey ?? current.api_key);
		const scanConfig = evmRailCodes.has(current.rail_code)
			? data
			: {
					timeoutMs: undefined,
					blockLookback: undefined,
					logBlockRange: undefined,
					maxScanTransactions: undefined,
				};
		const now = Date.now();
		await context.db.batch([
			context.db
				.prepare(
					`UPDATE payment_ingresses SET
					 name = ?, transport = ?, endpoint = ?, api_key = ?, priority = ?,
					 timeout_ms = ?, block_lookback = ?, log_block_range = ?,
					 max_scan_transactions = ?,
					 enabled = ?, health_status = ?, last_checked_at = ?,
					 last_latency_ms = ?, last_error_code = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.bind(
					data.name,
					data.transport,
					data.endpoint,
					nextApiKey,
					data.priority,
					scanConfig.timeoutMs ?? null,
					scanConfig.blockLookback ?? null,
					scanConfig.logBlockRange ?? null,
					scanConfig.maxScanTransactions ?? null,
					connectivityChanged ? 0 : current.enabled,
					connectivityChanged ? "unknown" : current.health_status,
					connectivityChanged ? null : current.last_checked_at,
					connectivityChanged ? null : current.last_latency_ms,
					connectivityChanged ? null : current.last_error_code,
					now,
					data.id,
				),
			context.db
				.prepare(
					`INSERT INTO audit_logs
					 (id, actor_user_id, action, target_type, target_id, request_id,
					  ip_address, before, after, created_at)
					 VALUES (?, ?, 'payment_connection.updated', 'payment_connection',
					  ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					context.user.id,
					data.id,
					context.request.headers.get("x-request-id"),
					context.request.headers.get("cf-connecting-ip"),
					JSON.stringify({
						name: current.name,
						transport: current.transport,
						endpoint: current.endpoint,
						priority: current.priority,
						timeoutMs: current.timeout_ms,
						blockLookback: current.block_lookback,
						logBlockRange: current.log_block_range,
						maxScanTransactions: current.max_scan_transactions,
						hasApiKey: Boolean(current.api_key),
					}),
					JSON.stringify({
						name: data.name,
						transport: data.transport,
						endpoint: data.endpoint,
						priority: data.priority,
						timeoutMs: scanConfig.timeoutMs ?? null,
						blockLookback: scanConfig.blockLookback ?? null,
						logBlockRange: scanConfig.logBlockRange ?? null,
						maxScanTransactions: scanConfig.maxScanTransactions ?? null,
						hasApiKey: Boolean(nextApiKey),
						connectivityChanged,
					}),
					now,
				),
		]);
		return { id: data.id, connectivityChanged };
	});

export const createPaymentConnectionFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof createPaymentConnectionInput>) =>
		createPaymentConnectionInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(paymentSettingsPermission("create"));
		const rail = await context.db
			.prepare("SELECT kind FROM payment_rails WHERE code = ? LIMIT 1")
			.bind(data.railCode)
			.first<{ kind: "chain" | "exchange" | "wallet" }>();
		if (!rail) throw paymentSettingsError("payment_rail_not_found");
		if (rail.kind !== "chain")
			throw paymentSettingsError("payment_rail_connection_managed");
		if (
			data.transport === "websocket" &&
			!["ethereum", "base", "bsc", "polygon", "solana"].includes(data.railCode)
		)
			throw paymentSettingsError("payment_connection_transport_unsupported");
		const id = crypto.randomUUID();
		const now = Date.now();
		const scanConfig = evmRailCodes.has(data.railCode)
			? data
			: {
					timeoutMs: undefined,
					blockLookback: undefined,
					logBlockRange: undefined,
					maxScanTransactions: undefined,
				};
		await context.db
			.prepare(
				`INSERT INTO payment_ingresses
				(id, rail_code, name, type, transport, endpoint, api_key, priority,
				 timeout_ms, block_lookback, log_block_range, max_scan_transactions,
				 enabled, health_status, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unknown', ?, ?)`,
			)
			.bind(
				id,
				data.railCode,
				data.name,
				data.type,
				data.transport,
				data.endpoint,
				data.apiKey ?? null,
				data.priority,
				scanConfig.timeoutMs ?? null,
				scanConfig.blockLookback ?? null,
				scanConfig.logBlockRange ?? null,
				scanConfig.maxScanTransactions ?? null,
				now,
				now,
			)
			.run();
		return { id };
	});

export const testPaymentConnectionFn = createServerFn({ method: "POST" })
	.validator(
		(input: z.input<typeof paymentConnectionIdInput> & { kind: RailKind }) =>
			paymentConnectionIdInput.extend({ kind: railKindSchema }).parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(paymentSettingsPermission("test"));
		await assertConnectionKind(context.db, data.id, data.kind);
		return testPaymentConnection(context.db, data.id);
	});

export const setPaymentConnectionEnabledFn = createServerFn({ method: "POST" })
	.validator((input: { id: string; enabled: boolean; kind: RailKind }) =>
		paymentConnectionIdInput
			.extend({ enabled: z.boolean(), kind: railKindSchema })
			.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(paymentSettingsPermission("update"));
		const connection = await assertConnectionKind(
			context.db,
			data.id,
			data.kind,
		);
		if (connection.kind !== "chain")
			return { ...data, enabled: true, changed: false };
		if (data.enabled) {
			const health = await testPaymentConnection(context.db, data.id);
			if (!health.healthy)
				throw paymentSettingsError("payment_connection_unhealthy");
		}
		const now = Date.now();
		const result = await context.db
			.prepare(
				"UPDATE payment_ingresses SET enabled = ?, updated_at = ? WHERE id = ? AND enabled != ?",
			)
			.bind(data.enabled, now, data.id, data.enabled)
			.run();
		if ((result.meta.changes ?? 0) === 1)
			await context.db
				.prepare(
					`INSERT INTO audit_logs
					 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
					 VALUES (?, ?, 'payment_connection.enabled_changed', 'payment_connection', ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					context.user.id,
					data.id,
					context.request.headers.get("x-request-id"),
					context.request.headers.get("cf-connecting-ip"),
					JSON.stringify({ enabled: data.enabled }),
					now,
				)
				.run();
		return { ...data, changed: (result.meta.changes ?? 0) === 1 };
	});

async function assertConnectionKind(
	db: D1Database,
	id: string,
	kind: RailKind,
) {
	const row = await db
		.prepare(`SELECT rail.kind FROM payment_ingresses connection
			JOIN payment_rails rail ON rail.code = connection.rail_code
			WHERE connection.id = ? LIMIT 1`)
		.bind(id)
		.first<{ kind: RailKind }>();
	if (row?.kind !== kind)
		throw paymentSettingsError("payment_connection_not_found");
	return row;
}
