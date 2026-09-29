import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import type {
	AdapterErrorKind,
	AdapterHealth,
	NormalizedTransaction,
	PaymentAdapter,
	PaymentTarget,
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
	passphrase: z.string().trim().min(1),
	apiUrl: z.url().default("https://www.okx.com"),
	simulatedTrading: z.boolean().default(false),
	accountId: z.string().regex(/^[1-9]\d*$/),
	assetDecimals: z
		.record(z.string(), z.number().int().min(0).max(30))
		.refine((assets) => Object.keys(assets).length <= 32, "Too many OKX assets")
		.default({ USDT: 8, USDC: 8 }),
	timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
	lookbackMs: z
		.number()
		.int()
		.min(60_000)
		.max(90 * 86_400_000)
		.default(3_600_000),
	maxPages: z.number().int().min(1).max(500).default(50),
});
export type OkxConfig = z.infer<typeof configSchema>;
type RequestBudget = { deadlineAt: number; clockRetryAvailable: boolean };
const billSchema = z.object({
	// OKX monetary deltas are decimal strings; accepting JSON numbers here can
	// silently round values before decimalToUnits receives them.
	balChg: z.string(),
	billId: z.union([z.string(), z.number()]),
	ccy: z.string(),
	ts: z.union([z.string(), z.number()]),
	type: z.union([z.string(), z.number()]),
});

