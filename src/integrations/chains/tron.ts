import { sha256 } from "@noble/hashes/sha2.js";
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

const base58AddressPattern = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const configSchema = z.object({
	apiUrl: z.url().default("https://api.trongrid.io"),
	apiKey: z.string().min(1).optional(),
	tokens: z
		.record(
			z.string(),
			z.object({
				address: z.string().regex(base58AddressPattern),
				decimals: z.number().int().min(0).max(30),
			}),
		)
		.default({}),
	timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
	maxPages: z.number().int().min(1).max(500).default(50),
	maxConcurrentRequests: z.number().int().min(1).max(10).default(3),
	maxScanTransactions: z.number().int().min(1).max(10_000).default(1000),
});
export type TronConfig = z.infer<typeof configSchema>;
type TokenConfiguration = { assetCode: string; address: string };

/** Accepts Base58Check, node hex (`41…`), and TVM event words; yields Base58Check. */
const tronAddressSchema = z.string().transform((value, context) => {
	const address = tronAddress(value);
	if (address === null) {
		context.addIssue({ code: "custom", message: "Invalid TRON address" });
		return z.NEVER;
	}
	return address;
});
const envelopeSchema = z.object({
	success: z.boolean().optional(),
	data: z.array(z.unknown()).default([]),
	meta: z.object({ fingerprint: z.string().min(1).optional() }).optional(),
});
/** Fields shared by both account history endpoints that bound the walk; only TRX rows carry a block number. */
const historyRowSchema = z.object({
	block_timestamp: z.number(),
	blockNumber: z.number().optional(),
});
/** TRC20 history rows identify a transfer only by transaction; its block comes from the Transfer event. */
const trc20RowSchema = z.object({
	transaction_id: z.string(),
	block_timestamp: z.number(),
	to: tronAddressSchema,
	token_info: z.object({ address: tronAddressSchema }),
});
const tokenEventSchema = z.object({
	contract_address: tronAddressSchema,
	block_number: z.number(),
	block_timestamp: z.number(),
	event_index: z.coerce.number().int().nonnegative(),
	result: z.object({
		from: tronAddressSchema,
		to: tronAddressSchema,
		value: z.string().regex(/^\d+$/),
	}),
	_unconfirmed: z.boolean().optional(),
});
const atomicAmountSchema = z.union([
	z.string().regex(/^\d+$/),
	z
		.number()
		.int()
		.nonnegative()
		.refine(Number.isSafeInteger, "Atomic amount number is not safe"),
]);
const transferValueSchema = z.object({
	amount: atomicAmountSchema,
	owner_address: tronAddressSchema,
	to_address: tronAddressSchema,
});
const trxTransactionSchema = z.object({
	txID: z.string(),
	blockNumber: z.number(),
	block_timestamp: z.number(),
	ret: z.array(z.object({ contractRet: z.string() })).default([]),
	raw_data: z.object({
		contract: z.array(
			z.object({
				type: z.string(),
				parameter: z.object({ value: z.unknown() }),
			}),
		),
	}),
});
const transactionInfoSchema = z.looseObject({
	id: z.string().optional(),
	blockNumber: z.number().optional(),
	receipt: z.looseObject({ result: z.string().optional() }).optional(),
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
		return base58AddressPattern.test(address);
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
			this.request(
				"/wallet/gettransactioninfobyid",
				{ method: "POST", body: JSON.stringify({ value: hash }) },
				deadlineAt,
				counters,
			),
			this.currentBlock(deadlineAt, counters),
		]);
		const parsedInfo = transactionInfoSchema.parse(info);
		if (!parsedInfo.id || parsedInfo.blockNumber == null) return null;
		const wantsNative = lookup?.assetCode?.toUpperCase() === "TRX";
		const token = wantsNative
			? undefined
			: lookup?.assetCode
				? this.token(lookup.assetCode)
				: this.firstToken();
		if (!wantsNative && lookup?.assetCode && !token) return null;
		const blockHash = await this.blockHash(
			parsedInfo.blockNumber,
			deadlineAt,
			counters,
		);
		if (token) {
			const [event] = this.matchingTokenEvents(
				await this.transferEvents(hash, deadlineAt, counters),
				token,
				lookup?.address,
				lookup?.eventIndex,
			);
			return event
				? this.normalizeTokenEvent(
						hash,
						parsedInfo.blockNumber,
						event,
						token.assetCode,
						current,
						blockHash,
						parsedInfo.receipt?.result === "SUCCESS",
					)
				: null;
		}
		const raw = trxTransactionSchema.safeParse(
			await this.request(
				"/wallet/gettransactionbyid",
				{ method: "POST", body: JSON.stringify({ value: hash }) },
				deadlineAt,
				counters,
			),
		);
		return raw.success
			? this.normalizeTrx(raw.data, current, blockHash, lookup?.address)
			: null;
	}
	async findTransactions(
		input: TransactionScanInput,
	): Promise<TransactionScan> {
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
		input: TransactionScanInput,
		counters: ProviderOperationCounters,
	): Promise<TransactionScan> {
		const deadlineAt = operationDeadline(this.config.timeoutMs);
		const wantsNative = input.assetCode.toUpperCase() === "TRX";
		const token = wantsNative ? undefined : this.token(input.assetCode);
		if (!wantsNative && !token) return [];
		const current = await this.currentBlock(deadlineAt, counters);
		const query = `only_to=true&limit=200&order_by=block_timestamp,desc${
			input.sinceTimestampMs === undefined
				? ""
				: `&min_timestamp=${input.sinceTimestampMs}`
		}`;
		const history = await this.accountHistory(
			token
				? `/v1/accounts/${input.address}/transactions/trc20?${query}&contract_address=${token.address}`
				: `/v1/accounts/${input.address}/transactions?${query}`,
			input,
			deadlineAt,
			counters,
		);
		const blockHashes = new Map<number, Promise<string>>();
		const blockHash = (blockNumber: number) => {
			let pending = blockHashes.get(blockNumber);
			if (!pending) {
				pending = this.blockHash(blockNumber, deadlineAt, counters);
				blockHashes.set(blockNumber, pending);
			}
			return pending;
		};
		const transactions = token
			? await this.tokenTransfers(
					history.rows,
					token,
					input,
					current,
					blockHash,
					deadlineAt,
					counters,
				)
			: (
					await mapConcurrently(
						history.rows
							.map((row) => trxTransactionSchema.parse(row))
							.filter((row) =>
								withinBounds(row.blockNumber, row.block_timestamp, input),
							),
						this.config.maxConcurrentRequests,
						async (row) =>
							this.normalizeTrx(
								row,
								current,
								await blockHash(row.blockNumber),
								input.address,
							),
					)
				).filter(
					(transaction): transaction is NormalizedTransaction =>
						transaction !== null,
				);
		return history.truncated ? truncatedScan(transactions) : transactions;
	}
	/**
	 * Walks TronGrid fingerprints newest-first and stops at the first page that
	 * reaches the caller's bounds. Exhausting the row or page budget yields the
	 * newest rows as a truncated scan instead of a permanent failure.
	 */
	private async accountHistory(
		path: string,
		bounds: Pick<TransactionScanInput, "sinceBlock" | "sinceTimestampMs">,
		deadlineAt: number,
		counters: ProviderOperationCounters,
	) {
		const rows: unknown[] = [];
		const seen = new Set<string>();
		let fingerprint: string | undefined;
		for (let page = 0; page < this.config.maxPages; page += 1) {
			counters.page();
			const envelope = envelopeSchema.parse(
				await this.request(
					fingerprint
						? `${path}&fingerprint=${encodeURIComponent(fingerprint)}`
						: path,
					undefined,
					deadlineAt,
					counters,
				),
			);
			const room = this.config.maxScanTransactions - rows.length;
			if (envelope.data.length > room) {
				rows.push(...envelope.data.slice(0, room));
				return { rows, truncated: true };
			}
			rows.push(...envelope.data);
			const reachedBounds = envelope.data.some((row) => {
				const parsed = historyRowSchema.safeParse(row);
				return (
					parsed.success &&
					!withinBounds(
						parsed.data.blockNumber,
						parsed.data.block_timestamp,
						bounds,
					)
				);
			});
			const next = envelope.meta?.fingerprint;
			if (!next || reachedBounds) return { rows, truncated: false };
			if (seen.has(next))
				throw new Error("TRON API repeated its pagination cursor");
			seen.add(next);
			fingerprint = next;
		}
		return { rows, truncated: true };
	}
	/**
	 * The TRC20 history endpoint identifies a transfer only by transaction, so
	 * each transaction's Transfer events are read once to give every transfer
	 * its real event index. Two same-token transfers in one transaction stay
	 * distinct and hash refreshes resolve the identical event.
	 */
	private async tokenTransfers(
		rows: unknown[],
		token: TokenConfiguration,
		input: TransactionScanInput,
		current: { number: number },
		blockHash: (blockNumber: number) => Promise<string>,
		deadlineAt: number,
		counters: ProviderOperationCounters,
	) {
		const hashes = new Set<string>();
		for (const raw of rows) {
			const row = trc20RowSchema.parse(raw);
			if (
				row.to === input.address &&
				row.token_info.address === token.address &&
				withinBounds(undefined, row.block_timestamp, input)
			)
				hashes.add(row.transaction_id);
		}
		const groups = await mapConcurrently(
			[...hashes],
			this.config.maxConcurrentRequests,
			async (hash) => {
				const events = this.matchingTokenEvents(
					await this.transferEvents(hash, deadlineAt, counters),
					token,
					input.address,
				).filter((event) =>
					withinBounds(event.block_number, event.block_timestamp, input),
				);
				const [first] = events;
				if (!first) return [];
				// Every event of one transaction shares its block.
				const hashOfBlock = await blockHash(first.block_number);
				// TVM persists Transfer logs only for successful executions.
				return events.map((event) =>
					this.normalizeTokenEvent(
						hash,
						first.block_number,
						event,
						token.assetCode,
						current,
						hashOfBlock,
						true,
					),
				);
			},
		);
		return groups.flat();
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
		if (
			error instanceof z.ZodError ||
			error instanceof ProviderResponseTooLargeError
		)
			return "invalid_response";
		if (error instanceof TypeError || error instanceof DOMException)
			return "network";
		return "permanent";
	}
	isRetryable(kind: AdapterErrorKind): boolean {
		return (
			kind === "network" || kind === "rate_limit" || kind === "invalid_response"
		);
	}

	private token(assetCode: string): TokenConfiguration | undefined {
		const entry = Object.entries(this.config.tokens).find(
			([symbol]) => symbol.toUpperCase() === assetCode.toUpperCase(),
		);
		return (
			entry && { assetCode: entry[0].toUpperCase(), address: entry[1].address }
		);
	}
	private firstToken(): TokenConfiguration | undefined {
		const entry = Object.entries(this.config.tokens)[0];
		return (
			entry && { assetCode: entry[0].toUpperCase(), address: entry[1].address }
		);
	}
	private async transferEvents(
		hash: string,
		deadlineAt: number,
		counters: ProviderOperationCounters,
	) {
		return envelopeSchema.parse(
			await this.request(
				`/v1/transactions/${encodeURIComponent(hash)}/events?event_name=Transfer&only_confirmed=false&limit=200`,
				undefined,
				deadlineAt,
				counters,
			),
		).data;
	}
	private matchingTokenEvents(
		events: unknown[],
		token: TokenConfiguration,
		address?: string,
		eventIndex?: number,
	) {
		return events
			.flatMap((candidate) => {
				const parsed = tokenEventSchema.safeParse(candidate);
				return parsed.success ? [parsed.data] : [];
			})
			.filter(
				(event) =>
					event.contract_address === token.address &&
					(address === undefined || event.result.to === address) &&
					(eventIndex === undefined || event.event_index === eventIndex),
			)
			.sort((left, right) => left.event_index - right.event_index);
	}
	/** Confirmations count from the solidified head so unsolidified blocks report zero. */
	private async currentBlock(
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	) {
		const block = nowBlockSchema.parse(
			await this.request(
				"/walletsolidity/getnowblock",
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
				{ method: "POST", body: JSON.stringify({ num: blockNumber }) },
				deadlineAt,
				counters,
			),
		);
		if (block.block_header.raw_data.number !== blockNumber)
			throw new Error("TRON API returned the wrong block");
		return block.blockID;
	}
	private async request(
		path: string,
		init?: RequestInit,
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	): Promise<unknown> {
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
		return readProviderJson(response);
	}
	private normalizeTrx(
		row: z.infer<typeof trxTransactionSchema>,
		current: { number: number },
		blockHash: string,
		address?: string,
	): NormalizedTransaction | null {
		// Only TransferContract entries carry TRX; other contract types in the
		// account history (TRC10, contract calls) are not native payments.
		const transfer = row.raw_data.contract
			.filter((contract) => contract.type === "TransferContract")
			.map((contract) => transferValueSchema.parse(contract.parameter.value))
			.find((value) => address === undefined || value.to_address === address);
		if (!transfer) return null;
		return {
			network: "tron",
			hash: row.txID,
			eventIndex: 0,
			from: transfer.owner_address,
			to: transfer.to_address,
			assetCode: "TRX",
			amountUnits: BigInt(transfer.amount),
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
		event: z.infer<typeof tokenEventSchema>,
		assetCode: string,
		current: { number: number },
		blockHash: string,
		success: boolean,
	): NormalizedTransaction {
		return {
			network: "tron",
			hash,
			eventIndex: event.event_index,
			from: event.result.from,
			to: event.result.to,
			assetCode,
			amountUnits: BigInt(event.result.value),
			blockNumber: BigInt(blockNumber),
			blockHash,
			confirmations: event._unconfirmed
				? 0
				: confirmations(current.number, blockNumber),
			timestamp: new Date(event.block_timestamp),
			success,
			canonical: true,
		};
	}
}

/** A row without a block number (TRC20 history) is bounded by its timestamp alone. */
function withinBounds(
	blockNumber: number | undefined,
	blockTimestampMs: number,
	bounds: Pick<TransactionScanInput, "sinceBlock" | "sinceTimestampMs">,
) {
	return (
		(bounds.sinceBlock === undefined ||
			blockNumber === undefined ||
			BigInt(blockNumber) >= bounds.sinceBlock) &&
		(bounds.sinceTimestampMs === undefined ||
			blockTimestampMs >= bounds.sinceTimestampMs)
	);
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
function tronAddress(value: string) {
	if (base58AddressPattern.test(value)) return value;
	const hex = value.replace(/^0x/i, "");
	if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 40) return null;
	// Node hex (`41` + 20 bytes) and 32-byte TVM event words both end with the account id.
	return tronHexToBase58(`41${hex.slice(-40)}`);
}
function tronHexToBase58(value: string) {
	const bytes = Uint8Array.from(
		value.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [],
	);
	const checksum = sha256(sha256(bytes)).slice(0, 4);
	return base58Encode(Uint8Array.from([...bytes, ...checksum]));
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
