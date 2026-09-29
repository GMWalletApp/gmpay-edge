import type { z } from "zod";

export type Network =
	| "tron"
	| "ethereum"
	| "base"
	| "bsc"
	| "polygon"
	| "ton"
	| "aptos"
	| "solana"
	| "binance"
	| "okx"
	| "okpay";
export interface PaymentTarget {
	address: string;
	memo?: string;
	expiresAt: Date;
}
export interface NormalizedTransaction {
	network: Network;
	hash: string;
	eventIndex: number;
	from: string;
	to: string;
	assetCode: string;
	amountUnits: bigint;
	blockNumber: bigint;
	blockHash: string;
	confirmations: number;
	timestamp: Date;
	success: boolean;
	/** False when a previously observed event is no longer on the canonical chain. */
	canonical?: boolean;
}
export interface AdapterHealth {
	healthy: boolean;
	latencyMs: number;
	checkedAt: Date;
	detail?: string;
}
export interface TransactionLookup {
	address?: string;
	assetCode?: string;
	eventIndex?: number;
	/**
	 * When the caller last observed the transaction. Providers without a hash
	 * index bound their history search around it instead of walking everything.
	 */
	observedAtMs?: number;
}
export interface TransactionScanInput {
	address: string;
	assetCode: string;
	/** Provider block, slot, lt, version, or timestamp cursor; older results are excluded. */
	sinceBlock?: bigint;
	/**
	 * Lower time bound of the history walk, normally the order creation time
	 * minus a clock-skew margin. It keeps a shared address's lifetime history
	 * out of every scan.
	 */
	sinceTimestampMs?: number;
}
/**
 * Set when an adapter stopped before covering the requested range because a
 * row, page, or deadline budget ran out. `scannedThroughBlock` is the highest
 * block whose transfers are all included; it is absent when the unscanned
 * remainder is older than every returned transfer, so callers keep their cursor.
 */
export interface ScanTruncation {
	scannedThroughBlock?: bigint;
}
/** Array-compatible so adapters and test doubles returning a plain array remain complete scans. */
export type TransactionScan = NormalizedTransaction[] & {
	truncated?: ScanTruncation;
};
export type AdapterErrorKind =
	| "configuration"
	| "authentication"
	| "rate_limit"
	| "network"
	| "invalid_response"
	| "not_found"
	| "permanent";
export interface PaymentAdapter<TConfig> {
	readonly id: string;
	readonly network: Network;
	readonly configSchema: z.ZodType<TConfig>;
	validateConfig(value: unknown): TConfig;
	createPaymentTarget(input: {
		address: string;
		expiresAt: Date;
	}): Promise<PaymentTarget>;
	getTransaction(
		hash: string,
		lookup?: TransactionLookup,
	): Promise<NormalizedTransaction | null>;
	findTransactions(input: TransactionScanInput): Promise<TransactionScan>;
	/**
	 * Optional bounded push path. Adapters expose this only when the provider
	 * supports a real subscription transport; polling remains the fallback.
	 */
	subscribeTransactions?(input: {
		address: string;
		assetCode: string;
		signal: AbortSignal;
		onTransaction: (transaction: NormalizedTransaction) => Promise<void> | void;
	}): Promise<{ reconnects: number }>;
	validateAddress(address: string): boolean;
	validateTarget?(address: string): Promise<boolean>;
	validatePayment(
		transaction: NormalizedTransaction,
		target: PaymentTarget,
		assetCode: string,
	): boolean;
	getConfirmations(transaction: NormalizedTransaction): Promise<number>;
	healthCheck(): Promise<AdapterHealth>;
	classifyError(error: unknown): AdapterErrorKind;
	isRetryable(kind: AdapterErrorKind): boolean;
}
