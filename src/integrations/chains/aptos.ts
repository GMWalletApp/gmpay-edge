import { z } from "zod";
import {
	observeProviderOperation,
	type ProviderOperationCounters,
} from "../provider-observability";
import {
	ProviderResponseTooLargeError,
	readProviderJson,
} from "../provider-response";
import { operationDeadline, operationSignal } from "./operation-deadline";
import { truncatedScan } from "./transaction-scan";
import type {
	AdapterErrorKind,
	AdapterHealth,
	NormalizedTransaction,
	PaymentAdapter,
	PaymentTarget,
	TransactionLookup,
	TransactionScan,
	TransactionScanInput,
} from "./types";

const configSchema = z.object({
	indexerUrl: z.url().default("https://api.mainnet.aptoslabs.com/v1/graphql"),
	nativeAsset: z.string().default("APT"),
	nativeAssetType: z.string().default("0x1::aptos_coin::AptosCoin"),
	tokens: z
		.record(
			z.string(),
			z.object({
				assetType: z.string(),
				decimals: z.number().int().min(0).max(30),
			}),
		)
		.default({}),
	apiKey: z.string().optional(),
	timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
	maxPages: z.number().int().min(1).max(500).default(50),
});
export type AptosConfig = z.infer<typeof configSchema>;

const activitySchema = z.object({
	// Aptos indexer exposes atomic amounts as bigint-like strings. Do not
	// accept JSON numbers that could be rounded before BigInt conversion.
	amount: z.string(),
	asset_type: z.string(),
	event_index: z.union([z.string(), z.number()]),
	is_transaction_success: z.boolean(),
	owner_address: z.string(),
	transaction_timestamp: z.string(),
	transaction_version: z.string(),
	type: z.string(),
});

export class AptosAdapter implements PaymentAdapter<AptosConfig> {
	readonly id = "aptos";
	readonly network = "aptos" as const;
	readonly configSchema = configSchema;
	readonly config: AptosConfig;
	constructor(config: unknown) {
		this.config = this.validateConfig(config);
	}
	validateConfig(value: unknown) {
		return this.configSchema.parse(value);
	}
	async createPaymentTarget(input: { address: string; expiresAt: Date }) {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid Aptos address");
		return {
			address: normalizeAddress(input.address),
			expiresAt: input.expiresAt,
		};
	}
	validateAddress(address: string) {
		return /^0x[0-9a-fA-F]{1,64}$/.test(address);
	}
	validatePayment(
		transaction: NormalizedTransaction,
		target: PaymentTarget,
		assetCode: string,
	) {
		return (
			transaction.success &&
			transaction.canonical !== false &&
			transaction.to === normalizeAddress(target.address) &&
			transaction.assetCode.toUpperCase() === assetCode.toUpperCase()
		);
	}
	async getTransaction(hash: string, lookup?: TransactionLookup) {
		return observeProviderOperation(
			{
				adapter: "aptos",
				operation: "get_transaction",
				classifyError: (error) => this.classifyError(error),
			},
			(counters) => this.getTransactionObserved(hash, lookup, counters),
		);
	}
	private async getTransactionObserved(
		hash: string,
		lookup: TransactionLookup | undefined,
		counters: ProviderOperationCounters,
	) {
		if (!/^\d+$/.test(hash))
			throw new Error("Aptos transaction hash must be a transaction version");
		const { rows } = await this.activities(
			{ version: hash },
			operationDeadline(this.config.timeoutMs),
			counters,
		);
		for (const row of rows) {
			const normalized = this.normalize(row);
			if (
				(lookup?.address == null ||
					normalized.to === normalizeAddress(lookup.address)) &&
				(lookup?.assetCode == null ||
					normalized.assetCode.toUpperCase() ===
						lookup.assetCode.toUpperCase()) &&
				(lookup?.eventIndex == null ||
					normalized.eventIndex === lookup.eventIndex)
			)
				return normalized;
		}
		return null;
	}
	async findTransactions(input: TransactionScanInput) {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid Aptos address");
		return observeProviderOperation(
			{
				adapter: "aptos",
				operation: "find_transactions",
				classifyError: (error) => this.classifyError(error),
			},
			(counters) => this.findTransactionsObserved(input, counters),
		);
	}
	private async findTransactionsObserved(
		input: TransactionScanInput,
		counters: ProviderOperationCounters,
	): Promise<TransactionScan> {
		const assetType =
			input.assetCode.toUpperCase() === this.config.nativeAsset.toUpperCase()
				? this.config.nativeAssetType
				: this.token(input.assetCode)?.assetType;
		if (!assetType) return [];
		const scan = await this.activities(
			{
				owner: normalizeAddress(input.address),
				assetType,
				...(input.sinceBlock === undefined
					? {}
					: { sinceVersion: input.sinceBlock.toString() }),
				...(input.sinceTimestampMs === undefined
					? {}
					: { sinceTimestamp: new Date(input.sinceTimestampMs).toISOString() }),
			},
			operationDeadline(this.config.timeoutMs),
			counters,
		);
		const transactions = scan.rows.map((row) => this.normalize(row));
		return scan.truncated ? truncatedScan(transactions) : transactions;
	}
	async getConfirmations(transaction: NormalizedTransaction) {
		return transaction.success ? 1 : 0;
	}
	async healthCheck(): Promise<AdapterHealth> {
		const started = Date.now();
		try {
			await observeProviderOperation(
				{
					adapter: "aptos",
					operation: "health_check",
					classifyError: (error) => this.classifyError(error),
				},
				(counters) =>
					this.graphql(
						"query { fungible_asset_activities(limit: 1) { transaction_version } }",
						{},
						undefined,
						counters,
					),
			);
			return {
				healthy: true,
				latencyMs: Date.now() - started,
				checkedAt: new Date(),
			};
		} catch (error) {
			return {
				healthy: false,
				latencyMs: Date.now() - started,
				checkedAt: new Date(),
				detail: `Aptos health check failed: ${this.classifyError(error)}`,
			};
		}
	}
	classifyError(error: unknown): AdapterErrorKind {
		if (error instanceof AptosHttpError) {
			if (error.status === 401 || error.status === 403) return "authentication";
			if (error.status === 429) return "rate_limit";
			if (error.status >= 500) return "network";
			return "permanent";
		}
		if (
			error instanceof z.ZodError ||
			error instanceof AptosGraphqlError ||
			error instanceof ProviderResponseTooLargeError
		)
			return "invalid_response";
		if (error instanceof TypeError || error instanceof DOMException)
			return "network";
		return "permanent";
	}
	isRetryable(kind: AdapterErrorKind) {
		return (
			kind === "network" || kind === "rate_limit" || kind === "invalid_response"
		);
	}

