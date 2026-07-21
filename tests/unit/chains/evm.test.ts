import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvmAdapter } from "#/integrations/chains/evm";

const recipient = "0x1111111111111111111111111111111111111111";
const sender = "0x2222222222222222222222222222222222222222";
const usdt = "0xdac17f958d2ee523a2206206994597c13d831ec7";

describe("EVM adapter", () => {
	beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0));
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	it("consumes ERC20 transfer logs from a WSS subscription", async () => {
		const sockets: FakeSubscriptionSocket[] = [];
		vi.stubGlobal(
			"WebSocket",
			class extends FakeSubscriptionSocket {
				constructor(url: string) {
					super(url);
					sockets.push(this);
				}
			} as unknown as typeof WebSocket,
		);
		const controller = new AbortController();
		const transactions: unknown[] = [];
		await new EvmAdapter({
			rpcUrl: "wss://rpc.example",
			network: "ethereum",
			nativeAsset: "ETH",
			tokens: { USDT: { address: usdt, decimals: 6 } },
		}).subscribeTransactions?.({
			address: recipient,
			assetCode: "USDT",
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]),
			onTransaction(transaction) {
				transactions.push(transaction);
				controller.abort();
			},
		});
		expect(sockets.length).toBeGreaterThanOrEqual(3);
		expect(transactions[0]).toMatchObject({
			hash: "0xsubscription-tx",
			to: recipient,
			assetCode: "USDT",
			amountUnits: 2n,
		});
	});
	it("normalizes ERC20 logs with event identity and confirmations", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(rpc("0x64"))
			.mockResolvedValueOnce(
				rpc([
					{
						address: usdt,
						blockHash: "0xblock",
						blockNumber: "0x5a",
						data: "0x1312d00",
						logIndex: "0x2",
						removed: false,
						topics: [
							"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
							topic(sender),
							topic(recipient),
						],
						transactionHash: "0xtx",
					},
				]),
			)
			.mockResolvedValueOnce(
				rpc({
					hash: "0xblock",
					number: "0x5a",
					timestamp: "0x6553f100",
					transactions: [],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const [transaction] = await adapter().findTransactions({
			address: recipient,
			assetCode: "USDT",
			sinceBlock: 80n,
		});
		if (!transaction) throw new Error("Expected a native transfer");
		expect(transaction).toMatchObject({
			network: "ethereum",
			hash: "0xtx",
			eventIndex: 2,
			from: sender,
			to: recipient,
			assetCode: "USDT",
			amountUnits: 20_000_000n,
			blockNumber: 90n,
			confirmations: 11,
			success: true,
			canonical: true,
		});
		const logRequest = JSON.parse(
			String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
		) as { method: string; params: Array<{ topics: unknown[] }> };
		expect(logRequest.method).toBe("eth_getLogs");
		expect(logRequest.params[0]?.topics[2]).toBe(topic(recipient));
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "evm",
				operation: "find_transactions",
				outcome: "success",
				requestCount: 3,
				paginationRequestCount: 1,
			}),
		);
	});
	it("rejects block heights outside the safe integer range", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpc("0x20000000000000")));
		await expect(
			adapter().findTransactions({
				address: recipient,
				assetCode: "USDT",
			}),
		).rejects.toThrow("safe integer");
	});

	it("normalizes native transfers and rejects wrong destinations", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(rpc("0xa"))
				.mockResolvedValueOnce(
					rpc({
						hash: "0xblock",
						number: "0xa",
						timestamp: "0x6553f100",
						transactions: [
							{
								blockHash: "0xblock",
								blockNumber: "0xa",
								from: sender,
								hash: "0xnative",
								to: recipient,
								value: "0xde0b6b3a7640000",
							},
						],
					}),
				)
				.mockResolvedValueOnce(
					rpc({
						blockHash: "0xblock",
						blockNumber: "0xa",
						logs: [],
						status: "0x1",
						transactionHash: "0xnative",
					}),
				),
		);
		const [transaction] = await adapter().findTransactions({
			address: recipient,
			assetCode: "ETH",
			sinceBlock: 10n,
		});
		if (!transaction) throw new Error("Expected a native transaction");
		expect(transaction).toMatchObject({
			amountUnits: 1_000_000_000_000_000_000n,
			assetCode: "ETH",
			confirmations: 1,
		});
		expect(
			adapter().validatePayment(
				transaction,
				{ address: sender, expiresAt: new Date() },
				"ETH",
			),
		).toBe(false);
	});

	it("selects the configured token event for the requested receiving target", async () => {
		const otherRecipient = "0x3333333333333333333333333333333333333333";
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(rpc(transaction("0xmulti")))
				.mockResolvedValueOnce(
					rpc({
						blockHash: "0xblock",
						blockNumber: "0x5a",
						logs: [
							transferLog(otherRecipient, "0x0", "0x1"),
							transferLog(recipient, "0x1", "0x2"),
						],
						status: "0x1",
						transactionHash: "0xmulti",
					}),
				)
				.mockResolvedValueOnce(rpc("0x64"))
				.mockResolvedValueOnce(rpc(block())),
		);
		await expect(
			adapter().getTransaction("0xmulti", {
				address: recipient,
				assetCode: "USDT",
			}),
		).resolves.toMatchObject({
			to: recipient,
			eventIndex: 1,
			amountUnits: 2n,
			assetCode: "USDT",
		});
	});

	it("does not replace a native transfer with an unrelated token log", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(rpc(transaction("0xnative")))
				.mockResolvedValueOnce(
					rpc({
						blockHash: "0xblock",
						blockNumber: "0x5a",
						logs: [transferLog(recipient, "0x0", "0x1")],
						status: "0x1",
						transactionHash: "0xnative",
					}),
				)
				.mockResolvedValueOnce(rpc("0x64"))
				.mockResolvedValueOnce(rpc(block())),
		);
		const nativeAdapter = new EvmAdapter({
			rpcUrl: "https://rpc.example",
			network: "ethereum",
			nativeAsset: "ETH",
		});
		await expect(
			nativeAdapter.getTransaction("0xnative", {
				address: recipient,
				assetCode: "ETH",
			}),
		).resolves.toMatchObject({
			assetCode: "ETH",
			amountUnits: 1n,
			eventIndex: 0,
		});
	});

	it("shares one timeout deadline across direct transaction RPC stages", async () => {
		vi.useFakeTimers();
		const startedAt = 1_700_000_000_000;
		vi.setSystemTime(startedAt);
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation(() => new AbortController().signal);
		let request = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				request += 1;
				vi.setSystemTime(startedAt + request * 100);
				const body = JSON.parse(String(init?.body)) as { method: string };
				if (body.method === "eth_getTransactionByHash")
					return rpc(transaction("0xdeadline"));
				if (body.method === "eth_getTransactionReceipt")
					return rpc({
						blockHash: "0xblock",
						blockNumber: "0x5a",
						logs: [],
						status: "0x1",
						transactionHash: "0xdeadline",
					});
				if (body.method === "eth_blockNumber") return rpc("0x64");
				if (body.method === "eth_getBlockByHash") return rpc(block());
				throw new Error(`Unexpected method ${body.method}`);
			}),
		);
		const native = new EvmAdapter({
			rpcUrl: "https://rpc.example",
			network: "ethereum",
			nativeAsset: "ETH",
			timeoutMs: 1_000,
		});
		await expect(
			native.getTransaction("0xdeadline", { assetCode: "ETH" }),
		).resolves.toMatchObject({ hash: "0xdeadline", assetCode: "ETH" });
		expect(timeout.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([
			1_000, 900, 800, 700,
		]);
	});

	it("scans ERC20 logs in contiguous provider-safe block ranges", async () => {
		const ranges: Array<[string, string]> = [];
		const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
			const request = JSON.parse(String((init as RequestInit).body)) as {
				method: string;
				params: Array<{ fromBlock: string; toBlock: string }>;
			};
			if (request.method === "eth_blockNumber") return rpc("0x1e");
			const [range] = request.params;
			if (!range) throw new Error("Expected an eth_getLogs range");
			ranges.push([range.fromBlock, range.toBlock]);
			return rpc([]);
		});
		vi.stubGlobal("fetch", fetchMock);
		await new EvmAdapter({
			rpcUrl: "https://rpc.example",
			network: "ethereum",
			nativeAsset: "ETH",
			logBlockRange: 10,
			tokens: { USDT: { address: usdt, decimals: 6 } },
		}).findTransactions({
			address: recipient,
			assetCode: "USDT",
			sinceBlock: 1n,
		});
		expect(ranges).toEqual([
			["0x1", "0xa"],
			["0xb", "0x14"],
			["0x15", "0x1e"],
		]);
	});

	it("uses provider-safe scan defaults", () => {
		expect(adapter().config).toMatchObject({
			timeoutMs: 30_000,
			logBlockRange: 500,
		});
	});

	it("reduces rejected JSON-RPC log ranges and keeps the successful size", async () => {
		const ranges: Array<[number, number]> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (_url, init) => {
				const request = JSON.parse(String((init as RequestInit).body)) as {
					method: string;
					params: Array<{ fromBlock: string; toBlock: string }>;
				};
				if (request.method === "eth_blockNumber") return rpc("0x3e8");
				const [range] = request.params;
				if (!range) throw new Error("Expected an eth_getLogs range");
				const from = Number.parseInt(range.fromBlock.slice(2), 16);
				const to = Number.parseInt(range.toBlock.slice(2), 16);
				ranges.push([from, to]);
				return to - from + 1 > 500 ? rpcError(-32_005) : rpc([]);
			}),
		);
		await new EvmAdapter({
			rpcUrl: "https://rpc.example",
			network: "ethereum",
			nativeAsset: "ETH",
			logBlockRange: 1000,
			tokens: { USDT: { address: usdt, decimals: 6 } },
		}).findTransactions({
			address: recipient,
			assetCode: "USDT",
			sinceBlock: 1n,
		});
		expect(ranges).toEqual([
			[1, 1000],
			[1, 500],
			[501, 1000],
		]);
	});

	it("does not split HTTP provider failures", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(rpc("0x3e8"))
			.mockResolvedValueOnce(new Response(null, { status: 429 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			new EvmAdapter({
				rpcUrl: "https://rpc.example",
				network: "ethereum",
				nativeAsset: "ETH",
				logBlockRange: 1000,
				tokens: { USDT: { address: usdt, decimals: 6 } },
			}).findTransactions({
				address: recipient,
				assetCode: "USDT",
				sinceBlock: 1n,
			}),
		).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects a sinceBlock outside the configured scan window", async () => {
		const fetchMock = vi.fn().mockResolvedValue(rpc("0x1e"));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			new EvmAdapter({
				rpcUrl: "https://rpc.example",
				network: "ethereum",
				nativeAsset: "ETH",
				blockLookback: 10,
				tokens: { USDT: { address: usdt, decimals: 6 } },
			}).findTransactions({
				address: recipient,
				assetCode: "USDT",
				sinceBlock: 20n,
			}),
		).rejects.toThrow("configured block lookback");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects token result fan-out above the configured scan limit", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(rpc("0xa"))
				.mockResolvedValueOnce(
					rpc([
						transferLog(recipient, "0x0", "0x1"),
						transferLog(recipient, "0x1", "0x2"),
					]),
				),
		);
		await expect(
			new EvmAdapter({
				rpcUrl: "https://rpc.example",
				network: "ethereum",
				nativeAsset: "ETH",
				blockLookback: 1,
				maxScanTransactions: 1,
				tokens: { USDT: { address: usdt, decimals: 6 } },
			}).findTransactions({
				address: recipient,
				assetCode: "USDT",
			}),
		).rejects.toThrow("configured transaction limit");
	});

	it("observes confirmation lookups at their provider request owner", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpc("0xa")));
		await expect(
			adapter().getConfirmations({ blockNumber: 8n } as never),
		).resolves.toBe(3);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "evm",
				operation: "get_confirmations",
				requestCount: 1,
			}),
		);
	});

	it("redacts unexpected provider failures from health details", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("provider-secret-and-url")),
		);
		const health = await adapter().healthCheck();
		expect(health).toMatchObject({
			healthy: false,
			detail: "EVM health check failed: network",
		});
		expect(health.detail).not.toContain("provider-secret-and-url");
	});
});

