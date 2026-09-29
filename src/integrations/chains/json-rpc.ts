import {
	maxProviderResponseBytes,
	readProviderJson,
} from "../provider-response";

export class JsonRpcRequestError extends Error {
	constructor(
		readonly status: number,
		readonly rpcCode?: number,
		message?: string,
	) {
		super(message ?? `JSON-RPC request failed with status ${status}`);
	}
}

export async function requestJsonRpc<T>(input: {
	url: string;
	method: string;
	params: unknown[];
	timeoutMs: number;
	apiKey?: string;
	signal?: AbortSignal;
}): Promise<T> {
	const request = {
		id: 1,
		jsonrpc: "2.0" as const,
		method: input.method,
		params: input.params,
	};
	const payload = input.url.startsWith("wss://")
		? await requestWebSocket(input.url, request, input.timeoutMs, input.signal)
		: await requestHttp(
				input.url,
				request,
				input.timeoutMs,
				input.apiKey,
				input.signal,
			);
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		throw new JsonRpcRequestError(502, undefined, "Invalid JSON-RPC response");
	const response = payload as Record<string, unknown>;
	if (response.id !== request.id)
		throw new JsonRpcRequestError(
			502,
			undefined,
			"JSON-RPC response ID mismatch",
		);
	if (response.error && typeof response.error === "object") {
		const error = response.error as Record<string, unknown>;
		throw new JsonRpcRequestError(
			502,
			typeof error.code === "number" ? error.code : undefined,
			"JSON-RPC provider returned an error",
		);
	}
	if (!("result" in response))
		throw new JsonRpcRequestError(
			502,
			undefined,
			"JSON-RPC response has no result",
		);
	return response.result as T;
}

async function requestHttp(
	url: string,
	request: Record<string, unknown>,
	timeoutMs: number,
	apiKey?: string,
	signal?: AbortSignal,
) {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
		},
		body: JSON.stringify(request),
		signal: requestSignal(timeoutMs, signal),
	});
	if (!response.ok) throw new JsonRpcRequestError(response.status);
	return readProviderJson(response);
}

function requestWebSocket(
	url: string,
	request: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
) {
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise<unknown>((resolve, reject) => {
		const socket = new WebSocket(url);
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			try {
				socket.close();
			} finally {
				callback();
			}
		};
		const abort = () =>
			finish(() =>
				reject(
					signal?.reason ??
						new DOMException("JSON-RPC request aborted", "AbortError"),
				),
			);
		const timer = setTimeout(
			() =>
				finish(() =>
					reject(new DOMException("JSON-RPC timed out", "TimeoutError")),
				),
			timeoutMs,
		);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		socket.addEventListener(
			"open",
			() => socket.send(JSON.stringify(request)),
			{ once: true },
		);
		socket.addEventListener("message", (event) => {
			finish(() => {
				const data = String(event.data);
				if (data.length > maxProviderResponseBytes) {
					reject(
						new JsonRpcRequestError(
							502,
							undefined,
							"JSON-RPC response too large",
						),
					);
					return;
				}
				try {
					resolve(JSON.parse(data) as unknown);
				} catch {
					reject(
						new JsonRpcRequestError(502, undefined, "Invalid JSON-RPC JSON"),
					);
				}
			});
		});
		socket.addEventListener(
			"error",
			() => finish(() => reject(new TypeError("WebSocket JSON-RPC failed"))),
			{ once: true },
		);
	});
}

function requestSignal(timeoutMs: number, signal?: AbortSignal) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
