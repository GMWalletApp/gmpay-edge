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

/** Canonical `workchain:hex` form for configured Jetton masters. */
const tonAddressSchema = z.string().transform((value, context) => {
	const address = tonAddress(value);
	if (address === null) {
		context.addIssue({ code: "custom", message: "Invalid TON address" });
		return z.NEVER;
	}
	return address;
});
const configSchema = z.object({
	apiUrl: z.url().default("https://toncenter.com/api/v3"),
	nativeAsset: z.string().default("GRAM"),
	tokens: z
		.record(
			z.string(),
			z.object({
				master: tonAddressSchema,
				decimals: z.number().int().min(0).max(30),
			}),
		)
		.default({}),
	apiKey: z.string().optional(),
	timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
	maxPages: z.number().int().min(1).max(500).default(50),
});
export type TonConfig = z.infer<typeof configSchema>;
type ScanBounds = Pick<TransactionScanInput, "sinceBlock" | "sinceTimestampMs">;

const optionalString = z.string().nullable().optional();
const phaseSchema = z
	.object({
		success: z.boolean().nullable().optional(),
		skipped: z.boolean().nullable().optional(),
	})
	.nullable()
	.optional();
const transactionSchema = z.object({
	hash: z.string(),
	lt: z.string().regex(/^\d+$/),
	now: z.number(),
	in_msg: z
		.object({
			source: optionalString,
			destination: optionalString,
			value: z.string().regex(/^\d+$/).nullable().optional(),
			bounced: z.boolean().nullable().optional(),
		})
		.nullable()
		.optional(),
	description: z
		.object({
			aborted: z.boolean().nullable().optional(),
			compute_ph: phaseSchema,
			action: phaseSchema,
		})
		.nullable()
		.optional(),
});
const jettonSchema = z.object({
	// TON amounts are atomic values and must remain strings until BigInt.
	amount: z.string().regex(/^\d+$/),
	destination: optionalString,
	jetton_master: z.string(),
	query_id: z.union([z.string(), z.number()]).nullable().optional(),
	source: optionalString,
	transaction_hash: z.string(),
	transaction_lt: z.string().regex(/^\d+$/).nullable().optional(),
	transaction_now: z.number(),
	transaction_aborted: z.boolean().nullable().optional(),
});
const addressBookSchema = z
	.record(
		z.string(),
		z.object({ user_friendly: z.string().nullable().optional() }).nullable(),
	)
	.optional();
type AddressBook = z.infer<typeof addressBookSchema>;

