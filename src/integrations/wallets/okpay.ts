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
} from "#/integrations/chains/types";
import {
	observeProviderOperation,
	type ProviderOperationCounters,
} from "#/integrations/provider-observability";
import { constantTimeEqual } from "#/lib/crypto";
import { decimalPlaces, decimalToUnits } from "#/lib/money";

const configSchema = z.object({
	shopId: z.string().trim().min(1),
	apiKey: z.string().trim().min(1),
	apiUrl: z.url().default("https://api.okaypay.me/shop"),
	assetDecimals: z
		.record(z.string(), z.number().int().min(0).max(30))
		.default({ USDT: 8, TRX: 6 }),
	timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
});
export type OkPayConfig = z.infer<typeof configSchema>;

const responseSchema = z.looseObject({
	status: z.string(),
	code: z.union([z.string(), z.number()]).optional(),
	data: z.unknown().optional(),
	id: z.union([z.string(), z.number()]).optional(),
	msg: z.string().optional(),
	sign: z.string().optional(),
});
const successResponseSchema = z.looseObject({
	status: z.literal("success"),
	code: z.union([z.literal(200), z.literal("200")]),
	data: z.unknown(),
	id: z.union([z.string(), z.number()]),
	sign: z.string().regex(/^[A-F0-9]{64}$/),
});
const transferSchema = z.looseObject({
	// OKPay amounts are decimal strings at the protocol boundary. Do not
	// coerce JSON numbers because their precision is not recoverable.
	amount: z.string().optional(),
	coin: z.string().optional(),
	order_id: z.union([z.string(), z.number()]).optional(),
	status: z.union([z.string(), z.number()]),
	unique_id: z.union([z.string(), z.number()]).optional(),
});

export type OkPayHostedPayment = {
	providerOrderId: string;
	paymentUrl: string;
};

export class OkPayAdapter implements PaymentAdapter<OkPayConfig> {
	readonly id = "okpay";
	readonly network = "okpay" as const;
	readonly configSchema = configSchema;
	readonly config: OkPayConfig;

	constructor(config: unknown) {
		this.config = this.validateConfig(config);
	}

	validateConfig(value: unknown) {
		return this.configSchema.parse(value);
	}

	async createPaymentTarget(input: { address: string; expiresAt: Date }) {
		if (!this.validateAddress(input.address))
			throw new Error("OKPay shop ID does not match channel credentials");
		return input;
	}

	async createHostedPayment(input: {
		orderId: string;
		amount: string;
		assetCode: string;
		description: string;
		returnUrl?: string;
		callbackUrl?: string;
	}): Promise<OkPayHostedPayment> {
		return observeProviderOperation(
			{
				adapter: "okpay",
				operation: "create_hosted_payment",
				classifyError: (error) => this.classifyError(error),
			},
			async (counters) => {
				const payload = await this.post(
					"payLink",
					{
						amount: input.amount,
						coin: input.assetCode.toUpperCase(),
						callback_url: input.callbackUrl,
						name: input.description,
						return_url: input.returnUrl,
						unique_id: input.orderId,
					},
					counters,
				);
				const data = responseData(payload);
				const providerOrderId = String(data.order_id ?? "").trim();
				const paymentUrl = String(data.pay_url ?? "").trim();
				if (!providerOrderId || !isSafePaymentUrl(paymentUrl))
					throw new OkPayHttpError(
						502,
						"OKPay did not return an order and safe pay URL",
					);
				return { providerOrderId, paymentUrl };
			},
		);
	}

	async checkHostedPayment(providerOrderId: string) {
		return this.lookupHostedPayment(providerOrderId, "check_hosted_payment");
	}

	async getTransaction(hash: string) {
		return this.lookupHostedPayment(hash, "get_transaction");
	}

	async findTransactions() {
		return [];
	}

