import { AptosAdapter } from "#/integrations/chains/aptos";
import { EvmAdapter } from "#/integrations/chains/evm";
import { SolanaAdapter } from "#/integrations/chains/solana";
import { TonAdapter } from "#/integrations/chains/ton";
import { TronAdapter } from "#/integrations/chains/tron";
import type { PaymentAdapter } from "#/integrations/chains/types";
import { BinancePayAdapter } from "#/integrations/exchanges/binance";
import { OkxPayAdapter } from "#/integrations/exchanges/okx";
import { OkPayAdapter } from "#/integrations/wallets/okpay";
import { decryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig, type RuntimeConfig } from "#/server/runtime-config";

type MethodConnection = {
	connection_id: string;
	adapter: string;
	transport: "http" | "websocket";
	endpoint: string | null;
	api_key: string | null;
	timeout_ms: number | null;
	block_lookback: number | null;
	log_block_range: number | null;
	max_scan_transactions: number | null;
	asset_code: string;
	rail_code: string;
	asset_kind: "native" | "token" | "external";
	contract_address: string | null;
	decimals: number;
	native_symbol: string;
};

export const paymentAdapterCandidateLimit = 8;

export async function createReceivingMethodAdapters(
	db: D1Database,
	receivingMethodId: string,
	sharedRuntime?: RuntimeConfig,
) {
	const method = await db
		.prepare(
			"SELECT target_value, config_encrypted FROM receiving_methods WHERE id = ? LIMIT 1",
		)
		.bind(receivingMethodId)
		.first<{
			target_value: string;
			config_encrypted: string | null;
		}>();
	if (!method) return [];
	let providerConfig: Record<string, unknown> | undefined;
	if (method.config_encrypted) {
		const runtime = sharedRuntime ?? (await loadRuntimeConfig(db));
		const parsed: unknown = JSON.parse(
			await decryptSecret(
				method.config_encrypted,
				runtime.integrationConfigSecret,
			),
		);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("Receiving provider configuration is invalid");
		providerConfig = parsed as Record<string, unknown>;
	}
	const links = await db
		.prepare(
			"SELECT payment_asset_id FROM receiving_method_assets WHERE receiving_method_id = ? ORDER BY payment_asset_id",
		)
		.bind(receivingMethodId)
		.all<{ payment_asset_id: string }>();
	return (
		await Promise.all(
			links.results.map((link) =>
				createPaymentMethodAdapters(
					db,
					link.payment_asset_id,
					method.target_value,
					providerConfig,
				),
			),
		)
	).flat();
}

export async function createPaymentMethodAdapters(
	db: D1Database,
	paymentMethodId: string,
	targetValue?: string,
	receivingProviderConfig?: Record<string, unknown>,
) {
	const rows = await db
		.prepare(
			`SELECT pc.id AS connection_id, pr.adapter, pc.transport, pc.endpoint, pc.api_key,
			 pc.timeout_ms, pc.block_lookback, pc.log_block_range, pc.max_scan_transactions,
			 pa.code AS asset_code,
			 pa.rail_code,
			 pa.kind AS asset_kind, pa.contract_address, pa.decimals,
			 COALESCE(json_extract(pr.metadata, '$.nativeSymbol'), pa.symbol) AS native_symbol
			 FROM payment_assets pa
			 JOIN payment_rails pr ON pr.code = pa.rail_code
			 JOIN payment_ingresses pc ON pc.rail_code = pr.code
			 WHERE pa.id = ?
			 AND pc.enabled = 1
			 ORDER BY CASE pc.health_status WHEN 'healthy' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END,
			 pc.priority, pc.id LIMIT ?`,
		)
		.bind(paymentMethodId, paymentAdapterCandidateLimit)
		.all<MethodConnection>();
	const adapters: Array<{
		connectionId: string;
		adapter: PaymentAdapter<unknown>;
		transport: "http" | "websocket";
	}> = [];
	for (const row of rows.results) {
		try {
			const adapter = await createAdapter(
				row,
				targetValue,
				receivingProviderConfig,
			);
			if (adapter)
				adapters.push({
					connectionId: row.connection_id,
					adapter,
					transport: row.transport,
				});
		} catch {
			// An invalid provider credential must not prevent trying a fallback.
		}
	}
	const subscription = adapters.find(
		(candidate) =>
			candidate.transport === "websocket" &&
			candidate.adapter.subscribeTransactions,
	);
	return adapters.map(({ transport, ...candidate }) => ({
		...candidate,
		...(transport === "http" && subscription
			? {
					subscription: {
						connectionId: subscription.connectionId,
						adapter: subscription.adapter,
					},
				}
			: {}),
	}));
}