export class OkxPayAdapter implements PaymentAdapter<OkxConfig> {
	readonly id = "okx";
	readonly network = "okx" as const;
	readonly configSchema = configSchema;
	readonly config: OkxConfig;
	private clockOffsetMs = 0;
	constructor(config: unknown) {
		this.config = this.validateConfig(config);
	}
	validateConfig(value: unknown) {
		return this.configSchema.parse(value);
	}
	async createPaymentTarget(input: { address: string; expiresAt: Date }) {
		if (!this.validateAddress(input.address))
			throw new Error("Invalid OKX account ID");
		return input;
	}
	validateAddress(address: string) {
		return /^[1-9]\d*$/.test(address);
	}
	async validateTarget(address: string) {
		return (
			this.validateAddress(address) &&
			address === this.config.accountId &&
			(await this.validateAccount())
		);
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
	async validateAccount(counters?: ProviderOperationCounters) {
		const rows = z
			.array(z.object({ uid: z.union([z.string(), z.number()]) }))
			.parse(
				await this.signedGet(
					"/api/v5/account/config",
					{},
					requestBudget(this.config.timeoutMs),
					counters,
				),
			);
		return String(rows[0]?.uid ?? "") === this.config.accountId;
	}
	async getTransaction(hash: string) {
		return observeProviderOperation(
			{
				adapter: "okx",
				operation: "get_transaction",
				classifyError: (error) => this.classifyError(error),
			},
			async (counters) => {
				const budget = requestBudget(this.config.timeoutMs);
				for (const asset of Object.keys(this.config.assetDecimals)) {
					const row = (
						await this.bills(asset, undefined, budget, counters)
					).find((item) => String(item.billId) === hash);
					if (row && String(row.type) === "72" && isPositiveDecimal(row.balChg))
						return this.normalize(row);
				}
				return null;
			},
		);
	}
	async findTransactions(input: TransactionScanInput) {
		if (input.address !== this.config.accountId)
			throw new Error("OKX account ID does not match channel credentials");
		return observeProviderOperation(
			{
				adapter: "okx",
				operation: "find_transactions",
				classifyError: (error) => this.classifyError(error),
			},
			async (counters) => {
				const minimum =
					input.sinceBlock == null
						? (input.sinceTimestampMs ?? Date.now() - this.config.lookbackMs)
						: Number(input.sinceBlock);
				return (await this.bills(input.assetCode, minimum, undefined, counters))
					.filter(
						(row) => Number(row.ts) >= minimum && isPositiveDecimal(row.balChg),
					)
					.map((row) => this.normalize(row));
			},
		);
	}
	async getConfirmations(transaction: NormalizedTransaction) {
		return transaction.success ? 1 : 0;
	}
	async healthCheck(): Promise<AdapterHealth> {
		const started = Date.now();
		try {
			const healthy = await observeProviderOperation(
				{
					adapter: "okx",
					operation: "health_check",
					classifyError: (error) => this.classifyError(error),
				},
				(counters) => this.validateAccount(counters),
			);
			return {
				healthy,
				latencyMs: Date.now() - started,
				checkedAt: new Date(),
				...(healthy
					? {}
					: { detail: "Credential UID does not match configured account" }),
			};
		} catch (error) {
			return {
				healthy: false,
				latencyMs: Date.now() - started,
				checkedAt: new Date(),
				detail: `OKX health check failed: ${this.classifyError(error)}`,
			};
		}
	}
	classifyError(error: unknown): AdapterErrorKind {
		if (error instanceof OkxHttpError) {
			if (
				error.status === 401 ||
				error.status === 403 ||
				["50113", "50114"].includes(error.code ?? "")
			)
				return "authentication";
			if (error.status === 429 || error.code === "50011") return "rate_limit";
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
	private async bills(
		assetCode: string,
		minimumTimestamp?: number,
		budget: RequestBudget = requestBudget(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	) {
		const rows: z.infer<typeof billSchema>[] = [];
		let after: string | undefined;
		for (let page = 0; page < this.config.maxPages; page += 1) {
			counters?.page();
			const batch = z.array(billSchema).parse(
				await this.signedGet(
					"/api/v5/asset/bills",
					{
						ccy: assetCode.toUpperCase(),
						limit: "100",
						type: "72",
						...(after ? { after } : {}),
					},
					budget,
					counters,
				),
			);
			rows.push(...batch);
			if (
				batch.length < 100 ||
				(minimumTimestamp != null &&
					batch.some((row) => Number(row.ts) < minimumTimestamp))
			)
				return rows;
			const next = String(batch.at(-1)?.billId ?? "");
			if (!next || next === after)
				throw new Error("OKX repeated its funding bill cursor");
			after = next;
		}
		throw new Error(
			"OKX funding bill pagination exceeded the configured limit",
		);
	}
	private normalize(row: z.infer<typeof billSchema>): NormalizedTransaction {
		const timestamp = normalizeTimestamp(row.ts);
		const id = String(row.billId);
		const symbol = row.ccy.toUpperCase();
		return {
			network: "okx",
			hash: id,
			eventIndex: 0,
			from: "okx-pay",
			to: this.config.accountId,
			assetCode: symbol,
			amountUnits: decimalToUnits(
				String(row.balChg),
				this.config.assetDecimals[symbol] ?? 8,
			),
			blockNumber: BigInt(timestamp),
			blockHash: `okx:${id}`,
			confirmations: 1,
			timestamp: new Date(timestamp),
			success: String(row.type) === "72" && isPositiveDecimal(row.balChg),
			canonical: true,
		};
	}
	private async signedGet(
		path: string,
		query: Record<string, string> = {},
		budget: RequestBudget = requestBudget(this.config.timeoutMs),
		counters?: ProviderOperationCounters,
	): Promise<unknown[]> {
		const search = new URLSearchParams(query).toString();
		const requestPath = `${path}${search ? `?${search}` : ""}`;
		const timestamp = new Date(Date.now() + this.clockOffsetMs).toISOString();
		const signature = base64(
			hmac(
				sha256,
				utf8ToBytes(this.config.secretKey),
				utf8ToBytes(`${timestamp}GET${requestPath}`),
			),
		);
		counters?.request();
		const response = await fetch(
			`${this.config.apiUrl.replace(/\/$/, "")}${requestPath}`,
			{
				headers: {
					accept: "application/json",
					"OK-ACCESS-KEY": this.config.apiKey,
					"OK-ACCESS-PASSPHRASE": this.config.passphrase,
					"OK-ACCESS-SIGN": signature,
					"OK-ACCESS-TIMESTAMP": timestamp,
					...(this.config.simulatedTrading
						? { "x-simulated-trading": "1" }
						: {}),
				},
				signal: deadlineSignal(budget.deadlineAt),
			},
		);
		const payload = z
			.object({
				code: z.string().optional(),
				data: z.array(z.unknown()).default([]),
			})
			.parse(await readProviderJson(response));
		if (payload.code === "50102" && budget.clockRetryAvailable) {
			budget.clockRetryAvailable = false;
			counters?.retry();
			await this.synchronizeClock(budget.deadlineAt, counters);
			return this.signedGet(path, query, budget, counters);
		}
		if (!response.ok || (payload.code && payload.code !== "0"))
			throw new OkxHttpError(response.status, payload.code);
		return payload.data;
	}
	private async synchronizeClock(
		deadlineAt: number,
		counters?: ProviderOperationCounters,
	) {
		const startedAt = Date.now();
		counters?.request();
		const response = await fetch(
			`${this.config.apiUrl.replace(/\/$/, "")}/api/v5/public/time`,
			{ signal: deadlineSignal(deadlineAt) },
		);
		if (!response.ok) throw new OkxHttpError(response.status);
		const payload = z
			.object({
				code: z.literal("0"),
				data: z.array(z.object({ ts: z.string().regex(/^\d+$/) })).min(1),
			})
			.parse(await readProviderJson(response));
		const completedAt = Date.now();
		this.clockOffsetMs =
			Number(payload.data[0]?.ts) - Math.floor((startedAt + completedAt) / 2);
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
			new DOMException("OKX request timed out", "TimeoutError"),
		);
	return AbortSignal.timeout(remainingMs);
}

function isPositiveDecimal(value: string | number) {
	const normalized = String(value).trim();
	if (!/^\d+(?:\.\d+)?$/.test(normalized)) return false;
	return decimalToUnits(normalized, decimalPlaces(normalized)) > 0n;
}

class OkxHttpError extends Error {
	constructor(
		readonly status: number,
		readonly code?: string,
	) {
		super(`OKX returned HTTP ${status}`);
	}
}
function base64(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
function normalizeTimestamp(value: string | number) {
	const number = Number(value);
	return number < 10_000_000_000 ? number * 1000 : number;
}
