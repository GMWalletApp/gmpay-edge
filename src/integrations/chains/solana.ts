import { z } from "zod";
import {
	observeProviderOperation,
	type ProviderOperationCounters,
} from "../provider-observability";
import { ProviderResponseTooLargeError } from "../provider-response";
import { JsonRpcRequestError, requestJsonRpc } from "./json-rpc";
import { operationDeadline, remainingOperationMs } from "./operation-deadline";
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
	rpcUrl: z.url().default("https://api.mainnet-beta.solana.com"),
	nativeAsset: z.string().default("SOL"),
	tokens: z
		.record(
			z.string(),
			z.object({ mint: z.string(), decimals: z.number().int().min(0).max(30) }),
		)
		.default({}),
	apiKey: z.string().optional(),
	timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
	commitment: z.enum(["confirmed", "finalized"]).default("finalized"),
	signaturePageSize: z.number().int().min(1).max(1000).default(1000),
	maxPages: z.number().int().min(1).max(500).default(50),
	maxTokenAccounts: z.number().int().min(1).max(128).default(16),
	maxScanSignatures: z.number().int().min(1).max(10_000).default(1000),
});
export type SolanaConfig = z.infer<typeof configSchema>;
type ScanBudget = { remainingSignatures: number; truncated: boolean };
type ScanBounds = Pick<TransactionScanInput, "sinceBlock" | "sinceTimestampMs">;

const signatureSchema = z.object({
	blockTime: z.number().nullable().optional(),
	confirmationStatus: z.string().nullable().optional(),
	err: z.unknown().nullable().optional(),
	signature: z.string(),
	slot: z.number(),
});
const atomicAmountSchema = z.union([
	z.string().regex(/^\d+$/),
	z
		.number()
		.int()
		.nonnegative()
		.refine(Number.isSafeInteger, "Atomic amount number is not safe"),
]);
const accountKeySchema = z.union([
	z.string(),
	z.object({ pubkey: z.string() }).transform((key) => key.pubkey),
]);
/** `getTransaction` with `jsonParsed` encoding; `meta` is required because execution status lives there. */
const transactionSchema = z.object({
	blockTime: z.number().nullable().optional(),
	slot: z.number().int().nonnegative().optional(),
	transaction: z.object({
		message: z.object({
			accountKeys: z.array(accountKeySchema),
			instructions: z.array(z.unknown()),
			recentBlockhash: z.string(),
		}),
	}),
	meta: z.object({
		err: z.unknown().nullable().optional(),
		innerInstructions: z
			.array(z.object({ instructions: z.array(z.unknown()) }))
			.nullable()
			.optional(),
		postTokenBalances: z
			.array(
				z.object({
					accountIndex: z.number().int().nonnegative(),
					mint: z.string(),
					owner: z.string().optional(),
				}),
			)
			.nullable()
			.optional(),
	}),
});
const parsedInstructionSchema = z.object({
	parsed: z.object({
		type: z.string().startsWith("transfer"),
		info: z.object({ source: z.string(), destination: z.string() }).loose(),
	}),
});
const systemTransferSchema = z.object({ lamports: atomicAmountSchema });
const tokenTransferSchema = z.object({
	mint: z.string().optional(),
	amount: z.string().regex(/^\d+$/).optional(),
	tokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }).optional(),
});

