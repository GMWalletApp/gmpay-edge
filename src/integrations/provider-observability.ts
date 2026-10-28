import type { AdapterErrorKind } from "./chains/types";

const providerAdapterIds = [
	"allratestoday",
	"aptos",
	"binance",
	"evm",
	"exchangerate_host",
	"okpay",
	"okx",
	"solana",
	"ton",
	"tron",
] as const;

const providerOperationIds = [
	"check_hosted_payment",
	"create_hosted_payment",
	"find_transactions",
	"get_confirmations",
	"get_transaction",
	"health_check",
	"payment_scan",
	"subscribe_transactions",
	"sync_crypto_rates",
	"sync_fiat_rates",
] as const;
const providerSuccessSampleRate = 0.1;

export type ProviderAdapterId = (typeof providerAdapterIds)[number];
type ProviderOperationId = (typeof providerOperationIds)[number];
type ProviderErrorCode = AdapterErrorKind | "timeout";

export type ProviderOperationCounters = {
	request(): void;
	retry(): void;
	page(): void;
};

type ProviderOperationMetricBase = {
	adapter: ProviderAdapterId;
	outcome: "failure" | "success";
	status: "empty" | "error" | "ok" | "timeout";
	errorCode: ProviderErrorCode | null;
	durationMs: number;
};

export type ProviderOperationMetric = ProviderOperationMetricBase &
	(
		| {
				operation: Exclude<
					ProviderOperationId,
					"payment_scan" | "subscribe_transactions"
				>;
				timeoutCount: number;
				retryCount: number;
				requestCount: number;
				paginationRequestCount: number;
		  }
		| {
				operation: "payment_scan";
				failoverCount: number;
		  }
		| {
				operation: "subscribe_transactions";
				connectionCount: number;
				notificationCount: number;
				reconnectCount: number;
		  }
	);

export async function observeProviderOperation<T>(
	input: {
		adapter: ProviderAdapterId;
		operation: Exclude<
			ProviderOperationId,
			"payment_scan" | "subscribe_transactions"
		>;
		classifyError(error: unknown): AdapterErrorKind;
	},
	run: (counters: ProviderOperationCounters) => Promise<T>,
) {
	const startedAt = performance.now();
	const counts = {
		paginationRequestCount: 0,
		requestCount: 0,
		retryCount: 0,
	};
	const counters: ProviderOperationCounters = {
		request: () => {
			counts.requestCount += 1;
		},
		retry: () => {
			counts.retryCount += 1;
		},
		page: () => {
			counts.paginationRequestCount += 1;
		},
	};
	try {
		const value = await run(counters);
		recordProviderOperation({
			adapter: input.adapter,
			operation: input.operation,
			outcome: "success",
			status: isEmptyResult(value) ? "empty" : "ok",
			errorCode: null,
			durationMs: providerOperationDurationMs(startedAt),
			timeoutCount: 0,
			...counts,
		});
		return value;
	} catch (error) {
		const timedOut = isTimeoutError(error);
		recordProviderOperation({
			adapter: input.adapter,
			operation: input.operation,
			outcome: "failure",
			status: timedOut ? "timeout" : "error",
			errorCode: timedOut ? "timeout" : input.classifyError(error),
			durationMs: providerOperationDurationMs(startedAt),
			timeoutCount: timedOut ? 1 : 0,
			...counts,
		});
		throw error;
	}
}

export function recordProviderOperation(
	metric: ProviderOperationMetric,
	sample: () => number = Math.random,
) {
	const sampleRate =
		metric.outcome === "success" ? providerSuccessSampleRate : 1;
	if (sampleRate < 1 && sample() >= sampleRate) return;
	console.info({ event: "provider_operation", ...metric, sampleRate });
}

export function isObservedProviderAdapter(
	value: string,
): value is ProviderAdapterId {
	return providerAdapterIds.some((adapter) => adapter === value);
}

export function providerOperationDurationMs(startedAt: number) {
	return Math.round(Math.max(0, performance.now() - startedAt) * 10) / 10;
}

function isTimeoutError(error: unknown) {
	return error instanceof DOMException && error.name === "TimeoutError";
}

function isEmptyResult(value: unknown) {
	return value === null || (Array.isArray(value) && value.length === 0);
}
