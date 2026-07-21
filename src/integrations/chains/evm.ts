import { z } from "zod";
import {
	observeProviderOperation,
	type ProviderOperationCounters,
} from "../provider-observability";
import { JsonRpcRequestError, requestJsonRpc } from "./json-rpc";
import { consumeJsonRpcSubscription } from "./json-rpc-subscription";
import { operationDeadline, remainingOperationMs } from "./operation-deadline";
import type {
	AdapterErrorKind,
	AdapterHealth,
	Network,
	NormalizedTransaction,
	PaymentAdapter,
	PaymentTarget,
	TransactionLookup,
} from "./types";

const evmNetworks = ["ethereum", "base", "bsc", "polygon"] as const;
const configSchema = z.object({
	rpcUrl: z.url(),
	network: z.enum(evmNetworks),
	nativeAsset: z.string().trim().min(2).max(12),
	tokens: z
		.record(
			z.string(),
			z.object({
				address: z.string(),
				decimals: z.number().int().min(0).max(30),
			}),
		)
		.default({}),
	apiKey: z.string().optional(),
	timeoutMs: z.number().int().min(1000).max(30_000).default(30_000),
	blockLookback: z.number().int().min(1).max(20_000).default(3000),
	logBlockRange: z.number().int().min(1).max(20_000).default(500),
	maxScanTransactions: z.number().int().min(1).max(10_000).default(1000),
});
export type EvmConfig = z.infer<typeof configSchema>;

const transferTopic =
	"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const logSchema = z.object({
	address: z.string(),
	blockHash: z.string(),
	blockNumber: z.string(),
	data: z.string(),
	logIndex: z.string(),
	removed: z.boolean().optional(),
	topics: z.array(z.string()),
	transactionHash: z.string(),
});
const blockSchema = z.object({
	hash: z.string(),
	number: z.string(),
	timestamp: z.string(),
	transactions: z.array(z.unknown()).default([]),
});
const transactionSchema = z.object({
	blockHash: z.string().nullable(),
	blockNumber: z.string().nullable(),
	from: z.string(),
	hash: z.string(),
	to: z.string().nullable(),
	value: z.string(),
});
const receiptSchema = z.object({
	blockHash: z.string(),
	blockNumber: z.string(),
	logs: z.array(logSchema),
	status: z.string(),
	transactionHash: z.string(),
});

export class EvmAdapter implements PaymentAdapter<EvmConfig> {
	readonly id = "evm";
	readonly configSchema = configSchema;
	readonly config: EvmConfig;
	readonly network: Network;