export class TonAdapter implements PaymentAdapter<TonConfig> {
	readonly id = "ton";
	readonly network = "ton" as const;
	readonly configSchema = configSchema;
	readonly config: TonConfig;
	constructor(config: unknown) {
		this.config = this.validateConfig(config);
	}
	validateConfig(value: unknown) {
		return this.configSchema.parse(value);
	}
	async createPaymentTarget(input: { address: string; expiresAt: Date }) {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid TON address");
		return input;
	}
	validateAddress(address: string) {
		return (
			/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(address) && tonAddress(address) !== null
		);
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
				adapter: "ton",
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
		const deadlineAt = operationDeadline(this.config.timeoutMs);
		const wanted =
			lookup?.address === undefined ? null : tonAddress(lookup.address);
		if (lookup?.address !== undefined && wanted === null) return null;
		const wantsNative =
			lookup?.assetCode?.toUpperCase() ===
			this.config.nativeAsset.toUpperCase();
		if (!wantsNative) {
			const jettons = await this.jettons(
				`/jetton/transfers?transaction_hash=${encodeURIComponent(hash)}&limit=100`,
				deadlineAt,
				counters,
			);
			for (const row of jettons.rows) {
				const token = this.tokenByMaster(row.jetton_master);
				if (
					token &&
					(wanted === null || tonAddress(row.destination ?? "") === wanted) &&
					(lookup?.assetCode === undefined ||
						token.assetCode === lookup.assetCode.toUpperCase()) &&
					(lookup?.eventIndex === undefined ||
						safeEventIndex(row.query_id) === lookup.eventIndex)
				)
					return this.normalizeJetton(
						row,
						lookup?.address ??
							displayAddress(row.destination ?? "", jettons.addressBook),
						token.assetCode,
						jettons.addressBook,
					);
			}
			if (lookup?.assetCode !== undefined) return null;
		}
		const transactions = await this.transactions(
			`/transactions?hash=${encodeURIComponent(hash)}&limit=1`,
			deadlineAt,
			counters,
		);
		const native = transactions.rows.find(
			(row) =>
				(wanted === null ||
					tonAddress(row.in_msg?.destination ?? "") === wanted) &&
				(lookup?.eventIndex === undefined || lookup.eventIndex === 0),
		);
		return native
			? this.normalizeNative(
					native,
					lookup?.address ??
						displayAddress(
							native.in_msg?.destination ?? "",
							transactions.addressBook,
						),
					transactions.addressBook,
				)
			: null;
	}
	async findTransactions(input: TransactionScanInput) {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid TON address");
		return observeProviderOperation(
			{
				adapter: "ton",
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
		const account = tonAddress(input.address);
		if (account === null) throw new Error("Invalid TON address");
		const bounds = `${
			input.sinceBlock === undefined ? "" : `&start_lt=${input.sinceBlock}`
		}${
			input.sinceTimestampMs === undefined
				? ""
				: `&start_utime=${Math.floor(input.sinceTimestampMs / 1000)}`
		}`;
		const token = this.token(input.assetCode);
		if (token) {
			const scan = await this.paginate(
				(offset) =>
					this.jettons(
						`/jetton/transfers?owner_address=${encodeURIComponent(account)}&jetton_master=${encodeURIComponent(token.master)}&direction=in&limit=100&sort=desc${bounds}&offset=${offset}`,
						deadlineAt,
						counters,
					),
				(row) =>
					withinBounds(
						BigInt(row.transaction_lt ?? 0),
						row.transaction_now,
						input,
					),
				counters,
			);
			const transactions = scan.rows
				.filter(
					(row) =>
						tonAddress(row.jetton_master) === token.master &&
						tonAddress(row.destination ?? "") === account &&
						withinBounds(
							BigInt(row.transaction_lt ?? 0),
							row.transaction_now,
							input,
						),
				)
				.map((row) =>
					this.normalizeJetton(
						row,
						input.address,
						token.assetCode,
						scan.addressBook,
					),
				);
			return scan.truncated ? truncatedScan(transactions) : transactions;
		}
		if (input.assetCode.toUpperCase() !== this.config.nativeAsset.toUpperCase())
			return [];
		const scan = await this.paginate(
			(offset) =>
				this.transactions(
					`/transactions?account=${encodeURIComponent(account)}&limit=100&sort=desc${bounds}&offset=${offset}`,
					deadlineAt,
					counters,
				),
			(row) => withinBounds(BigInt(row.lt), row.now, input),
			counters,
		);
		const transactions = scan.rows
			.filter(
				(row) =>
					tonAddress(row.in_msg?.destination ?? "") === account &&
					withinBounds(BigInt(row.lt), row.now, input),
			)
			.map((row) => this.normalizeNative(row, input.address, scan.addressBook));
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
					adapter: "ton",
					operation: "health_check",
					classifyError: (error) => this.classifyError(error),
				},
				(counters) => this.request("/masterchainInfo", undefined, counters),
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
				detail: `TON health check failed: ${this.classifyError(error)}`,
			};
		}
	}
	classifyError(error: unknown): AdapterErrorKind {
		if (error instanceof TonHttpError) {
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
		const entry = Object.entries(this.config.tokens).find(
			([symbol]) => symbol.toUpperCase() === assetCode.toUpperCase(),
		);
		return (
			entry && { assetCode: entry[0].toUpperCase(), master: entry[1].master }
		);
	}
	private tokenByMaster(master: string) {
		const canonical = tonAddress(master);
		const entry = Object.entries(this.config.tokens).find(
			([, token]) => token.master === canonical,
		);
		return (
			entry && { assetCode: entry[0].toUpperCase(), master: entry[1].master }
		);
	}
	private async transactions(
		path: string,
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	) {
		const payload = z
			.object({
				transactions: z.array(transactionSchema).default([]),
				address_book: addressBookSchema,
			})
			.parse(await this.request(path, deadlineAt, counters));
		return { rows: payload.transactions, addressBook: payload.address_book };
	}
	private async jettons(
		path: string,
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	) {
		const payload = z
			.object({
				jetton_transfers: z.array(jettonSchema).default([]),
				address_book: addressBookSchema,
			})
			.parse(await this.request(path, deadlineAt, counters));
		return {
			rows: payload.jetton_transfers,
			addressBook: payload.address_book,
		};
	}
	/**
	 * Offset pagination newest-first that stops at the first page reaching the
	 * caller's bounds. Spending the page budget yields the newest rows as a
	 * truncated scan instead of a permanent failure.
	 */
	private async paginate<T>(
		fetchPage: (
			offset: number,
		) => Promise<{ rows: T[]; addressBook: AddressBook }>,
		withinBounds: (row: T) => boolean,
		counters: ProviderOperationCounters,
	) {
		const rows: T[] = [];
		let addressBook: AddressBook;
		for (let page = 0; page < this.config.maxPages; page += 1) {
			counters.page();
			const batch = await fetchPage(page * 100);
			rows.push(...batch.rows);
			addressBook = { ...addressBook, ...batch.addressBook };
			if (batch.rows.length < 100 || !batch.rows.every(withinBounds))
				return { rows, addressBook, truncated: false };
		}
		return { rows, addressBook, truncated: true };
	}
	private normalizeNative(
		row: z.infer<typeof transactionSchema>,
		address: string,
		addressBook: AddressBook,
	): NormalizedTransaction {
		const success = nativeTransferSucceeded(row);
		return {
			network: "ton",
			hash: row.hash,
			eventIndex: 0,
			from: displayAddress(row.in_msg?.source ?? "", addressBook),
			to: address,
			assetCode: this.config.nativeAsset.toUpperCase(),
			amountUnits: BigInt(row.in_msg?.value ?? 0),
			blockNumber: BigInt(row.lt),
			blockHash: row.hash,
			confirmations: success ? 1 : 0,
			timestamp: new Date(row.now * 1000),
			success,
			canonical: true,
		};
	}
	private normalizeJetton(
		row: z.infer<typeof jettonSchema>,
		address: string,
		assetCode: string,
		addressBook: AddressBook,
	): NormalizedTransaction {
		// toncenter v3 attests execution through `transaction_aborted`; a missing
		// flag cannot prove success and fails closed.
		const success = row.transaction_aborted === false;
		return {
			network: "ton",
			hash: row.transaction_hash,
			eventIndex: safeEventIndex(row.query_id),
			from: displayAddress(row.source ?? "", addressBook),
			to: address,
			assetCode,
			amountUnits: BigInt(row.amount),
			blockNumber: BigInt(row.transaction_lt ?? 0),
			blockHash: row.transaction_hash,
			confirmations: success ? 1 : 0,
			timestamp: new Date(row.transaction_now * 1000),
			success,
			canonical: true,
		};
	}
	private async request(
		path: string,
		deadlineAt = operationDeadline(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	): Promise<unknown> {
		counters?.request();
		const response = await fetch(
			`${this.config.apiUrl.replace(/\/$/, "")}${path}`,
			{
				headers: {
					accept: "application/json",
					...(this.config.apiKey ? { "X-API-Key": this.config.apiKey } : {}),
				},
				signal: operationSignal(deadlineAt, "TON operation"),
			},
		);
		if (!response.ok) throw new TonHttpError(response.status);
		return readProviderJson(response);
	}
}

class TonHttpError extends Error {
	constructor(readonly status: number) {
		super(`TON Center returned HTTP ${status}`);
	}
}
/**
 * toncenter v3 reports execution per phase. Every present phase must attest
 * success and a bounced or aborted transaction never credits the account; a
 * missing description cannot prove success and fails closed. A skipped compute
 * phase (uninitialised account) still credits a non-bounceable transfer.
 */
function nativeTransferSucceeded(row: z.infer<typeof transactionSchema>) {
	const description = row.description;
	if (!description || description.aborted !== false) return false;
	if (row.in_msg?.bounced === true) return false;
	const compute = description.compute_ph;
	if (!compute || (compute.skipped !== true && compute.success !== true))
		return false;
	return description.action == null
		? compute.skipped === true
		: description.action.success === true;
}
function withinBounds(lt: bigint, unixSeconds: number, bounds: ScanBounds) {
	return (
		(bounds.sinceBlock === undefined || lt >= bounds.sinceBlock) &&
		(bounds.sinceTimestampMs === undefined ||
			unixSeconds * 1000 >= bounds.sinceTimestampMs)
	);
}
function displayAddress(value: string, addressBook: AddressBook) {
	return addressBook?.[value]?.user_friendly ?? value;
}
function safeEventIndex(value: string | number | null | undefined) {
	const parsed = Number(value ?? 0);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
/**
 * Normalises raw `workchain:hex` and user-friendly (base64 or base64url,
 * bounceable or not) addresses to one canonical raw form so provider fields
 * encoded differently compare equal. Invalid checksums yield null.
 */
function tonAddress(value: string) {
	const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(value);
	if (raw?.[1] !== undefined && raw[2] !== undefined)
		return `${Number(raw[1])}:${raw[2].toLowerCase()}`;
	if (!/^[A-Za-z0-9_+/-]{48}$/.test(value)) return null;
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(
			atob(value.replace(/-/g, "+").replace(/_/g, "/")),
			(character) => character.charCodeAt(0),
		);
	} catch {
		return null;
	}
	const tag = bytes[0];
	const workchain = bytes[1];
	const checksum = bytes[34];
	const checksumLow = bytes[35];
	if (
		bytes.length !== 36 ||
		(tag !== 0x11 && tag !== 0x51) ||
		workchain === undefined ||
		checksum === undefined ||
		checksumLow === undefined ||
		crc16(bytes.subarray(0, 34)) !== ((checksum << 8) | checksumLow)
	)
		return null;
	const hex = Array.from(bytes.subarray(2, 34), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${workchain === 0xff ? -1 : workchain}:${hex}`;
}
/** CRC-16/XMODEM as used by TON user-friendly addresses. */
function crc16(bytes: Uint8Array) {
	let crc = 0;
	for (const byte of bytes) {
		crc ^= byte << 8;
		for (let bit = 0; bit < 8; bit += 1)
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
	}
	return crc;
}