/**
 * Builds an adapter for an individual infrastructure connection without
 * requiring that connection to already be enabled. This is intentionally
 * separate from payment routing, which must continue to ignore disabled
 * connections.
 */
export async function createPaymentConnectionAdapter(
	db: D1Database,
	connectionId: string,
) {
	const connection = await db
		.prepare(
			`SELECT pc.id AS connection_id, pr.adapter, pc.transport, pc.endpoint, pc.api_key,
			 pc.timeout_ms, pc.block_lookback, pc.log_block_range, pc.max_scan_transactions,
			 pa.code AS asset_code, pa.rail_code, pa.kind AS asset_kind,
			 pa.contract_address, pa.decimals,
			 COALESCE(json_extract(pr.metadata, '$.nativeSymbol'), pa.symbol) AS native_symbol
			 FROM payment_ingresses pc
			 JOIN payment_rails pr ON pr.code = pc.rail_code
			 JOIN payment_assets pa ON pa.rail_code = pr.code
			 WHERE pc.id = ? AND pr.kind = 'chain'
			 ORDER BY CASE pa.kind WHEN 'native' THEN 0 ELSE 1 END, pa.id
			 LIMIT 1`,
		)
		.bind(connectionId)
		.first<MethodConnection>();
	if (!connection) return null;
	return createAdapter(connection);
}

export async function loadPaymentConnectionHealthTargets(
	db: D1Database,
	limit: number,
	now = Date.now(),
	intervalMs = 15 * 60_000,
) {
	const connections = await db
		.prepare(
			`SELECT pc.id AS connection_id, pr.adapter, pc.transport, pc.endpoint, pc.api_key,
			 pc.timeout_ms, pc.block_lookback, pc.log_block_range, pc.max_scan_transactions,
			 pa.code AS asset_code, pa.rail_code, pa.kind AS asset_kind,
			 pa.contract_address, pa.decimals,
			 COALESCE(json_extract(pr.metadata, '$.nativeSymbol'), pa.symbol) AS native_symbol
			 FROM payment_ingresses pc
			 JOIN payment_rails pr ON pr.code = pc.rail_code
			 JOIN payment_assets pa ON pa.id = (
			  SELECT candidate.id FROM payment_assets candidate
			  WHERE candidate.rail_code = pr.code
			  ORDER BY CASE candidate.kind WHEN 'native' THEN 0 ELSE 1 END, candidate.id
			  LIMIT 1
			 )
			 WHERE pc.enabled = 1 AND pr.kind = 'chain'
			 AND (pc.last_checked_at IS NULL OR pc.last_checked_at <= ?)
			 ORDER BY pc.last_checked_at IS NOT NULL, pc.last_checked_at,
			 pc.priority, pc.id LIMIT ?`,
		)
		.bind(now - intervalMs, limit)
		.all<MethodConnection>();
	return Promise.all(
		connections.results.map(async (connection) => ({
			id: connection.connection_id,
			adapter: await createAdapter(connection),
		})),
	);
}

export async function loadPaymentConnectionHealthTargetsByIds(
	db: D1Database,
	connectionIds: string[],
) {
	if (!connectionIds.length) return [];
	const connections = await db
		.prepare(
			`SELECT pc.id AS connection_id, pr.adapter, pc.transport, pc.endpoint, pc.api_key,
			 pc.timeout_ms, pc.block_lookback, pc.log_block_range, pc.max_scan_transactions,
			 pa.code AS asset_code, pa.rail_code, pa.kind AS asset_kind,
			 pa.contract_address, pa.decimals,
			 COALESCE(json_extract(pr.metadata, '$.nativeSymbol'), pa.symbol) AS native_symbol
			 FROM payment_ingresses pc
			 JOIN payment_rails pr ON pr.code = pc.rail_code
			 JOIN payment_assets pa ON pa.id = (
			  SELECT candidate.id FROM payment_assets candidate
			  WHERE candidate.rail_code = pr.code
			  ORDER BY CASE candidate.kind WHEN 'native' THEN 0 ELSE 1 END, candidate.id
			  LIMIT 1
			 )
			 WHERE pc.enabled = 1 AND pr.kind = 'chain'
			 AND pc.id IN (${connectionIds.map(() => "?").join(",")})
			 ORDER BY pc.id`,
		)
		.bind(...connectionIds)
		.all<MethodConnection>();
	return Promise.all(
		connections.results.map(async (connection) => ({
			id: connection.connection_id,
			adapter: await createAdapter(connection),
		})),
	);
}