	constructor(config: unknown) {
		this.config = this.validateConfig(config);
		this.network = this.config.network;
	}
	validateConfig(value: unknown) {
		const config = this.configSchema.parse(value);
		for (const token of Object.values(config.tokens)) {
			if (!isAddress(token.address))
				throw new Error("Invalid EVM token address");
		}
		return config;
	}
	async createPaymentTarget(input: { address: string; expiresAt: Date }) {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid EVM address");
		return {
			address: checksumInsensitive(input.address),
			expiresAt: input.expiresAt,
		};
	}
	validateAddress(address: string) {
		return isAddress(address);
	}
	validatePayment(
		transaction: NormalizedTransaction,
		target: PaymentTarget,
		assetCode: string,
	) {
		return (
			transaction.success &&
			transaction.canonical !== false &&
			transaction.network === this.network &&
			checksumInsensitive(transaction.to) ===
				checksumInsensitive(target.address) &&
			transaction.assetCode.toUpperCase() === assetCode.toUpperCase()
		);
	}
	async getTransaction(
		hash: string,
		lookup?: TransactionLookup,
	): Promise<NormalizedTransaction | null> {
		return observeProviderOperation(
			{
				adapter: "evm",
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
	): Promise<NormalizedTransaction | null> {
		const deadlineAt = operationDeadline(this.config.timeoutMs);
		const [rawTransaction, rawReceipt, latestHex] = await Promise.all([
			this.rpc<unknown>(
				"eth_getTransactionByHash",
				[hash],
				deadlineAt,
				undefined,
				counters,
			),
			this.rpc<unknown>(
				"eth_getTransactionReceipt",
				[hash],
				deadlineAt,
				undefined,
				counters,
			),
			this.rpc<string>("eth_blockNumber", [], deadlineAt, undefined, counters),
		]);
		if (rawTransaction == null || rawReceipt == null) return null;
		const transaction = transactionSchema.parse(rawTransaction);
		const receipt = receiptSchema.parse(rawReceipt);
		const block = blockSchema.parse(
			await this.rpc(
				"eth_getBlockByHash",
				[receipt.blockHash, false],
				deadlineAt,
				undefined,
				counters,
			),
		);
		const requestedToken = lookup?.assetCode
			? this.token(lookup.assetCode)
			: Object.values(this.config.tokens)[0];
		const tokenLog = requestedToken
			? receipt.logs.find(
					(log) =>
						log.topics[0]?.toLowerCase() === transferTopic &&
						checksumInsensitive(log.address) ===
							checksumInsensitive(requestedToken.address) &&
						(lookup?.address == null ||
							checksumInsensitive(topicAddress(log.topics[2])) ===
								checksumInsensitive(lookup.address)) &&
						(lookup?.eventIndex == null ||
							fromHex(log.logIndex) === lookup.eventIndex),
				)
			: undefined;
		return tokenLog
			? this.normalizeLog(tokenLog, block, fromHex(latestHex), receipt.status)
			: requestedToken
				? null
				: this.normalizeNative(
						transaction,
						block,
						fromHex(latestHex),
						receipt.status,
					);
	}
	async findTransactions(input: {
		address: string;
		assetCode: string;
		sinceBlock?: bigint;
	}) {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid EVM address");
		return observeProviderOperation(
			{
				adapter: "evm",
				operation: "find_transactions",
				classifyError: (error) => this.classifyError(error),
			},
			(counters) => this.findTransactionsObserved(input, counters),
		);
	}
	private async findTransactionsObserved(
		input: {
			address: string;
			assetCode: string;
			sinceBlock?: bigint;
		},
		counters: ProviderOperationCounters,
	) {
		const deadlineAt = operationDeadline(this.config.timeoutMs);
		const latest = fromHex(
			await this.rpc<string>(
				"eth_blockNumber",
				[],
				deadlineAt,
				undefined,
				counters,
			),
		);
		const earliest = Math.max(0, latest - this.config.blockLookback + 1);
		if (input.sinceBlock != null) {
			if (input.sinceBlock > BigInt(latest)) return [];
			if (input.sinceBlock < BigInt(earliest))
				throw new Error("EVM scan exceeds the configured block lookback");
		}
		const from = input.sinceBlock == null ? earliest : Number(input.sinceBlock);
		const token = this.token(input.assetCode);
		if (token)
			return this.findTokenTransfers(
				input.address,
				input.assetCode,
				token.address,
				from,
				latest,
				deadlineAt,
				counters,
			);
		if (input.assetCode.toUpperCase() !== this.config.nativeAsset.toUpperCase())
			return [];
		return this.findNativeTransfers(
			input.address,
			from,
			latest,
			deadlineAt,
			counters,
		);
	}
	async getConfirmations(transaction: NormalizedTransaction) {
		return observeProviderOperation(
			{
				adapter: "evm",
				operation: "get_confirmations",
				classifyError: (error) => this.classifyError(error),
			},
			async (counters) => {
				const latest = fromHex(
					await this.rpc<string>(
						"eth_blockNumber",
						[],
						undefined,
						undefined,
						counters,
					),
				);
				return confirmationCount(latest, Number(transaction.blockNumber));
			},
		);
	}
	async subscribeTransactions(input: {
		address: string;
		assetCode: string;
		signal: AbortSignal;
		onTransaction: (transaction: NormalizedTransaction) => Promise<void> | void;
	}) {
		if (!this.config.rpcUrl.startsWith("wss://"))
			throw new Error("EVM subscriptions require a wss:// RPC endpoint");
		if (!this.validateAddress(input.address))
			throw new Error("Invalid EVM address");
		const token = this.token(input.assetCode);
		const params = token
			? [
					"logs",
					{
						address: token.address,
						topics: [transferTopic, null, addressTopic(input.address)],
					},
				]
			: ["newHeads"];
		return consumeJsonRpcSubscription<unknown>({
			adapter: "evm",
			url: this.config.rpcUrl,
			method: "eth_subscribe",
			params,
			timeoutMs: Math.max(this.config.timeoutMs, 300_000),
			signal: input.signal,
			onNotification: async (value) => {
				if (token) {
					const deadlineAt = operationDeadline(this.config.timeoutMs);
					const log = logSchema.parse(value);
					const block = blockSchema.parse(
						await this.rpc(
							"eth_getBlockByHash",
							[log.blockHash, false],
							deadlineAt,
							input.signal,
						),
					);
					const receipt = receiptSchema.parse(
						await this.rpc(
							"eth_getTransactionReceipt",
							[log.transactionHash],
							deadlineAt,
							input.signal,
						),
					);
					const latest = fromHex(
						await this.rpc<string>(
							"eth_blockNumber",
							[],
							deadlineAt,
							input.signal,
						),
					);
					await input.onTransaction(
						this.normalizeLog(
							log,
							block,
							latest,
							receipt.status,
							input.assetCode,
						),
					);
					return;
				}
				const header = z
					.object({ hash: z.string(), number: z.string() })
					.parse(value);
				const deadlineAt = operationDeadline(this.config.timeoutMs);
				const block = blockSchema.parse(
					await this.rpc(
						"eth_getBlockByHash",
						[header.hash, true],
						deadlineAt,
						input.signal,
					),
				);
				const latest = fromHex(header.number);
				for (const raw of block.transactions) {
					const transaction = transactionSchema.parse(raw);
					if (
						transaction.to &&
						checksumInsensitive(transaction.to) ===
							checksumInsensitive(input.address)
					) {
						const receipt = receiptSchema.parse(
							await this.rpc(
								"eth_getTransactionReceipt",
								[transaction.hash],
								deadlineAt,
								input.signal,
							),
						);
						await input.onTransaction(
							this.normalizeNative(transaction, block, latest, receipt.status),
						);
					}
				}
			},
		});
	}
	async healthCheck(): Promise<AdapterHealth> {
		const started = Date.now();
		try {
			await observeProviderOperation(
				{
					adapter: "evm",
					operation: "health_check",
					classifyError: (error) => this.classifyError(error),
				},
				(counters) =>
					this.rpc("eth_chainId", [], undefined, undefined, counters),
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
				detail: `EVM health check failed: ${this.classifyError(error)}`,
			};
		}
	}
	classifyError(error: unknown): AdapterErrorKind {
		if (error instanceof JsonRpcRequestError) {
			if (error.status === 401 || error.status === 403) return "authentication";
			if (error.status === 429) return "rate_limit";
			if (error.status >= 500) return "network";
			return error.rpcCode === -32602 ? "configuration" : "permanent";
		}
		if (error instanceof z.ZodError) return "invalid_response";
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
		const entry = Object.entries(this.config.tokens).find(
			([symbol]) => symbol.toUpperCase() === assetCode.toUpperCase(),
		);
		return entry?.[1];
	}
	private tokenSymbol(contract: string) {
		return Object.entries(this.config.tokens).find(
			([, token]) =>
				checksumInsensitive(token.address) === checksumInsensitive(contract),
		)?.[0];
	}
	private async findTokenTransfers(
		address: string,
		assetCode: string,
		contract: string,
		from: number,
		latest: number,
		deadlineAt: number,
		counters: ProviderOperationCounters,
	) {
		const rows: z.infer<typeof logSchema>[] = [];
		let rangeStart = from;
		let blockRange = this.config.logBlockRange;
		while (rangeStart <= latest) {
			counters.page();
			const rangeEnd = Math.min(latest, rangeStart + blockRange - 1);
			let rawBatch: unknown;
			try {
				rawBatch = await this.rpc(
					"eth_getLogs",
					[
						{
							address: contract,
							fromBlock: toHex(rangeStart),
							toBlock: toHex(rangeEnd),
							topics: [transferTopic, null, addressTopic(address)],
						},
					],
					deadlineAt,
					undefined,
					counters,
				);
			} catch (error) {
				if (
					blockRange > 1 &&
					error instanceof JsonRpcRequestError &&
					error.rpcCode != null
				) {
					blockRange = Math.max(1, Math.floor(blockRange / 2));
					continue;
				}
				throw error;
			}
			const batch = z.array(logSchema).parse(rawBatch);
			if (rows.length + batch.length > this.config.maxScanTransactions)
				throw new Error("EVM scan exceeded the configured transaction limit");
			rows.push(...batch);
			rangeStart = rangeEnd + 1;
		}
		const blocks = new Map<string, z.infer<typeof blockSchema>>();
		const normalized: NormalizedTransaction[] = [];
		for (const row of rows) {
			let block = blocks.get(row.blockHash);
			if (!block) {
				block = blockSchema.parse(
					await this.rpc(
						"eth_getBlockByHash",
						[row.blockHash, false],
						deadlineAt,
						undefined,
						counters,
					),
				);
				blocks.set(row.blockHash, block);
			}
			normalized.push(this.normalizeLog(row, block, latest, "0x1", assetCode));
		}
		return normalized;
	}
	private async findNativeTransfers(
		address: string,
		from: number,
		latest: number,
		deadlineAt: number,
		counters: ProviderOperationCounters,
	) {
		const normalized: NormalizedTransaction[] = [];
		let matches = 0;
		for (let number = from; number <= latest; number += 1) {
			counters.page();
			const block = blockSchema.parse(
				await this.rpc(
					"eth_getBlockByNumber",
					[toHex(number), true],
					deadlineAt,
					undefined,
					counters,
				),
			);
			for (const raw of block.transactions) {
				const transaction = transactionSchema.parse(raw);
				if (
					transaction.to &&
					checksumInsensitive(transaction.to) === checksumInsensitive(address)
				) {
					matches += 1;
					if (matches > this.config.maxScanTransactions)
						throw new Error(
							"EVM scan exceeded the configured transaction limit",
						);
					const receipt = receiptSchema.parse(
						await this.rpc(
							"eth_getTransactionReceipt",
							[transaction.hash],
							deadlineAt,
							undefined,
							counters,
						),
					);
					normalized.push(
						this.normalizeNative(transaction, block, latest, receipt.status),
					);
				}
			}
		}
		return normalized;
	}
	private normalizeLog(
		log: z.infer<typeof logSchema>,
		block: z.infer<typeof blockSchema>,
		latest: number,
		status: string,
		assetCode = this.tokenSymbol(log.address) ?? log.address,
	): NormalizedTransaction {
		return {
			network: this.network,
			hash: log.transactionHash,
			eventIndex: fromHex(log.logIndex),
			from: topicAddress(log.topics[1]),
			to: topicAddress(log.topics[2]),
			assetCode: assetCode.toUpperCase(),
			amountUnits: BigInt(log.data),
			blockNumber: BigInt(log.blockNumber),
			blockHash: log.blockHash,
			confirmations: confirmationCount(latest, fromHex(log.blockNumber)),
			timestamp: new Date(fromHex(block.timestamp) * 1000),
			success: status === "0x1",
			canonical: !log.removed && block.hash === log.blockHash,
		};
	}
	private normalizeNative(
		transaction: z.infer<typeof transactionSchema>,
		block: z.infer<typeof blockSchema>,
		latest: number,
		status: string,
	): NormalizedTransaction {
		if (!transaction.to || !transaction.blockNumber || !transaction.blockHash)
			throw new Error("EVM transaction is not mined");
		return {
			network: this.network,
			hash: transaction.hash,
			eventIndex: 0,
			from: checksumInsensitive(transaction.from),
			to: checksumInsensitive(transaction.to),
			assetCode: this.config.nativeAsset.toUpperCase(),
			amountUnits: BigInt(transaction.value),
			blockNumber: BigInt(transaction.blockNumber),
			blockHash: transaction.blockHash,
			confirmations: confirmationCount(
				latest,
				fromHex(transaction.blockNumber),
			),
			timestamp: new Date(fromHex(block.timestamp) * 1000),
			success: status === "0x1",
			canonical: block.hash === transaction.blockHash,
		};
	}
	private async rpc<T>(
		method: string,
		params: unknown[],
		deadlineAt?: number,
		signal?: AbortSignal,
		counters?: ProviderOperationCounters,
	): Promise<T> {
		counters?.request();
		return requestJsonRpc<T>({
			url: this.config.rpcUrl,
			method,
			params,
			timeoutMs:
				deadlineAt == null
					? this.config.timeoutMs
					: remainingOperationMs(deadlineAt, "EVM operation"),
			...(this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
			...(signal ? { signal } : {}),
		});
	}
}
function isAddress(value: string) {
	return /^0x[0-9a-fA-F]{40}$/.test(value);
}
function checksumInsensitive(value: string) {
	return value.toLowerCase();
}
function fromHex(value: string) {
	if (!/^0x[0-9a-f]+$/i.test(value))
		throw new Error("Invalid hexadecimal number");
	const parsed = Number.parseInt(value, 16);
	if (!Number.isSafeInteger(parsed))
		throw new Error("Hexadecimal number exceeds safe integer range");
	return parsed;
}
function toHex(value: number) {
	return `0x${value.toString(16)}`;
}
function addressTopic(address: string) {
	return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}
function topicAddress(topic?: string) {
	if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic))
		throw new Error("Invalid EVM address topic");
	return `0x${topic.slice(-40).toLowerCase()}`;
}
function confirmationCount(latest: number, block: number) {
	return Math.max(0, latest - block + 1);
}
