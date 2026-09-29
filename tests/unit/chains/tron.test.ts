import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TronAdapter } from "#/integrations/chains/tron";
import nowBlockFixture from "../../fixtures/chains/tron-now-block.json";
import transactionInfoFixture from "../../fixtures/chains/tron-transaction-info.json";
import eventFixture from "../../fixtures/chains/tron-transfer-event.json";
import { MockTronAdapter } from "../../fixtures/mock-tron-adapter";

const address = "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj";
const zeroAddress = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const usdtContract = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const lookalikeContract = "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj";
const apiUrl = "https://api.trongrid.io";

describe("TRON adapters", () => {
	beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0));
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	it("validates base58check-shaped addresses", () => {
		expect(adapter().validateAddress(address)).toBe(true);
		expect(adapter().validateAddress("0x1234")).toBe(false);
	});
	it("provides deterministic simulated payments", async () => {
		const mock = new MockTronAdapter();
		mock.record({
			network: "tron",
			hash: "abc",
			eventIndex: 0,
			from: address,
			to: address,
			assetCode: "USDT",
			amountUnits: 1_000_000n,
			blockNumber: 1n,
			blockHash: "block",
			confirmations: 20,
			timestamp: new Date(),
			success: true,
		});
		expect(await mock.getTransaction("abc")).toMatchObject({
			assetCode: "USDT",
			amountUnits: 1_000_000n,
		});
	});
	it("normalizes confirmed TRC20 transfers with their real event identity", async () => {
		const fetchMock = tronGrid({
			head: 100,
			pages: [{ data: [trc20("trc20-hash", 90, "1250000")] }],
			events: { "trc20-hash": [tronEvent(3, address, "1250000")] },
		});
		const [transaction] = await adapter().findTransactions({
			address,
			assetCode: "USDT",
			sinceBlock: 80n,
			sinceTimestampMs: 1_699_999_000_000,
		});
		expect(transaction).toMatchObject({
			hash: "trc20-hash",
			eventIndex: 3,
			from: zeroAddress,
			to: address,
			assetCode: "USDT",
			amountUnits: 1_250_000n,
			blockNumber: 90n,
			blockHash: "block-90",
			confirmations: 11,
			success: true,
		});
		const listUrl = requestedUrls(fetchMock).find((url) =>
			url.includes("/transactions/trc20?"),
		);
		expect(listUrl).toContain(`contract_address=${usdtContract}`);
		expect(listUrl).toContain("min_timestamp=1699999000000");
	});
	it("ignores a look-alike token that only shares the USDT symbol", async () => {
		const fetchMock = tronGrid({
			head: 100,
			pages: [
				{
					data: [
						{
							...trc20("fake-hash", 95, "1250000"),
							token_info: { symbol: "USDT", address: lookalikeContract },
						},
					],
				},
			],
			events: {
				"fake-hash": [tronEvent(0, address, "1250000", lookalikeContract)],
			},
		});
		await expect(
			adapter().findTransactions({ address, assetCode: "USDT" }),
		).resolves.toEqual([]);
		expect(
			requestedUrls(fetchMock).some((url) => url.includes("/events")),
		).toBe(false);
	});
	it("rejects a payer-submitted hash whose Transfer event belongs to another contract", async () => {
		tronGrid({
			head: 100,
			info: {
				id: "fake-direct",
				blockNumber: 90,
				receipt: { result: "SUCCESS" },
			},
			events: {
				"fake-direct": [tronEvent(0, address, "1250000", lookalikeContract)],
			},
		});
		await expect(
			adapter().getTransaction("fake-direct", { address, assetCode: "USDT" }),
		).resolves.toBeNull();
	});
	it("preserves event identity and converts TVM event addresses", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse(transactionInfoFixture))
				.mockResolvedValueOnce(jsonResponse(nowBlockFixture))
				.mockResolvedValueOnce(jsonResponse(block(90, "transaction-block")))
				.mockResolvedValueOnce(jsonResponse(eventFixture)),
		);
		const transaction = await adapter().getTransaction("trc20-event-hash");
		expect(transaction).toMatchObject({
			hash: "trc20-event-hash",
			eventIndex: 3,
			from: zeroAddress,
			to: zeroAddress,
			assetCode: "USDT",
			amountUnits: 1_250_000n,
			blockHash: "transaction-block",
			confirmations: 11,
			success: true,
		});
	});
	it("selects the requested TRC20 event from a multi-event transaction", async () => {
		tronGrid({
			head: 100,
			info: { id: "multi-event", blockNumber: 90 },
			events: {
				"multi-event": [
					tronEvent(1, address, "1"),
					tronEvent(4, zeroAddress, "2500000"),
				],
			},
		});
		await expect(
			adapter().getTransaction("multi-event", {
				address: zeroAddress,
				assetCode: "USDT",
				eventIndex: 4,
			}),
		).resolves.toMatchObject({
			to: zeroAddress,
			eventIndex: 4,
			amountUnits: 2_500_000n,
			blockHash: "block-90",
		});
	});
	it("reports a reverted TRC20 execution from the transaction receipt", async () => {
		tronGrid({
			head: 100,
			info: { id: "reverted", blockNumber: 90, receipt: { result: "REVERT" } },
			events: { reverted: [tronEvent(0, address, "1250000")] },
		});
		await expect(
			adapter().getTransaction("reverted", { address, assetCode: "USDT" }),
		).resolves.toMatchObject({ success: false });
	});
	it("does not fall back to native parsing for a token lookup", async () => {
		const fetchMock = tronGrid({
			head: 100,
			info: { id: "no-event", blockNumber: 90 },
			events: { "no-event": [] },
		});
		await expect(
			adapter().getTransaction("no-event", { address, assetCode: "USDT" }),
		).resolves.toBeNull();
		expect(
			requestedUrls(fetchMock).some((url) =>
				url.endsWith("/wallet/gettransactionbyid"),
			),
		).toBe(false);
	});
	it("returns null for a TRX lookup of a non-transfer transaction", async () => {
		tronGrid({
			head: 100,
			info: { id: "contract-call", blockNumber: 90 },
			transaction: {
				txID: "contract-call",
				blockNumber: 90,
				block_timestamp: 1_700_000_000_000,
				ret: [{ contractRet: "SUCCESS" }],
				raw_data: {
					contract: [
						{
							type: "TriggerSmartContract",
							parameter: {
								value: {
									data: "a9059cbb",
									owner_address: `41${"00".repeat(20)}`,
								},
							},
						},
					],
				},
			},
		});
		await expect(
			adapter().getTransaction("contract-call", { address, assetCode: "TRX" }),
		).resolves.toBeNull();
	});
	it("follows TronGrid fingerprints without dropping later pages", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const fetchMock = tronGrid({
			head: 100,
			pages: [
				{
					data: [trc20("page-1", 99, "1")],
					meta: { fingerprint: "next page" },
				},
				{ data: [trc20("page-2", 98, "2")], meta: {} },
			],
		});
		const transactions = await adapter().findTransactions({
			address,
			assetCode: "USDT",
		});
		expect(transactions.map((transaction) => transaction.hash)).toEqual([
			"page-1",
			"page-2",
		]);
		expect(transactions.truncated).toBeUndefined();
		expect(requestedUrls(fetchMock)[2]).toContain("fingerprint=next%20page");
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "tron",
				operation: "find_transactions",
				requestCount: 7,
				paginationRequestCount: 2,
			}),
		);
	});
	it("stops paging once a page reaches the time lower bound", async () => {
		const fetchMock = tronGrid({
			head: 100,
			pages: [
				{
					data: [
						trc20("recent", 99, "1"),
						{ ...trc20("old", 60, "2"), block_timestamp: 1_600_000_000_000 },
					],
					meta: { fingerprint: "older page" },
				},
				{ data: [trc20("older", 50, "3")] },
			],
		});
		const transactions = await adapter().findTransactions({
			address,
			assetCode: "USDT",
			sinceTimestampMs: 1_650_000_000_000,
		});
		expect(transactions.map((transaction) => transaction.hash)).toEqual([
			"recent",
		]);
		expect(transactions.truncated).toBeUndefined();
		expect(
			requestedUrls(fetchMock).some((url) => url.includes("fingerprint=")),
		).toBe(false);
	});
	it("rejects repeated TronGrid cursors instead of looping forever", async () => {
		tronGrid({
			head: 100,
			pages: [
				{ data: [], meta: { fingerprint: "same" } },
				{ data: [], meta: { fingerprint: "same" } },
			],
		});
		await expect(
			adapter().findTransactions({ address, assetCode: "USDT" }),
		).rejects.toThrow("repeated");
	});
	it("returns the newest rows as a truncated scan when the row budget is exhausted", async () => {
		const fetchMock = tronGrid({
			head: 110,
			pages: [
				{
					data: [trc20("first", 100, "1"), trc20("second", 99, "2")],
					meta: { fingerprint: "more" },
				},
			],
		});
		const transactions = await adapter({
			maxScanTransactions: 1,
		}).findTransactions({ address, assetCode: "USDT" });
		expect(transactions.map((transaction) => transaction.hash)).toEqual([
			"first",
		]);
		expect(transactions.truncated).toEqual({});
		expect(
			requestedUrls(fetchMock).filter((url) => url.includes("/trc20?")),
		).toHaveLength(1);
	});
	it("normalizes successful native TRX transfers and Base58Check addresses", async () => {
		tronGrid({
			head: 25,
			pages: [
				{
					data: [
						{
							txID: "trx-hash",
							blockNumber: 24,
							block_timestamp: 1_700_000_000_000,
							ret: [{ contractRet: "SUCCESS" }],
							raw_data: {
								contract: [
									{
										type: "TransferContract",
										parameter: {
											value: {
												amount: 2_000_000,
												owner_address: `41${"00".repeat(20)}`,
												to_address: `41${"00".repeat(20)}`,
											},
										},
									},
								],
							},
						},
					],
				},
			],
		});
		const [transaction] = await adapter().findTransactions({
			address: zeroAddress,
			assetCode: "TRX",
		});
		expect(transaction).toMatchObject({
			from: zeroAddress,
			to: zeroAddress,
			amountUnits: 2_000_000n,
			blockHash: "block-24",
			confirmations: 2,
		});
	});
	it("rejects unsafe numeric native amounts before BigInt conversion", async () => {
		tronGrid({
			head: 25,
			pages: [
				{
					data: [
						{
							txID: "unsafe-trx",
							blockNumber: 24,
							block_timestamp: 1_700_000_000_000,
							ret: [{ contractRet: "SUCCESS" }],
							raw_data: {
								contract: [
									{
										type: "TransferContract",
										parameter: {
											value: {
												amount: Number.MAX_SAFE_INTEGER + 1,
												owner_address: `41${"00".repeat(20)}`,
												to_address: `41${"00".repeat(20)}`,
											},
										},
									},
								],
							},
						},
					],
				},
			],
		});
		await expect(
			adapter().findTransactions({ address: zeroAddress, assetCode: "TRX" }),
		).rejects.toThrow();
	});
	it("keeps canonical block identity stable while the solidified head advances", async () => {
		let head = 100;
		tronGrid({
			head: () => head,
			pages: [
				{ data: [trc20("stable", 90, "1")] },
				{ data: [trc20("stable", 90, "1")] },
			],
			events: { stable: [tronEvent(0, address, "1")] },
			blockId: (number) => `canonical-${number}`,
		});
		const instance = adapter();
		const [first] = await instance.findTransactions({
			address,
			assetCode: "USDT",
		});
		head = 101;
		const [second] = await instance.findTransactions({
			address,
			assetCode: "USDT",
		});
		expect(first?.blockHash).toBe("canonical-90");
		expect(second?.blockHash).toBe("canonical-90");
		expect(second?.confirmations).toBe(12);
	});
	it("bounds block lookups without changing transaction order", async () => {
		let active = 0;
		let maximum = 0;
		const rows = Array.from({ length: 8 }, (_, index) =>
			trc20(`tx-${index}`, 90 + index, String(index + 1)),
		);
		tronGrid({
			head: 110,
			pages: [{ data: rows }],
			onBlock: async () => {
				active += 1;
				maximum = Math.max(maximum, active);
				await new Promise((resolve) => setTimeout(resolve, 1));
				active -= 1;
			},
		});
		const transactions = await adapter({
			maxConcurrentRequests: 3,
		}).findTransactions({ address, assetCode: "USDT" });
		expect(maximum).toBe(3);
		expect(transactions.map((transaction) => transaction.hash)).toEqual(
			rows.map((row) => row.transaction_id),
		);
	});
	it("filters old rows before requesting canonical block hashes", async () => {
		const fetchMock = tronGrid({
			head: 110,
			pages: [{ data: [trc20("old", 90, "1"), trc20("current", 100, "2")] }],
		});
		const transactions = await adapter().findTransactions({
			address,
			assetCode: "USDT",
			sinceBlock: 100n,
		});
		expect(transactions.map((transaction) => transaction.hash)).toEqual([
			"current",
		]);
		const blockRequests = fetchMock.mock.calls
			.filter(([url]) => String(url).endsWith("/wallet/getblockbynum"))
			.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
		expect(blockRequests).toEqual([{ num: 100 }]);
	});
	it("shares one deadline between head and transaction requests", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const fetchMock = vi.fn(async () => {
			now = 1001;
			return jsonResponse(nowBlock(110));
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			adapter({ timeoutMs: 1000 }).findTransactions({
				address,
				assetCode: "USDT",
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("observes confirmation lookups against the solidified head", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse(nowBlock(100)));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			adapter().getConfirmations({ blockNumber: 90n } as never),
		).resolves.toBe(11);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"/walletsolidity/getnowblock",
		);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "tron",
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
			detail: "TRON health check failed: network",
		});
		expect(health.detail).not.toContain("provider-secret-and-url");
	});
});

