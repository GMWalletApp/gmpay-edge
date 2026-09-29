import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeJsonRpcSubscription } from "#/integrations/chains/json-rpc-subscription";

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0));

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.WebSocket = originalWebSocket;
});

describe("JSON-RPC subscriptions", () => {
	it("reconnects after a dropped socket and delivers notifications", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		let sockets = 0;
		globalThis.WebSocket = class {
			private readonly listeners = new Map<
				string,
				Array<(event: { data?: string }) => void>
			>();
			constructor(_url: string) {
				sockets += 1;
				queueMicrotask(() => this.emit("open", {}));
			}
			addEventListener(
				type: string,
				listener: (event: { data?: string }) => void,
			) {
				this.listeners.set(type, [
					...(this.listeners.get(type) ?? []),
					listener,
				]);
			}
			send(value: string) {
				const request = JSON.parse(value) as { id: string };
				queueMicrotask(() => {
					this.emit("message", {
						data: JSON.stringify({ id: request.id, result: `sub-${sockets}` }),
					});
					this.emit("message", {
						data: JSON.stringify({
							method: "eth_subscription",
							params: { subscription: `sub-${sockets}`, result: sockets },
						}),
					});
					if (sockets === 1) this.emit("close", {});
				});
			}
			close() {}
			private emit(type: string, event: { data?: string }) {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		} as unknown as typeof WebSocket;

		const controller = new AbortController();
		const values: number[] = [];
		const result = await consumeJsonRpcSubscription<number>({
			adapter: "evm",
			url: "wss://rpc.example",
			method: "eth_subscribe",
			params: ["newHeads"],
			timeoutMs: 1_000,
			signal: controller.signal,
			reconnectDelayMs: 0,
			maxReconnects: 2,
			onNotification(value) {
				values.push(value);
				if (values.length === 2) controller.abort();
			},
		});
		expect(values).toEqual([1, 2]);
		expect(result.reconnects).toBe(1);
		expect(sockets).toBe(2);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "evm",
				operation: "subscribe_transactions",
				outcome: "success",
				connectionCount: 2,
				notificationCount: 2,
				reconnectCount: 1,
			}),
		);
	});

	it("ignores notifications that arrive before the subscription is acknowledged", async () => {
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		globalThis.WebSocket = class {
			private readonly listeners = new Map<
				string,
				Array<(event: { data?: string }) => void>
			>();
			constructor(_url: string) {
				queueMicrotask(() => this.emit("open", {}));
			}
			addEventListener(
				type: string,
				listener: (event: { data?: string }) => void,
			) {
				this.listeners.set(type, [
					...(this.listeners.get(type) ?? []),
					listener,
				]);
			}
			send(value: string) {
				const request = JSON.parse(value) as { id: string };
				queueMicrotask(() => {
					// Unsolicited notification without a subscription id before the ack.
					this.emit("message", {
						data: JSON.stringify({
							method: "eth_subscription",
							params: { result: "unsolicited" },
						}),
					});
					this.emit("message", {
						data: JSON.stringify({ id: request.id, result: "sub-1" }),
					});
					this.emit("message", {
						data: JSON.stringify({
							method: "eth_subscription",
							params: { subscription: "sub-1", result: "acknowledged" },
						}),
					});
				});
			}
			close() {}
			private emit(type: string, event: { data?: string }) {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		} as unknown as typeof WebSocket;

		const controller = new AbortController();
		const values: string[] = [];
		await consumeJsonRpcSubscription<string>({
			adapter: "evm",
			url: "wss://rpc.example",
			method: "eth_subscribe",
			params: ["newHeads"],
			timeoutMs: 1_000,
			signal: controller.signal,
			onNotification(value) {
				values.push(value);
				controller.abort();
			},
		});
		expect(values).toEqual(["acknowledged"]);
	});

	it("fails closed for non-WebSocket endpoints", async () => {
		await expect(
			consumeJsonRpcSubscription({
				adapter: "evm",
				url: "https://rpc.example",
				method: "eth_subscribe",
				params: [],
				timeoutMs: 100,
				signal: new AbortController().signal,
				onNotification() {},
			}),
		).rejects.toThrow("wss://");
	});

	it("records a fixed failure without exposing the WSS endpoint", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		globalThis.WebSocket = class {
			private readonly listeners = new Map<string, Array<() => void>>();
			constructor(_url: string) {
				queueMicrotask(() => {
					for (const listener of this.listeners.get("error") ?? []) listener();
				});
			}
			addEventListener(type: string, listener: () => void) {
				this.listeners.set(type, [
					...(this.listeners.get(type) ?? []),
					listener,
				]);
			}
			close() {}
			send() {}
		} as unknown as typeof WebSocket;

		const endpoint = "wss://user:secret@rpc.example/private-address";
		await expect(
			consumeJsonRpcSubscription({
				adapter: "evm",
				url: endpoint,
				method: "eth_subscribe",
				params: ["newHeads"],
				timeoutMs: 100,
				signal: new AbortController().signal,
				maxReconnects: 0,
				onNotification() {},
			}),
		).rejects.toThrow("socket failed");
		const metric = info.mock.calls[0]?.[0];
		expect(metric).toMatchObject({
			event: "provider_operation",
			adapter: "evm",
			operation: "subscribe_transactions",
			outcome: "failure",
			status: "error",
			errorCode: "network",
			connectionCount: 1,
			notificationCount: 0,
			reconnectCount: 0,
		});
		expect(JSON.stringify(metric)).not.toContain(endpoint);
	});
});
