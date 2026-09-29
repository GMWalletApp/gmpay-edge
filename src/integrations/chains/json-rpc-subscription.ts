import {
	type ProviderAdapterId,
	type ProviderOperationMetric,
	providerOperationDurationMs,
	recordProviderOperation,
} from "../provider-observability";
import { maxProviderResponseBytes } from "../provider-response";

type SubscriptionMetric = Omit<
	Extract<ProviderOperationMetric, { operation: "subscribe_transactions" }>,
	"adapter" | "operation"
>;

/**
 * Bounded JSON-RPC pub/sub consumer for providers that expose `eth_subscribe`.
 *
 * The worker runtime cannot keep a socket alive between requests, so callers
 * should always provide an AbortSignal (usually the lifetime of a queue task
 * or a scheduled scan window).  A connection is recreated after an ordinary
 * close, error, or malformed response.  The subscription id is deliberately
 * not exposed: it is scoped to one socket and must never be reused after a
 * reconnect.
 */
export async function consumeJsonRpcSubscription<T>(input: {
	adapter: ProviderAdapterId;
	url: string;
	method: string;
	params: unknown[];
	timeoutMs: number;
	signal: AbortSignal;
	reconnectDelayMs?: number;
	maxReconnectDelayMs?: number;
	maxReconnects?: number;
	onNotification: (value: T) => Promise<void> | void;
}): Promise<{ reconnects: number }> {
	if (!input.url.startsWith("wss://"))
		throw new Error("JSON-RPC subscriptions require a wss:// endpoint");
	const reconnectDelayMs = input.reconnectDelayMs ?? 250;
	const maxReconnectDelayMs = input.maxReconnectDelayMs ?? 5_000;
	const maxReconnects = input.maxReconnects ?? Number.POSITIVE_INFINITY;
	let reconnects = 0;
	let connections = 0;
	let notifications = 0;
	let delayMs = reconnectDelayMs;
	const startedAt = performance.now();

	try {
		while (!input.signal.aborted) {
			try {
				connections += 1;
				await consumeConnection<T>({
					...input,
					onNotification: async (value) => {
						notifications += 1;
						await input.onNotification(value);
					},
				});
				if (input.signal.aborted) break;
				// A clean close is still a lost subscription. Reconnect while the
				// caller's bounded lifetime is active.
				reconnects += 1;
				if (reconnects > maxReconnects)
					throw new Error("JSON-RPC subscription reconnect limit exceeded");
				delayMs = reconnectDelayMs;
			} catch (error) {
				if (input.signal.aborted) break;
				reconnects += 1;
				if (reconnects > maxReconnects) throw error;
			}
			await waitForReconnect(delayMs, input.signal);
			delayMs = Math.min(
				maxReconnectDelayMs,
				Math.max(reconnectDelayMs, delayMs * 2),
			);
		}
		recordSubscription(input.adapter, {
			outcome: "success",
			status: notifications ? "ok" : "empty",
			errorCode: null,
			durationMs: providerOperationDurationMs(startedAt),
			connectionCount: connections,
			notificationCount: notifications,
			reconnectCount: Math.max(0, connections - 1),
		});
		return { reconnects };
	} catch (error) {
		const timedOut =
			error instanceof DOMException && error.name === "TimeoutError";
		recordSubscription(input.adapter, {
			outcome: "failure",
			status: timedOut ? "timeout" : "error",
			errorCode: timedOut ? "timeout" : "network",
			durationMs: providerOperationDurationMs(startedAt),
			connectionCount: connections,
			notificationCount: notifications,
			reconnectCount: Math.max(0, connections - 1),
		});
		throw error;
	}
}

function recordSubscription(
	adapter: ProviderAdapterId,
	metric: SubscriptionMetric,
) {
	recordProviderOperation({
		adapter,
		operation: "subscribe_transactions",
		...metric,
	});
}

async function consumeConnection<T>(input: {
	url: string;
	method: string;
	params: unknown[];
	timeoutMs: number;
	signal: AbortSignal;
	onNotification: (value: T) => Promise<void> | void;
}) {
	await new Promise<void>((resolve, reject) => {
		const socket = new WebSocket(input.url);
		const requestId = crypto.randomUUID();
		let subscriptionId: string | undefined;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const close = () => {
			if (timer) clearTimeout(timer);
			try {
				socket.close();
			} catch {
				// The socket may already have been closed by the runtime.
			}
		};
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			input.signal.removeEventListener("abort", abort);
			close();
			if (error) reject(error);
			else resolve();
		};
		const abort = () => finish();
		input.signal.addEventListener("abort", abort, { once: true });
		timer = setTimeout(
			() =>
				finish(
					new DOMException("JSON-RPC subscription timed out", "TimeoutError"),
				),
			input.timeoutMs,
		);
		socket.addEventListener("open", () => {
			socket.send(
				JSON.stringify({
					jsonrpc: "2.0",
					id: requestId,
					method: input.method,
					params: input.params,
				}),
			);
		});
		socket.addEventListener("message", (event) => {
			void (async () => {
				if (settled) return;
				let message: Record<string, unknown>;
				try {
					const data = String(event.data);
					if (data.length > maxProviderResponseBytes)
						throw new Error("JSON-RPC subscription message too large");
					const parsed: unknown = JSON.parse(data);
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
						throw new Error("Invalid JSON-RPC subscription message");
					message = parsed as Record<string, unknown>;
				} catch (error) {
					finish(error);
					return;
				}
				if (message.id === requestId) {
					if (typeof message.error === "object" && message.error)
						finish(new Error("JSON-RPC subscription rejected"));
					else if (typeof message.result !== "string")
						finish(new Error("JSON-RPC subscription id missing"));
					else subscriptionId = message.result;
					return;
				}
				const params = message.params;
				if (!params || typeof params !== "object" || Array.isArray(params))
					return;
				const notification = params as Record<string, unknown>;
				// Nothing is trusted before the provider acknowledges our request;
				// otherwise an unsolicited notification would match the unset id.
				if (
					subscriptionId === undefined ||
					notification.subscription !== subscriptionId
				)
					return;
				await input.onNotification(notification.result as T);
			})().catch(finish);
		});
		socket.addEventListener(
			"error",
			() => finish(new Error("JSON-RPC subscription socket failed")),
			{
				once: true,
			},
		);
		socket.addEventListener("close", () => finish());
	});
}

async function waitForReconnect(delayMs: number, signal: AbortSignal) {
	if (signal.aborted) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, delayMs);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}