function adapter(overrides: Record<string, unknown> = {}) {
	return new TronAdapter({
		apiUrl,
		tokens: { USDT: { address: usdtContract, decimals: 6 } },
		...overrides,
	});
}

/** Routes TronGrid requests by URL so concurrent block and event reads stay order-independent. */
function tronGrid(routes: {
	head: number | (() => number);
	pages?: Array<{ data: unknown[]; meta?: { fingerprint?: string } }>;
	events?: Record<string, unknown[]>;
	info?: unknown;
	transaction?: unknown;
	blockId?: (number: number) => string;
	onBlock?: () => Promise<void>;
}) {
	let page = 0;
	const fetchMock = vi.fn(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/walletsolidity/getnowblock"))
				return jsonResponse(
					nowBlock(
						typeof routes.head === "function" ? routes.head() : routes.head,
					),
				);
			if (url.endsWith("/wallet/getblockbynum")) {
				await routes.onBlock?.();
				const request = JSON.parse(String(init?.body)) as { num: number };
				return jsonResponse(
					block(
						request.num,
						routes.blockId?.(request.num) ?? `block-${request.num}`,
					),
				);
			}
			if (url.endsWith("/wallet/gettransactioninfobyid"))
				return jsonResponse(routes.info ?? {});
			if (url.endsWith("/wallet/gettransactionbyid"))
				return jsonResponse(routes.transaction ?? {});
			const events = /\/v1\/transactions\/([^/]+)\/events/.exec(url);
			if (events?.[1]) {
				const hash = decodeURIComponent(events[1]);
				const row = trc20Rows.get(hash);
				return jsonResponse({
					success: true,
					data:
						routes.events?.[hash] ??
						(row
							? [tronEvent(0, address, row.value, usdtContract, row.block)]
							: []),
				});
			}
			if (url.includes("/v1/accounts/")) {
				const current = routes.pages?.[page];
				page += 1;
				if (!current) throw new Error(`Unexpected TRON page request ${url}`);
				return jsonResponse({ success: true, ...current });
			}
			throw new Error(`Unexpected TRON request ${url}`);
		},
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function requestedUrls(fetchMock: ReturnType<typeof vi.fn>) {
	return fetchMock.mock.calls.map(([url]) => String(url));
}

function nowBlock(number: number) {
	return {
		blockID: "block-hash",
		block_header: { raw_data: { number } },
	};
}

function block(number: number, blockID: string) {
	return {
		blockID,
		block_header: { raw_data: { number } },
	};
}

/** TronGrid TRC20 history rows carry no block number; the mock serves it from the Transfer event. */
const trc20Rows = new Map<string, { block: number; value: string }>();

function trc20(hash: string, block: number, value: string) {
	trc20Rows.set(hash, { block, value });
	return {
		transaction_id: hash,
		block_timestamp: 1_700_000_000_000,
		from: zeroAddress,
		to: address,
		value,
		type: "Transfer",
		token_info: {
			symbol: "USDT",
			address: usdtContract,
			decimals: 6,
			name: "Tether USD",
		},
	};
}

function tronEvent(
	eventIndex: number,
	to: string,
	value: string,
	contract = usdtContract,
	block = 90,
) {
	return {
		contract_address: contract,
		block_number: block,
		block_timestamp: 1_700_000_000_000,
		event_index: String(eventIndex),
		event_name: "Transfer",
		result: { from: zeroAddress, to, value },
		result_type: { from: "address", to: "address", value: "uint256" },
		_unconfirmed: false,
	};
}

function jsonResponse(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