	private token(assetCode: string) {
		return Object.entries(this.config.tokens).find(
			([symbol]) => symbol.toUpperCase() === assetCode.toUpperCase(),
		)?.[1];
	}
	private symbol(assetType: string) {
		if (assetType === this.config.nativeAssetType)
			return this.config.nativeAsset;
		return (
			Object.entries(this.config.tokens).find(
				([, token]) => token.assetType === assetType,
			)?.[0] ?? assetType
		);
	}
	/**
	 * Pages newest-first with the bounds applied by the Indexer. Spending the
	 * page budget yields the newest rows as a truncated scan instead of a
	 * permanent failure.
	 */
	private async activities(
		filter: {
			owner?: string;
			assetType?: string;
			sinceVersion?: string;
			sinceTimestamp?: string;
			version?: string;
		},
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	) {
		const where = [
			filter.owner ? "owner_address: { _eq: $owner }" : "",
			filter.assetType ? "asset_type: { _eq: $asset }" : "",
			filter.sinceVersion ? "transaction_version: { _gte: $since }" : "",
			filter.sinceTimestamp
				? "transaction_timestamp: { _gte: $sinceTimestamp }"
				: "",
			filter.version ? "transaction_version: { _eq: $version }" : "",
			'type: { _eq: "deposit" }',
			"is_transaction_success: { _eq: true }",
		]
			.filter(Boolean)
			.join("\n");
		const query = `query($owner: String, $asset: String, $since: bigint, $sinceTimestamp: timestamp, $version: bigint, $offset: Int!) {
			fungible_asset_activities(where: { ${where} }, order_by: { transaction_version: desc }, limit: 100, offset: $offset) {
				amount asset_type event_index is_transaction_success owner_address transaction_timestamp transaction_version type
			}
		}`;
		const rows: z.infer<typeof activitySchema>[] = [];
		for (let page = 0; page < this.config.maxPages; page += 1) {
			counters?.page();
			const data = await this.graphql(
				query,
				{
					owner: filter.owner,
					asset: filter.assetType,
					since: filter.sinceVersion,
					sinceTimestamp: filter.sinceTimestamp,
					version: filter.version,
					offset: page * 100,
				},
				deadlineAt,
				counters,
			);
			const batch = z
				.array(activitySchema)
				.parse(data.fungible_asset_activities ?? []);
			rows.push(...batch);
			if (batch.length < 100 || filter.version)
				return { rows, truncated: false };
		}
		return { rows, truncated: true };
	}
	private normalize(
		row: z.infer<typeof activitySchema>,
	): NormalizedTransaction {
		const version = BigInt(row.transaction_version);
		const eventIndex = Number(row.event_index);
		if (!Number.isSafeInteger(eventIndex) || eventIndex < 0)
			throw new Error("Invalid Aptos event index");
		return {
			network: "aptos",
			hash: version.toString(),
			eventIndex,
			from: "",
			to: normalizeAddress(row.owner_address),
			assetCode: this.symbol(row.asset_type).toUpperCase(),
			amountUnits: BigInt(row.amount),
			blockNumber: version,
			blockHash: `aptos:${version}`,
			confirmations: row.is_transaction_success ? 1 : 0,
			timestamp: new Date(row.transaction_timestamp),
			success: row.is_transaction_success && row.type === "deposit",
			canonical: true,
		};
	}
	private async graphql(
		query: string,
		variables: Record<string, unknown>,
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	) {
		counters?.request();
		const response = await fetch(this.config.indexerUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.config.apiKey
					? { authorization: `Bearer ${this.config.apiKey}` }
					: {}),
			},
			body: JSON.stringify({ query, variables }),
			signal: operationSignal(deadlineAt, "Aptos operation"),
		});
		if (!response.ok) throw new AptosHttpError(response.status);
		const payload = z
			.object({
				data: z.record(z.string(), z.unknown()).optional(),
				errors: z.array(z.object({ message: z.string() })).optional(),
			})
			.parse(await readProviderJson(response));
		if (payload.errors?.length || !payload.data)
			throw new AptosGraphqlError("Aptos Indexer returned a GraphQL error");
		return payload.data;
	}
}

class AptosHttpError extends Error {
	constructor(readonly status: number) {
		super(`Aptos Indexer returned HTTP ${status}`);
	}
}
class AptosGraphqlError extends Error {}
function normalizeAddress(value: string) {
	return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
}