function adapter() {
	return new EvmAdapter({
		rpcUrl: "https://rpc.example",
		network: "ethereum",
		nativeAsset: "ETH",
		tokens: { USDT: { address: usdt, decimals: 6 } },
	});
}
function rpc(result: unknown) {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}
function rpcError(code: number) {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			error: { code, message: "rejected" },
		}),
		{
			status: 200,
			headers: { "content-type": "application/json" },
		},
	);
}
function topic(address: string) {
	return `0x${address.slice(2).padStart(64, "0")}`;
}

function transaction(hash: string) {
	return {
		blockHash: "0xblock",
		blockNumber: "0x5a",
		from: sender,
		hash,
		to: recipient,
		value: "0x1",
	};
}

function block() {
	return {
		hash: "0xblock",
		number: "0x5a",
		timestamp: "0x6553f100",
		transactions: [],
	};
}

function transferLog(to: string, logIndex: string, data: string) {
	return {
		address: usdt,
		blockHash: "0xblock",
		blockNumber: "0x5a",
		data,
		logIndex,
		removed: false,
		topics: [
			"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
			topic(sender),
			topic(to),
		],
		transactionHash: "0xmulti",
	};
}

class FakeSubscriptionSocket {
	private readonly listeners = new Map<
		string,
		Array<(event: { data?: string }) => void>
	>();
	constructor(_url: string) {
		queueMicrotask(() => this.emit("open", {}));
	}
	addEventListener(type: string, listener: (event: { data?: string }) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	send(value: string) {
		const request = JSON.parse(value) as { id: string; method: string };
		queueMicrotask(() => {
			if (request.method === "eth_subscribe") {
				this.emit("message", {
					data: JSON.stringify({ id: request.id, result: "sub-1" }),
				});
				this.emit("message", {
					data: JSON.stringify({
						method: "eth_subscription",
						params: {
							subscription: "sub-1",
							result: {
								address: usdt,
								blockHash: "0xblock",
								blockNumber: "0x5a",
								data: "0x2",
								logIndex: "0x1",
								removed: false,
								topics: [
									"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
									topic(sender),
									topic(recipient),
								],
								transactionHash: "0xsubscription-tx",
							},
						},
					}),
				});
				return;
			}
			const result =
				request.method === "eth_blockNumber"
					? "0x64"
					: request.method === "eth_getTransactionReceipt"
						? {
								blockHash: "0xblock",
								blockNumber: "0x5a",
								logs: [],
								status: "0x1",
								transactionHash: "0xsubscription-tx",
							}
						: {
								hash: "0xblock",
								number: "0x5a",
								timestamp: "0x6553f100",
								transactions: [],
							};
			this.emit("message", {
				data: JSON.stringify({ id: request.id, result }),
			});
		});
	}
	close() {}
	private emit(type: string, event: { data?: string }) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}
