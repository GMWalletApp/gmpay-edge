import { md5 } from "@noble/hashes/legacy.js";
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

const responseSchema = z.looseObject({ data: z.unknown().optional() });
const transferSchema = z.looseObject({
	// OKPay amounts are decimal strings at the protocol boundary. Do not
	// coerce JSON numbers because their precision is not recoverable.
	amount: z.string(),
	coin: z.string(),
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
		const supplied = String(input.sign ?? "");
		const unsigned = { ...input };
		delete unsigned.sign;
		return constantTimeEqual(supplied, this.signature(clean(unsigned)));
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
				(counters) =>
					this.post(
						"checkTransferByTxid",
						{ txid: `health-${Date.now()}` },
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
				detail: `OKPay health check failed: ${this.classifyError(error)}`,
			};
		}
	}

	classifyError(error: unknown): AdapterErrorKind {
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
		data: z.infer<typeof transferSchema>,
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
				return Number(data.status) === 1 && isPositiveDecimal(data.amount)
					? this.normalize(data, providerOrderId)
					: null;
			},
		);
	}

	private async post(
		path: string,
		input: Record<string, unknown>,
		counters?: ProviderOperationCounters,
	) {
		const fields = clean({ ...input, id: this.config.shopId });
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
		const payload = responseSchema.parse(await response.json());
		if (!response.ok) throw new OkPayHttpError(response.status);
		return payload;
	}

	private signature(input: Record<string, string>) {
		const message = `${sortedQuery(input)}&token=${this.config.apiKey}`;
		return bytesToHex(md5(utf8ToBytes(message))).toUpperCase();
	}
}

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

function clean(input: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(input)
			.filter(
				([, value]) =>
					value !== undefined &&
					value !== null &&
					value !== "" &&
					value !== false,
			)
			.map(([key, value]) => [key, String(value)]),
	);
}

function isPositiveDecimal(value: string | number) {
	const normalized = String(value).trim();
	if (!/^\d+(?:\.\d+)?$/.test(normalized)) return false;
	return decimalToUnits(normalized, decimalPlaces(normalized)) > 0n;
}

function sortedQuery(input: Record<string, string>) {
	const params = new URLSearchParams();
	for (const key of Object.keys(input).sort()) {
		const value = input[key];
		if (value !== undefined) params.set(key, value);
	}
	return decodeURIComponent(params.toString().replace(/\+/g, " "));
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
