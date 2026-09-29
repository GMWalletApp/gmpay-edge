import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import type {
	AdapterErrorKind,
	AdapterHealth,
	NormalizedTransaction,
	PaymentAdapter,
	PaymentTarget,
	TransactionLookup,
	TransactionScanInput,
} from "#/integrations/chains/types";
import {
	observeProviderOperation,
	type ProviderOperationCounters,
} from "#/integrations/provider-observability";
import {
	ProviderResponseTooLargeError,
	readProviderJson,
} from "#/integrations/provider-response";
import { decimalPlaces, decimalToUnits } from "#/lib/money";

const configSchema = z.object({
	apiKey: z.string().trim().min(1),
	secretKey: z.string().trim().min(1),
	apiUrl: z.url().default("https://api-gcp.binance.com"),
	assetDecimals: z
		.record(z.string(), z.number().int().min(0).max(30))
		.default({ USDT: 8, USDC: 8 }),
	timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
	lookbackMs: z
		.number()
		.int()
		.min(60_000)
		.max(90 * 86_400_000)
		.default(3_600_000),
	maxHistoryRequests: z.number().int().min(1).max(1000).default(100),
});
export type BinanceConfig = z.infer<typeof configSchema>;
type RequestBudget = { deadlineAt: number; clockRetryAvailable: boolean };
const rowSchema = z.object({
	// Binance Pay returns monetary values as decimal strings. Keeping this
	// boundary strict prevents JSON numbers from losing precision before the
	// value is converted to atomic units.
	amount: z.string().optional(),
	currency: z.string().optional(),
	fundsDetail: z
		.array(
			z.object({
				amount: z.string(),
				currency: z.string(),
			}),
		)
		.optional(),
	receiverInfo: z
		.object({ binanceId: z.union([z.string(), z.number()]).optional() })
		.optional(),
	transactionId: z.union([z.string(), z.number()]),
	transactionTime: z.union([z.string(), z.number()]),
});