async function createAdapter(
	connection: MethodConnection,
	targetValue?: string,
	receivingProviderConfig?: Record<string, unknown>,
): Promise<PaymentAdapter<unknown> | null> {
	const endpoint = connection.endpoint;
	if (
		connection.transport === "websocket" &&
		!["evm", "solana"].includes(connection.adapter)
	)
		return null;
	if (connection.adapter === "tron" && endpoint)
		return new TronAdapter({
			apiUrl: endpoint,
			apiKey: connection.api_key || undefined,
		}) as PaymentAdapter<unknown>;
	if (
		connection.adapter === "evm" &&
		endpoint &&
		["ethereum", "base", "bsc", "polygon"].includes(connection.rail_code)
	)
		return new EvmAdapter({
			rpcUrl: endpoint,
			apiKey: connection.api_key || undefined,
			timeoutMs: connection.timeout_ms ?? undefined,
			blockLookback: connection.block_lookback ?? undefined,
			logBlockRange: connection.log_block_range ?? undefined,
			maxScanTransactions: connection.max_scan_transactions ?? undefined,
			network: connection.rail_code,
			nativeAsset: nativeAsset(connection),
			tokens: tokenConfiguration(connection, "address"),
		}) as PaymentAdapter<unknown>;
	if (connection.adapter === "ton" && endpoint)
		return new TonAdapter({
			apiUrl: endpoint,
			apiKey: connection.api_key || undefined,
			nativeAsset: nativeAsset(connection),
			tokens: tokenConfiguration(connection, "master"),
		}) as PaymentAdapter<unknown>;
	if (connection.adapter === "aptos" && endpoint)
		return new AptosAdapter({
			indexerUrl: endpoint,
			apiKey: connection.api_key || undefined,
			nativeAsset: nativeAsset(connection),
			tokens: connection.contract_address
				? {
						[connection.asset_code]: {
							assetType: connection.contract_address,
							decimals: connection.decimals,
						},
					}
				: {},
		}) as PaymentAdapter<unknown>;
	if (connection.adapter === "solana" && endpoint)
		return new SolanaAdapter({
			rpcUrl: endpoint,
			apiKey: connection.api_key || undefined,
			nativeAsset: nativeAsset(connection),
			tokens: connection.contract_address
				? {
						[connection.asset_code]: {
							mint: connection.contract_address,
							decimals: connection.decimals,
						},
					}
				: {},
		}) as PaymentAdapter<unknown>;
	const providerConfig = {
		...receivingProviderConfig,
		...(endpoint ? { apiUrl: endpoint } : {}),
		...(connection.adapter === "okx" && targetValue
			? { accountId: targetValue }
			: {}),
		...(connection.adapter === "okpay" && targetValue
			? { shopId: targetValue }
			: {}),
		assetDecimals: { [connection.asset_code]: connection.decimals },
	};
	if (connection.adapter === "binance")
		return new BinancePayAdapter(providerConfig) as PaymentAdapter<unknown>;
	if (connection.adapter === "okx")
		return new OkxPayAdapter(providerConfig) as PaymentAdapter<unknown>;
	if (connection.adapter === "okpay")
		return new OkPayAdapter(providerConfig) as PaymentAdapter<unknown>;
	return null;
}

function nativeAsset(connection: MethodConnection) {
	return connection.asset_kind === "native"
		? connection.asset_code
		: connection.native_symbol;
}

function tokenConfiguration(
	connection: MethodConnection,
	field: "address" | "master",
) {
	return connection.asset_kind === "token" && connection.contract_address
		? {
				[connection.asset_code]: {
					[field]: connection.contract_address,
					decimals: connection.decimals,
				},
			}
		: {};
}
