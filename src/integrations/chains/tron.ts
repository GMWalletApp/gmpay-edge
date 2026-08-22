import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import {
	observeProviderOperation,
	type ProviderOperationCounters,
} from "../provider-observability";
import { operationDeadline, operationSignal } from "./operation-deadline";
import type {
	AdapterErrorKind,
	AdapterHealth,
	NormalizedTransaction,
	PaymentAdapter,
	PaymentTarget,
	TransactionLookup,
} from "./types";

const configSchema = z.object({
	apiUrl: z.url().default("https://api.trongrid.io"),
	apiKey: z.string().min(1).optional(),
	timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
	maxPages: z.number().int().min(1).max(500).default(50),
	maxConcurrentRequests: z.number().int().min(1).max(10).default(3),
	maxScanTransactions: z.number().int().min(1).max(10_000).default(1000),
});
export type TronConfig = z.infer<typeof configSchema>;

const envelopeSchema = z.object({
	success: z.boolean().optional(),
	data: z.array(z.unknown()).default([]),
	meta: z.object({ fingerprint: z.string().min(1).optional() }).optional(),
});
const trc20TransferSchema = z.object({
	transaction_id: z.string(),
	block_timestamp: z.number(),
	block_number: z.number(),
	from: z.string(),
	to: z.string(),
	value: z.string().regex(/^\d+$/),
	type: z.string().optional(),
	_unconfirmed: z.boolean().optional(),
	token_info: z.object({ symbol: z.string() }),
});
const atomicAmountSchema = z.union([
	z.string().regex(/^\d+$/),
	z
		.number()
		.int()
		.nonnegative()
		.refine(Number.isSafeInteger, "Atomic amount number is not safe"),
]);
const trxTransactionSchema = z.object({
	txID: z.string(),
	blockNumber: z.number(),
	block_timestamp: z.number(),
	ret: z.array(z.object({ contractRet: z.string() })).default([]),
	raw_data: z.object({
		contract: z.array(
			z.object({
				type: z.string(),
				parameter: z.object({
					value: z.object({
						amount: atomicAmountSchema,
						owner_address: z.string(),
						to_address: z.string(),
					}),
				}),
			}),
		),
	}),
});
const nowBlockSchema = z.object({
	blockID: z.string(),
	block_header: z.object({ raw_data: z.object({ number: z.number() }) }),
});