export class BinancePayAdapter implements PaymentAdapter<BinanceConfig> {
	readonly id = "binance";
	readonly network = "binance" as const;
	readonly configSchema = configSchema;
	readonly config: BinanceConfig;
	private clockOffsetMs = 0;
	constructor(config: unknown) {
		this.config = this.validateConfig(config);
	}
	validateConfig(value: unknown) {
		return this.configSchema.parse(value);
	}
	async createPaymentTarget(input: { address: string; expiresAt: Date }) {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid Binance account ID");
		return input;
	}
	validateAddress(address: string) {
		return /^[1-9]\d*$/.test(address);
	}
	validatePayment(
		transaction: NormalizedTransaction,
		target: PaymentTarget,
		assetCode: string,
	) {
		return (
			transaction.success &&
			transaction.to === target.address &&
			transaction.assetCode === assetCode.toUpperCase()
		);
	}
	async getTransaction(hash: string, lookup?: TransactionLookup) {
		return observeProviderOperation(
			{
				adapter: "binance",
				operation: "get_transaction",
				classifyError: (error) => this.classifyError(error),
			},
			async (counters) => {
				// Pay history has no transaction-id index. A known observation time
				// bounds the walk to one lookback on either side; only unknown ids
				// fall back to the provider's full 90-day retention.
				const observedAtMs = lookup?.observedAtMs;
				const rows =
					observedAtMs === undefined
						? await this.completeHistory(
								Date.now() - 90 * 86_400_000,
								Date.now(),
								counters,
							)
						: await this.completeHistory(
								observedAtMs - this.config.lookbackMs,
								observedAtMs + this.config.lookbackMs,
								counters,
							);
				const row = rows.find((item) => String(item.transactionId) === hash);
				return row && hasPositiveFund(row, undefined)
					? this.normalize(row, undefined)
					: null;
			},
		);
	}
	async findTransactions(input: TransactionScanInput) {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid Binance account ID");
		return observeProviderOperation(
			{
				adapter: "binance",
				operation: "find_transactions",
				classifyError: (error) => this.classifyError(error),
			},
			async (counters) => {
				const end = Date.now();
				const start =
					input.sinceBlock == null
						? (input.sinceTimestampMs ?? end - this.config.lookbackMs)
						: Number(input.sinceBlock);
				return (await this.completeHistory(start, end, counters)).flatMap(
					(row) => {
						if (String(row.receiverInfo?.binanceId ?? "") !== input.address)
							return [];
						if (!hasPositiveFund(row, input.assetCode)) return [];
						const normalized = this.normalize(row, input.assetCode);
						return normalized &&
							normalized.assetCode === input.assetCode.toUpperCase()
							? [normalized]
							: [];
					},
				);
			},
		);
	}
	async getConfirmations(transaction: NormalizedTransaction) {
		return transaction.success ? 1 : 0;
	}
	async healthCheck(): Promise<AdapterHealth> {
		const started = Date.now();
		try {
			// Probe the exact signed API used by payment detection. The Spot
			// /api/v3/account response does not expose a Binance Pay UID and may
			// require unrelated permissions, so it is not a valid health check.
			await observeProviderOperation(
				{
					adapter: "binance",
					operation: "health_check",
					classifyError: (error) => this.classifyError(error),
				},
				(counters) =>
					this.history(
						started - 60_000,
						started,
						requestBudget(this.config.timeoutMs),
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
				detail: `Binance health check failed: ${this.classifyError(error)}`,
			};
		}
	}
	classifyError(error: unknown): AdapterErrorKind {
		if (error instanceof BinanceHttpError) {
			if (error.status === 401 || error.status === 403 || error.code === -2015)
				return "authentication";
			if (error.status === 429 || error.status === 418) return "rate_limit";
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
	private async history(
		startTime: number,
		endTime: number,
		budget: RequestBudget = requestBudget(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	) {
		const payload = z
			.object({
				code: z.string().optional(),
				success: z.boolean().optional(),
				data: z.array(rowSchema).default([]),
			})
			.parse(
				await this.signedGet(
					"/sapi/v1/pay/transactions",
					{
						startTime: String(startTime),
						endTime: String(endTime),
						limit: "100",
					},
					budget,
					counters,
				),
			);
		if (
			payload.success === false ||
			(payload.code && payload.code !== "000000")
		)
			throw new Error("Binance Pay history request failed");
		return payload.data;
	}
	private async completeHistory(
		startTime: number,
		endTime: number,
		counters: ProviderOperationCounters,
	) {
		const budget = requestBudget(this.config.timeoutMs);
		const windows: Array<{ start: number; end: number }> = [
			{ start: startTime, end: endTime },
		];
		const rows = new Map<string, z.infer<typeof rowSchema>>();
		let requests = 0;
		while (windows.length) {
			if (requests >= this.config.maxHistoryRequests)
				throw new Error("Binance Pay history exceeded the request limit");
			const window = windows.pop();
			if (!window) break;
			requests += 1;
			counters.page();
			const batch = await this.history(
				window.start,
				window.end,
				budget,
				counters,
			);
			if (batch.length < 100) {
				for (const row of batch) rows.set(String(row.transactionId), row);
				continue;
			}
			if (window.end <= window.start)
				throw new Error(
					"Binance Pay returned a truncated history window that cannot be split",
				);
			const midpoint = Math.floor((window.start + window.end) / 2);
			windows.push(
				{ start: midpoint + 1, end: window.end },
				{ start: window.start, end: midpoint },
			);
		}
		return [...rows.values()].sort(
			(left, right) =>
				normalizeTimestamp(left.transactionTime) -
				normalizeTimestamp(right.transactionTime),
		);
	}
	private normalize(
		row: z.infer<typeof rowSchema>,
		wantedAsset?: string,
	): NormalizedTransaction | null {
		const funds = row.fundsDetail?.length
			? row.fundsDetail
			: row.amount != null && row.currency
				? [{ amount: row.amount, currency: row.currency }]
				: [];
		const fund = funds.find(
			(item) =>
				(!wantedAsset ||
					item.currency.toUpperCase() === wantedAsset.toUpperCase()) &&
				isPositiveDecimal(item.amount),
		);
		if (!fund) return null;
		const symbol = fund.currency.toUpperCase();
		const timestamp = normalizeTimestamp(row.transactionTime);
		const id = String(row.transactionId);
		return {
			network: "binance",
			hash: id,
			eventIndex: 0,
			from: "binance-pay",
			to: String(row.receiverInfo?.binanceId ?? ""),
			assetCode: symbol,
			amountUnits: decimalToUnits(
				String(fund.amount),
				this.config.assetDecimals[symbol] ?? 8,
			),
			blockNumber: BigInt(timestamp),
			blockHash: `binance:${id}`,
			confirmations: 1,
			timestamp: new Date(timestamp),
			success: true,
			canonical: true,
		};
	}
	private async signedGet(
		path: string,
		params: Record<string, string> = {},
		budget: RequestBudget = requestBudget(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	): Promise<unknown> {
		const query = new URLSearchParams({
			...params,
			recvWindow: "5000",
			timestamp: String(Date.now() + this.clockOffsetMs),
		}).toString();
		const signature = bytesToHex(
			hmac(sha256, utf8ToBytes(this.config.secretKey), utf8ToBytes(query)),
		);
		counters?.request();
		const response = await fetch(
			`${this.config.apiUrl.replace(/\/$/, "")}${path}?${query}&signature=${signature}`,
			{
				headers: {
					accept: "application/json",
					"X-MBX-APIKEY": this.config.apiKey,
				},
				signal: deadlineSignal(budget.deadlineAt),
			},
		);
		// Error bodies are read best-effort for the Binance error code only.
		const body: unknown = response.ok
			? await readProviderJson(response)
			: await readProviderJson(response).catch(() => ({}));
		const errorEnvelope = z
			.object({ code: z.number().optional() })
			.safeParse(body);
		const errorCode = errorEnvelope.success
			? errorEnvelope.data.code
			: undefined;
		if (!response.ok) {
			if (errorCode === -1021 && budget.clockRetryAvailable) {
				budget.clockRetryAvailable = false;
				counters?.retry();
				await this.synchronizeClock(budget.deadlineAt, counters);
				return this.signedGet(path, params, budget, counters);
			}
			throw new BinanceHttpError(response.status, errorCode);
		}
		return body;
	}
	private async synchronizeClock(
		deadlineAt: number,
		counters?: ProviderOperationCounters,
	) {
		const startedAt = Date.now();
		counters?.request();
		const response = await fetch(
			`${this.config.apiUrl.replace(/\/$/, "")}/api/v3/time`,
			{ signal: deadlineSignal(deadlineAt) },
		);
		if (!response.ok) throw new BinanceHttpError(response.status);
		const { serverTime } = z
			.object({ serverTime: z.number().int().positive() })
			.parse(await readProviderJson(response));
		const completedAt = Date.now();
		this.clockOffsetMs = serverTime - Math.floor((startedAt + completedAt) / 2);
	}
}

function requestBudget(timeoutMs: number): RequestBudget {
	return {
		deadlineAt: Date.now() + timeoutMs,
		clockRetryAvailable: true,
	};
}

function deadlineSignal(deadlineAt: number) {
	const remainingMs = deadlineAt - Date.now();
	if (remainingMs <= 0)
		return AbortSignal.abort(
			new DOMException("Binance request timed out", "TimeoutError"),
		);
	return AbortSignal.timeout(remainingMs);
}

class BinanceHttpError extends Error {
	constructor(
		readonly status: number,
		readonly code?: number,
	) {
		super(`Binance returned HTTP ${status}`);
	}
}

function hasPositiveFund(row: z.infer<typeof rowSchema>, wantedAsset?: string) {
	const funds = row.fundsDetail?.length
		? row.fundsDetail
		: row.amount != null && row.currency
			? [{ amount: row.amount, currency: row.currency }]
			: [];
	return funds.some(
		(fund) =>
			(!wantedAsset ||
				fund.currency.toUpperCase() === wantedAsset.toUpperCase()) &&
			isPositiveDecimal(fund.amount),
	);
}

function isPositiveDecimal(value: string | number) {
	const normalized = String(value).trim();
	if (!/^\d+(?:\.\d+)?$/.test(normalized)) return false;
	return decimalToUnits(normalized, decimalPlaces(normalized)) > 0n;
}

function normalizeTimestamp(value: string | number) {
	const number = Number(value);
	return number < 10_000_000_000 ? number * 1000 : number;
}