	validateAddress(address: string) {
		return address.trim() === this.config.shopId;
	}
	async validateTarget(address: string) {
		return this.validateAddress(address);
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

	async getConfirmations(transaction: NormalizedTransaction) {
		return transaction.success ? 1 : 0;
	}

	verifyCallback(input: Record<string, unknown>) {
		if (String(input.id ?? "").trim() !== this.config.shopId) return false;
		try {
			return constantTimeEqual(String(input.sign ?? ""), this.signature(input));
		} catch {
			return false;
		}
	}

	parseCallback(input: Record<string, unknown>) {
		const nested =
			typeof input.data === "string" ? safeJson(input.data) : input.data;
		const source =
			nested && typeof nested === "object" && !Array.isArray(nested)
				? (nested as Record<string, unknown>)
				: input;
		return {
			amount: String(source.amount ?? ""),
			assetCode: String(source.coin ?? "").toUpperCase(),
			providerOrderId: String(source.order_id ?? ""),
			orderId: String(source.unique_id ?? ""),
		};
	}

	async healthCheck(): Promise<AdapterHealth> {
		const started = Date.now();
		try {
			await observeProviderOperation(
				{
					adapter: "okpay",
					operation: "health_check",
					classifyError: (error) => this.classifyError(error),
				},
				(counters) => this.post("balance", {}, counters),
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
				detail: `OKPay health check failed: ${this.classifyError(error)}`,
			};
		}
	}

	classifyError(error: unknown): AdapterErrorKind {
		if (error instanceof OkPayInvalidResponseError) return "invalid_response";
		if (error instanceof OkPayHttpError) {
			if (error.status === 401 || error.status === 403) return "authentication";
			if (error.status === 429) return "rate_limit";
			if (error.status >= 500) return "network";
			return "permanent";
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

	private normalize(
		data: z.infer<typeof completedTransferSchema>,
		fallbackId: string,
	): NormalizedTransaction {
		const providerOrderId = String(data.order_id ?? fallbackId);
		const assetCode = data.coin.toUpperCase();
		const now = Date.now();
		return {
			network: "okpay",
			hash: providerOrderId,
			eventIndex: 0,
			from: "okpay",
			to: this.config.shopId,
			assetCode,
			amountUnits: decimalToUnits(
				String(data.amount),
				this.config.assetDecimals[assetCode] ?? 8,
			),
			blockNumber: BigInt(now),
			blockHash: `okpay:${providerOrderId}`,
			confirmations: 1,
			timestamp: new Date(now),
			success: Number(data.status) === 1 && isPositiveDecimal(data.amount),
			canonical: true,
		};
	}

	private lookupHostedPayment(
		providerOrderId: string,
		operation: "check_hosted_payment" | "get_transaction",
	) {
		return observeProviderOperation(
			{
				adapter: "okpay",
				operation,
				classifyError: (error) => this.classifyError(error),
			},
			async (counters) => {
				const payload = await this.post(
					"checkTransferByTxid",
					{ txid: providerOrderId },
					counters,
				);
				const data = transferSchema.parse(responseData(payload));
				if (Number(data.status) !== 1) return null;
				const completed = completedTransferSchema.parse(data);
				return isPositiveDecimal(completed.amount)
					? this.normalize(completed, providerOrderId)
					: null;
			},
		);
	}

	private async post(
		path: string,
		input: Record<string, unknown>,
		counters?: ProviderOperationCounters,
	) {
		const fields = clean({
			...input,
			id: this.config.shopId,
			timestamp: Math.floor(Date.now() / 1000),
			nonce: crypto.randomUUID(),
		});
		fields.sign = this.signature(fields);
		counters?.request();
		const response = await fetch(
			`${this.config.apiUrl.replace(/\/$/, "")}/${path}`,
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(fields),
				signal: AbortSignal.timeout(this.config.timeoutMs),
			},
		);
		if (!response.ok) throw new OkPayHttpError(response.status);
		let decoded: unknown;
		try {
			decoded = await response.json();
		} catch {
			throw new OkPayInvalidResponseError();
		}
		const payload = responseSchema.parse(decoded);
		if (payload.status !== "success")
			throw new OkPayHttpError(normalizeStatus(payload.code));
		const success = successResponseSchema.parse(payload);
		if (!this.verifyCallback(success)) throw new OkPayInvalidResponseError();
		return success;
	}

	private signature(input: Record<string, unknown>) {
		return bytesToHex(
			hmac(
				sha256,
				utf8ToBytes(this.config.apiKey),
				utf8ToBytes(signatureBase(input)),
			),
		).toUpperCase();
	}
}

const completedTransferSchema = transferSchema.extend({
	amount: z.string(),
	coin: z.string(),
});

function isSafePaymentUrl(value: string) {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" && url.username === "" && url.password === ""
		);
	} catch {
		return false;
	}
}

class OkPayHttpError extends Error {
	constructor(
		readonly status: number,
		message?: string,
	) {
		super(message ?? `OKPay returned HTTP ${status}`);
	}
}

class OkPayInvalidResponseError extends Error {}

function clean(input: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(input)
			.filter(
				([, value]) => value !== undefined && value !== null && value !== "",
			)
			.map(([key, value]) => [key, String(value)]),
	);
}

function isPositiveDecimal(value: string | number) {
	const normalized = String(value).trim();
	if (!/^\d+(?:\.\d+)?$/.test(normalized)) return false;
	return decimalToUnits(normalized, decimalPlaces(normalized)) > 0n;
}

function signatureBase(input: Record<string, unknown>) {
	return flatten(input)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
}

function flatten(
	input: Record<string, unknown>,
	prefix = "",
): Array<[string, string]> {
	const fields: Array<[string, string]> = [];
	for (const [key, value] of Object.entries(input)) {
		if (key === "sign" || value === null || value === undefined || value === "")
			continue;
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "object" && !Array.isArray(value)) {
			fields.push(...flatten(value as Record<string, unknown>, path));
			continue;
		}
		if (
			typeof value !== "string" &&
			typeof value !== "number" &&
			typeof value !== "boolean"
		)
			throw new OkPayInvalidResponseError();
		fields.push([path, String(value)]);
	}
	return fields;
}

function normalizeStatus(code: string | number | undefined) {
	const status = Number(code);
	return Number.isInteger(status) && status >= 400 && status <= 599
		? status
		: 400;
}

function responseData(payload: Record<string, unknown>) {
	if (Array.isArray(payload.data))
		return (payload.data[0] ?? {}) as Record<string, unknown>;
	return payload.data && typeof payload.data === "object"
		? (payload.data as Record<string, unknown>)
		: {};
}

function safeJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}