export class SolanaAdapter implements PaymentAdapter<SolanaConfig> {
	readonly id = "solana";
	readonly network = "solana" as const;
	readonly configSchema = configSchema;
	readonly config: SolanaConfig;
	constructor(config: unknown) {
		this.config = this.validateConfig(config);
	}
	validateConfig(value: unknown) {
		return this.configSchema.parse(value);
	}
	async createPaymentTarget(input: { address: string; expiresAt: Date }) {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid Solana address");
		return input;
	}
	validateAddress(address: string) {
		return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
	}
	validatePayment(
		transaction: NormalizedTransaction,
		target: PaymentTarget,
		assetCode: string,
	) {
		return (
			transaction.success &&
			transaction.canonical !== false &&
			transaction.to === target.address &&
			transaction.assetCode.toUpperCase() === assetCode.toUpperCase()
		);
	}
	async getTransaction(hash: string, lookup?: TransactionLookup) {
		return observeProviderOperation(
			{
				adapter: "solana",
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
		const transaction = await this.transaction(
			hash,
			operationDeadline(this.config.timeoutMs),
			counters,
		);
		if (!transaction) return null;
		const transfer = this.transfers(transaction, hash).find(
			(item) =>
				(lookup?.address == null || item.to === lookup.address) &&
				(lookup?.assetCode == null ||
					item.assetCode.toUpperCase() === lookup.assetCode.toUpperCase()) &&
				(lookup?.eventIndex == null || item.eventIndex === lookup.eventIndex),
		);
		return transfer ?? null;
	}
	async findTransactions(input: TransactionScanInput) {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid Solana address");
		return observeProviderOperation(
			{
				adapter: "solana",
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
		const deadlineAt = operationDeadline(this.config.timeoutMs);
		const budget: ScanBudget = {
			remainingSignatures: this.config.maxScanSignatures,
			truncated: false,
		};
		const token = this.token(input.assetCode);
		const accounts = token
			? await this.tokenAccounts(
					input.address,
					token.mint,
					deadlineAt,
					counters,
				)
			: input.assetCode.toUpperCase() === this.config.nativeAsset.toUpperCase()
				? [input.address]
				: [];
		const transactions: NormalizedTransaction[] = [];
		const seen = new Set<string>();
		for (const account of accounts) {
			const signatures = await this.signatures(
				account,
				input,
				budget,
				deadlineAt,
				counters,
			);
			for (const signature of signatures) {
				if (seen.has(signature.signature) || signature.err != null) continue;
				seen.add(signature.signature);
				const raw = await this.transaction(
					signature.signature,
					deadlineAt,
					counters,
				);
				if (!raw) continue;
				transactions.push(
					...this.transfers(raw, signature.signature, {
						account,
						owner: input.address,
						assetCode: input.assetCode,
						slot: signature.slot,
						...(signature.confirmationStatus
							? { confirmationStatus: signature.confirmationStatus }
							: {}),
					}),
				);
			}
		}
		return budget.truncated ? truncatedScan(transactions) : transactions;
	}
	async getConfirmations(transaction: NormalizedTransaction) {
		return observeProviderOperation(
			{
				adapter: "solana",
				operation: "get_confirmations",
				classifyError: (error) => this.classifyError(error),
			},
			async (counters) => {
				const result = z
					.object({
						value: z.array(
							z
								.object({
									confirmationStatus: z.string().nullable().optional(),
									confirmations: z.number().nullable().optional(),
								})
								.nullable(),
						),
					})
					.parse(
						await this.rpc(
							"getSignatureStatuses",
							[[transaction.hash], { searchTransactionHistory: true }],
							undefined,
							counters,
						),
					);
				const status = result.value[0];
				return status?.confirmationStatus === "finalized"
					? 1
					: Math.max(0, status?.confirmations ?? 0);
			},
		);
	}
	async healthCheck(): Promise<AdapterHealth> {
		const started = Date.now();
		try {
			const status = await observeProviderOperation(
				{
					adapter: "solana",
					operation: "health_check",
					classifyError: (error) => this.classifyError(error),
				},
				(counters) => this.rpc<string>("getHealth", [], undefined, counters),
			);
			return {
				healthy: status === "ok",
				latencyMs: Date.now() - started,
				checkedAt: new Date(),
				...(status === "ok"
					? {}
					: { detail: "Solana RPC returned an unexpected health status" }),
			};
		} catch (error) {
			return {
				healthy: false,
				latencyMs: Date.now() - started,
				checkedAt: new Date(),
				detail: `Solana health check failed: ${this.classifyError(error)}`,
			};
		}
	}
	classifyError(error: unknown): AdapterErrorKind {
		if (error instanceof JsonRpcRequestError) {
			if (error.status === 401 || error.status === 403) return "authentication";
			if (error.status === 429) return "rate_limit";
			if (error.status >= 500) return "network";
			return "permanent";
		}
		if (
			error instanceof z.ZodError ||
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
	private symbol(mint: string) {
		return (
			Object.entries(this.config.tokens).find(
				([, token]) => token.mint === mint,
			)?.[0] ?? mint
		);
	}
	private async tokenAccounts(
		owner: string,
		mint: string,
		deadlineAt: number,
		counters: ProviderOperationCounters,
	) {
		const result = z
			.object({ value: z.array(z.object({ pubkey: z.string() })).default([]) })
			.parse(
				await this.rpc(
					"getTokenAccountsByOwner",
					[
						owner,
						{ mint },
						{ commitment: this.config.commitment, encoding: "jsonParsed" },
					],
					deadlineAt,
					counters,
				),
			);
		const accounts = [
			...new Set(result.value.map((account) => account.pubkey)),
		];
		if (accounts.length > this.config.maxTokenAccounts)
			throw new Error(
				"Solana token account scan exceeded the configured limit",
			);
		return accounts;
	}
	/**
	 * Walks signatures newest-first until the slot or block-time bound is
	 * reached. Spending the shared signature budget marks the scan truncated:
	 * the newest signatures are returned and the caller keeps its cursor.
	 */
	private async signatures(
		address: string,
		bounds: ScanBounds,
		budget: ScanBudget,
		deadlineAt: number,
		counters: ProviderOperationCounters,
	) {
		const signatures: z.infer<typeof signatureSchema>[] = [];
		let before: string | undefined;
		for (let page = 0; page < this.config.maxPages; page += 1) {
			if (budget.remainingSignatures <= 0) {
				budget.truncated = true;
				return signatures;
			}
			counters.page();
			const pageSize = Math.min(
				this.config.signaturePageSize,
				budget.remainingSignatures,
			);
			const batch = z.array(signatureSchema).parse(
				await this.rpc(
					"getSignaturesForAddress",
					[
						address,
						{
							commitment: this.config.commitment,
							limit: pageSize,
							...(before ? { before } : {}),
						},
					],
					deadlineAt,
					counters,
				),
			);
			if (batch.length > pageSize)
				throw new Error("Solana RPC exceeded the requested signature limit");
			budget.remainingSignatures -= batch.length;
			signatures.push(
				...batch.filter((signature) => withinBounds(signature, bounds)),
			);
			if (
				batch.length < pageSize ||
				batch.some((signature) => !withinBounds(signature, bounds))
			)
				return signatures;
			const next = batch.at(-1)?.signature;
			if (!next || next === before)
				throw new Error("Solana RPC repeated its signature cursor");
			before = next;
		}
		budget.truncated = true;
		return signatures;
	}
	private async transaction(
		signature: string,
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	) {
		const value = await this.rpc<unknown>(
			"getTransaction",
			[
				signature,
				{
					commitment: this.config.commitment,
					encoding: "jsonParsed",
					maxSupportedTransactionVersion: 0,
				},
			],
			deadlineAt,
			counters,
		);
		return value === null ? null : transactionSchema.parse(value);
	}
	private transfers(
		raw: z.infer<typeof transactionSchema>,
		signature: string,
		override?: {
			account: string;
			owner: string;
			assetCode: string;
			slot: number;
			confirmationStatus?: string;
		},
	) {
		const { message } = raw.transaction;
		const owners = new Map(
			(raw.meta.postTokenBalances ?? []).map((balance) => [
				message.accountKeys[balance.accountIndex],
				balance,
			]),
		);
		const instructions = [
			...message.instructions,
			...(raw.meta.innerInstructions ?? []).flatMap(
				(group) => group.instructions,
			),
		];
		const common = {
			network: "solana" as const,
			hash: signature,
			blockNumber: BigInt(override?.slot ?? raw.slot ?? 0),
			blockHash: message.recentBlockhash,
			confirmations:
				(override?.confirmationStatus ?? "finalized") === "finalized" ? 1 : 0,
			timestamp: new Date((raw.blockTime ?? 0) * 1000),
			success: raw.meta.err == null,
			canonical: true,
		};
		const out: NormalizedTransaction[] = [];
		for (const [eventIndex, item] of instructions.entries()) {
			const instruction = parsedInstructionSchema.safeParse(item);
			if (!instruction.success) continue;
			const { info } = instruction.data.parsed;
			if (override && info.destination !== override.account) continue;
			const native = systemTransferSchema.safeParse(info);
			if (
				native.success &&
				(!override ||
					override.assetCode.toUpperCase() ===
						this.config.nativeAsset.toUpperCase())
			) {
				out.push({
					...common,
					eventIndex,
					from: info.source,
					to: override?.owner ?? info.destination,
					assetCode: this.config.nativeAsset.toUpperCase(),
					amountUnits: BigInt(native.data.lamports),
				});
				continue;
			}
			const transfer = tokenTransferSchema.safeParse(info);
			if (!transfer.success) continue;
			const balance = owners.get(info.destination);
			const mint = transfer.data.mint ?? balance?.mint ?? "";
			const assetCode = override?.assetCode ?? this.symbol(mint);
			const token = this.token(assetCode);
			const amount = transfer.data.tokenAmount?.amount ?? transfer.data.amount;
			if (!token || token.mint !== mint || amount === undefined) continue;
			out.push({
				...common,
				eventIndex,
				from: info.source,
				to: override?.owner ?? balance?.owner ?? info.destination,
				assetCode: assetCode.toUpperCase(),
				amountUnits: BigInt(amount),
			});
		}
		return out;
	}
	private async rpc<T>(
		method: string,
		params: unknown[],
		deadlineAt?: number,
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
					: remainingOperationMs(deadlineAt, "Solana operation"),
			...(this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
		});
	}
}

function withinBounds(
	signature: z.infer<typeof signatureSchema>,
	bounds: ScanBounds,
) {
	return (
		(bounds.sinceBlock === undefined ||
			BigInt(signature.slot) >= bounds.sinceBlock) &&
		(bounds.sinceTimestampMs === undefined ||
			signature.blockTime == null ||
			signature.blockTime * 1000 >= bounds.sinceTimestampMs)
	);
}