export class TronAdapter implements PaymentAdapter<TronConfig> {
	readonly id = "tron";
	readonly network = "tron" as const;
	readonly configSchema = configSchema;
	readonly config: TronConfig;
	constructor(config: unknown) {
		this.config = this.validateConfig(config);
	}
	validateConfig(value: unknown): TronConfig {
		return this.configSchema.parse(value);
	}
	async createPaymentTarget(input: {
		address: string;
		expiresAt: Date;
	}): Promise<PaymentTarget> {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid TRON address");
		return { address: input.address, expiresAt: input.expiresAt };
	}
	validateAddress(address: string): boolean {
		return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
	}
	validatePayment(
		tx: NormalizedTransaction,
		target: PaymentTarget,
		assetCode: string,
	): boolean {
		return (
			tx.success &&
			tx.canonical !== false &&
			tx.network === "tron" &&
			tx.to === target.address &&
			tx.assetCode === assetCode
		);
	}
	async getTransaction(
		hash: string,
		lookup?: TransactionLookup,
	): Promise<NormalizedTransaction | null> {
		return observeProviderOperation(
			{
				adapter: "tron",
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
		const [info, current] = await Promise.all([
			this.request<unknown>(
				"/wallet/gettransactioninfobyid",
				{
					method: "POST",
					body: JSON.stringify({ value: hash }),
				},
				deadlineAt,
				counters,
			),
			this.currentBlock(deadlineAt, counters),
		]);
		const parsedInfo = z
			.looseObject({
				id: z.string().optional(),
				blockNumber: z.number().optional(),
			})
			.parse(info);
		if (!parsedInfo.id || parsedInfo.blockNumber == null) return null;
		const blockHash = await this.blockHash(
			parsedInfo.blockNumber,
			deadlineAt,
			counters,
		);
		const wantsNative = lookup?.assetCode?.toUpperCase() === "TRX";
		const eventEnvelope = wantsNative
			? { data: [] }
			: envelopeSchema.parse(
					await this.request(
						`/v1/transactions/${encodeURIComponent(hash)}/events?event_name=Transfer&only_confirmed=false`,
						undefined,
						deadlineAt,
						counters,
					),
				);
		const event = eventEnvelope.data.find((candidate) =>
			matchesTokenEvent(candidate, lookup),
		);
		if (event) {
			const transfer = z
				.object({
					contract_address: z.string(),
					block_timestamp: z.number(),
					event_index: z.coerce.number().int().nonnegative().optional(),
					result: z.object({
						from: z.string(),
						to: z.string(),
						value: z.string().regex(/^\d+$/),
					}),
					result_type: z.record(z.string(), z.string()).optional(),
					_unconfirmed: z.boolean().optional(),
				})
				.parse(event);
			const tokenEnvelope = envelopeSchema.parse(
				await this.request(
					`/v1/trc20/info?contract_list=${encodeURIComponent(transfer.contract_address)}`,
					undefined,
					deadlineAt,
					counters,
				),
			);
			const token = z
				.object({ symbol: z.string() })
				.parse(tokenEnvelope.data[0]);
			if (
				lookup?.assetCode &&
				token.symbol.toUpperCase() !== lookup.assetCode.toUpperCase()
			)
				return null;
			return this.normalizeTokenEvent(
				hash,
				parsedInfo.blockNumber,
				transfer,
				token.symbol,
				current,
				blockHash,
			);
		}
		const raw = trxTransactionSchema.parse(
			await this.request(
				"/wallet/gettransactionbyid",
				{
					method: "POST",
					body: JSON.stringify({ value: hash }),
				},
				deadlineAt,
				counters,
			),
		);
		const normalized = this.normalizeTrx(raw, current, blockHash, lookup);
		return lookup?.assetCode && lookup.assetCode.toUpperCase() !== "TRX"
			? null
			: normalized;
	}
	async findTransactions(input: {
		address: string;
		assetCode: string;
		sinceBlock?: bigint;
	}): Promise<NormalizedTransaction[]> {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid TRON address");
		return observeProviderOperation(
			{
				adapter: "tron",
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
	): Promise<NormalizedTransaction[]> {
		const deadlineAt = operationDeadline(this.config.timeoutMs);
		const current = await this.currentBlock(deadlineAt, counters);
		const path =
			input.assetCode.toUpperCase() === "TRX"
				? `/v1/accounts/${input.address}/transactions?only_to=true&limit=200&order_by=block_timestamp,desc`
				: `/v1/accounts/${input.address}/transactions/trc20?only_to=true&limit=200&order_by=block_timestamp,desc`;
		const rows = await this.accountTransactions(path, deadlineAt, counters);
		const blockHashes = new Map<number, Promise<string>>();
		const blockHash = (blockNumber: number) => {
			let pending = blockHashes.get(blockNumber);
			if (!pending) {
				pending = this.blockHash(blockNumber, deadlineAt, counters);
				blockHashes.set(blockNumber, pending);
			}
			return pending;
		};
		const transactions =
			input.assetCode.toUpperCase() === "TRX"
				? await mapConcurrently(
						rows
							.map((row) => trxTransactionSchema.parse(row))
							.filter(
								(row) =>
									input.sinceBlock == null ||
									BigInt(row.blockNumber) >= input.sinceBlock,
							),
						this.config.maxConcurrentRequests,
						async (row) => {
							return this.normalizeTrx(
								row,
								current,
								await blockHash(row.blockNumber),
							);
						},
					)
				: await mapConcurrently(
						rows
							.map((row) => trc20TransferSchema.parse(row))
							.filter(
								(row) =>
									row.to === input.address &&
									row.token_info.symbol.toUpperCase() ===
										input.assetCode.toUpperCase() &&
									(input.sinceBlock == null ||
										BigInt(row.block_number) >= input.sinceBlock),
							),
						this.config.maxConcurrentRequests,
						async (row) => {
							return this.normalizeTrc20(
								row,
								current,
								await blockHash(row.block_number),
							);
						},
					);
		return transactions.filter(
			(transaction) =>
				transaction.to === input.address &&
				transaction.assetCode.toUpperCase() === input.assetCode.toUpperCase() &&
				(input.sinceBlock == null ||
					transaction.blockNumber >= input.sinceBlock),
		);
	}
	private async accountTransactions(
		path: string,
		deadlineAt: number,
		counters: ProviderOperationCounters,
	) {
		const rows: unknown[] = [];
		const seen = new Set<string>();
		let fingerprint: string | undefined;
		for (let page = 0; page < this.config.maxPages; page += 1) {
			counters.page();
			const separator = path.includes("?") ? "&" : "?";
			const envelope = envelopeSchema.parse(
				await this.request(
					fingerprint
						? `${path}${separator}fingerprint=${encodeURIComponent(fingerprint)}`
						: path,
					undefined,
					deadlineAt,
					counters,
				),
			);
			if (rows.length + envelope.data.length > this.config.maxScanTransactions)
				throw new Error(
					"TRON transaction scan exceeded the configured row limit",
				);
			rows.push(...envelope.data);
			const next = envelope.meta?.fingerprint;
			if (!next) return rows;
			if (rows.length >= this.config.maxScanTransactions)
				throw new Error(
					"TRON transaction scan exceeded the configured row limit",
				);
			if (seen.has(next))
				throw new Error("TRON API repeated its pagination cursor");
			seen.add(next);
			fingerprint = next;
		}
		throw new Error(
			"TRON transaction pagination exceeded the configured limit",
		);
	}
	async getConfirmations(transaction: NormalizedTransaction): Promise<number> {
		return observeProviderOperation(
			{
				adapter: "tron",
				operation: "get_confirmations",
				classifyError: (error) => this.classifyError(error),
			},
			async (counters) => {
				const current = await this.currentBlock(undefined, counters);
				return confirmations(current.number, Number(transaction.blockNumber));
			},
		);
	}
	async healthCheck(): Promise<AdapterHealth> {
		const started = Date.now();
		try {
			await observeProviderOperation(
				{
					adapter: "tron",
					operation: "health_check",
					classifyError: (error) => this.classifyError(error),
				},
				(counters) => this.currentBlock(undefined, counters),
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
				detail: `TRON health check failed: ${this.classifyError(error)}`,
			};
		}
	}
	classifyError(error: unknown): AdapterErrorKind {
		if (error instanceof TronHttpError) {
			if (error.status === 401 || error.status === 403) return "authentication";
			if (error.status === 404) return "not_found";
			if (error.status === 429) return "rate_limit";
			if (error.status >= 500) return "network";
			return "permanent";
		}
		if (error instanceof z.ZodError) return "invalid_response";
		if (error instanceof TypeError || error instanceof DOMException)
			return "network";
		return "permanent";
	}
	isRetryable(kind: AdapterErrorKind): boolean {
		return (
			kind === "network" || kind === "rate_limit" || kind === "invalid_response"
		);
	}

	private async currentBlock(
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	) {
		const block = nowBlockSchema.parse(
			await this.request(
				"/wallet/getnowblock",
				undefined,
				deadlineAt,
				counters,
			),
		);
		return { number: block.block_header.raw_data.number };
	}
	private async blockHash(
		blockNumber: number,
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	) {
		const block = nowBlockSchema.parse(
			await this.request(
				"/wallet/getblockbynum",
				{
					method: "POST",
					body: JSON.stringify({ num: blockNumber }),
				},
				deadlineAt,
				counters,
			),
		);
		if (block.block_header.raw_data.number !== blockNumber)
			throw new Error("TRON API returned the wrong block");
		return block.blockID;
	}
	private async request<T>(
		path: string,
		init?: RequestInit,
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	): Promise<T> {
		counters?.request();
		const response = await fetch(
			`${this.config.apiUrl.replace(/\/$/, "")}${path}`,
			{
				...init,
				signal: operationSignal(deadlineAt, "TRON operation"),
				headers: {
					"content-type": "application/json",
					...(this.config.apiKey
						? { "TRON-PRO-API-KEY": this.config.apiKey }
						: {}),
					...init?.headers,
				},
			},
		);
		if (!response.ok) throw new TronHttpError(response.status);
		return (await response.json()) as T;
	}
	private normalizeTrc20(
		row: z.infer<typeof trc20TransferSchema>,
		current: { number: number },
		blockHash: string,
	): NormalizedTransaction {
		return {
			network: "tron",
			hash: row.transaction_id,
			eventIndex: 0,
			from: row.from,
			to: row.to,
			assetCode: row.token_info.symbol.toUpperCase(),
			amountUnits: BigInt(row.value),
			blockNumber: BigInt(row.block_number),
			blockHash,
			confirmations: row._unconfirmed
				? 0
				: confirmations(current.number, row.block_number),
			timestamp: new Date(row.block_timestamp),
			success: true,
			canonical: true,
		};
	}
	private normalizeTrx(
		row: z.infer<typeof trxTransactionSchema>,
		current: { number: number },
		blockHash: string,
		lookup?: TransactionLookup,
	): NormalizedTransaction {
		const transfer = row.raw_data.contract.find(
			(contract) =>
				contract.type === "TransferContract" &&
				(lookup?.address == null ||
					tronHexToBase58(contract.parameter.value.to_address) ===
						lookup.address),
		);
		if (!transfer) throw new Error("Unsupported TRON transaction contract");
		return {
			network: "tron",
			hash: row.txID,
			eventIndex: 0,
			from: tronHexToBase58(transfer.parameter.value.owner_address),
			to: tronHexToBase58(transfer.parameter.value.to_address),
			assetCode: "TRX",
			amountUnits: BigInt(transfer.parameter.value.amount),
			blockNumber: BigInt(row.blockNumber),
			blockHash,
			confirmations: confirmations(current.number, row.blockNumber),
			timestamp: new Date(row.block_timestamp),
			success: row.ret.every((result) => result.contractRet === "SUCCESS"),
			canonical: true,
		};
	}
	private normalizeTokenEvent(
		hash: string,
		blockNumber: number,
		event: {
			contract_address: string;
			block_timestamp: number;
			event_index?: number | undefined;
			result: { from: string; to: string; value: string };
			_unconfirmed?: boolean | undefined;
		},
		symbol: string,
		current: { number: number },
		blockHash: string,
	): NormalizedTransaction {
		return {
			network: "tron",
			hash,
			eventIndex: Number(event.event_index ?? 0),
			from: normalizeTronEventAddress(event.result.from),
			to: normalizeTronEventAddress(event.result.to),
			assetCode: symbol.toUpperCase(),
			amountUnits: BigInt(event.result.value),
			blockNumber: BigInt(blockNumber),
			blockHash,
			confirmations: event._unconfirmed
				? 0
				: confirmations(current.number, blockNumber),
			timestamp: new Date(event.block_timestamp),
			success: true,
			canonical: true,
		};
	}
}

async function mapConcurrently<T, R>(
	items: readonly T[],
	concurrency: number,
	map: (item: T) => Promise<R>,
) {
	const results = new Array<R>(items.length);
	const entries = items.map((item, index) => ({ index, item }));
	let nextIndex = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
			while (nextIndex < entries.length) {
				const entry = entries[nextIndex];
				nextIndex += 1;
				if (!entry) break;
				results[entry.index] = await map(entry.item);
			}
		}),
	);
	return results;
}

class TronHttpError extends Error {
	constructor(readonly status: number) {
		super(`TRON API returned HTTP ${status}`);
	}
}
function confirmations(current: number, block: number) {
	return Math.max(0, current - block + 1);
}
function matchesTokenEvent(candidate: unknown, lookup?: TransactionLookup) {
	if (!lookup?.address && lookup?.eventIndex == null) return true;
	const parsed = z
		.object({
			event_index: z.coerce.number().int().nonnegative().optional(),
			result: z.object({ to: z.string() }),
		})
		.safeParse(candidate);
	if (!parsed.success) return false;
	try {
		return (
			(lookup.address == null ||
				normalizeTronEventAddress(parsed.data.result.to) === lookup.address) &&
			(lookup.eventIndex == null ||
				(parsed.data.event_index ?? 0) === lookup.eventIndex)
		);
	} catch {
		return false;
	}
}
function tronHexToBase58(value: string) {
	const bytes = Uint8Array.from(
		value.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [],
	);
	if (bytes.length !== 21 || bytes[0] !== 0x41)
		throw new Error("Invalid TRON hex address");
	const checksum = sha256(sha256(bytes)).slice(0, 4);
	return base58Encode(Uint8Array.from([...bytes, ...checksum]));
}
function normalizeTronEventAddress(value: string) {
	if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) return value;
	const hex = value.replace(/^0x/i, "");
	if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 40)
		throw new Error("Invalid TRON event address");
	return tronHexToBase58(`41${hex.slice(-40)}`);
}
function base58Encode(bytes: Uint8Array) {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
	let value = BigInt(
		`0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
	);
	let output = "";
	while (value > 0n) {
		output = alphabet[Number(value % 58n)] + output;
		value /= 58n;
	}
	for (const byte of bytes) {
		if (byte !== 0) break;
		output = `1${output}`;
	}
	return output;
}
