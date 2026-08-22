import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TonAdapter } from "#/integrations/chains/ton";

const owner = `UQ${"a".repeat(46)}`;
const master = `0:${"b".repeat(64)}`;

describe("TON adapter", () => {
	beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0));
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	it("normalizes incoming Jetton transfers", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						jetton_transfers: [
							{
								amount: "3000000",
								destination: owner,
								jetton_master: master,
								query_id: "7",
								source: `UQ${"c".repeat(46)}`,
								transaction_hash: "ton-hash",
								transaction_lt: "900",
								transaction_now: 1_700_000_000,
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		);
		const [transaction] = await adapter().findTransactions({
			address: owner,
			assetCode: "USDT",
			sinceBlock: 800n,
		});
		expect(transaction).toMatchObject({
			network: "ton",
			hash: "ton-hash",
			eventIndex: 7,
			to: owner,
			assetCode: "USDT",
			amountUnits: 3_000_000n,
			blockNumber: 900n,
			confirmations: 1,
			success: true,
		});
	});
	it("rejects numeric Jetton amounts before BigInt conversion", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				json({
					jetton_transfers: [{ ...jetton("numeric", "900"), amount: 1.25 }],
				}),
			),
		);
		await expect(
			adapter().findTransactions({ address: owner, assetCode: "USDT" }),
		).rejects.toThrow();
	});
	it("validates user-friendly TON addresses", () => {
		expect(adapter().validateAddress(owner)).toBe(true);
		expect(adapter().validateAddress(master)).toBe(false);
	});
	it("normalizes native TON transfers under the GRAM asset symbol", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				json({
					transactions: [
						{
							hash: "native-hash",
							lt: "901",
							now: 1_700_000_000,
							in_msg: {
								source: `UQ${"c".repeat(46)}`,
								destination: owner,
								value: "2500000000",
							},
							success: true,
						},
					],
				}),
			),
		);
		const [transaction] = await adapter().findTransactions({
			address: owner,
			assetCode: "GRAM",
		});
		expect(transaction).toMatchObject({
			assetCode: "GRAM",
			amountUnits: 2_500_000_000n,
			to: owner,
			success: true,
		});
	});
	it("paginates Jetton transfers until the offset page is exhausted", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const firstPage = Array.from({ length: 100 }, (_, index) =>
			jetton(`hash-${index}`, String(1_000 - index)),
		);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(json({ jetton_transfers: firstPage }))
			.mockResolvedValueOnce(
				json({ jetton_transfers: [jetton("hash-100", "900")] }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const transactions = await adapter().findTransactions({
			address: owner,
			assetCode: "USDT",
			sinceBlock: 800n,
		});
		expect(transactions).toHaveLength(101);
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain("offset=100");
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "ton",
				operation: "find_transactions",
				requestCount: 2,
				paginationRequestCount: 2,
			}),
		);
	});
	it("shares one deadline across all transfer pages", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const fetchMock = vi.fn(async () => {
			now = 1001;
			return json({
				jetton_transfers: Array.from({ length: 100 }, (_, index) =>
					jetton(`hash-${index}`, String(1_000 - index)),
				),
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			new TonAdapter({
				apiUrl: "https://toncenter.com/api/v3",
				timeoutMs: 1000,
				tokens: { USDT: { master, decimals: 6 } },
			}).findTransactions({ address: owner, assetCode: "USDT" }),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("selects the requested receiving target from a multi-transfer transaction", async () => {
		const other = `UQ${"d".repeat(46)}`;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				json({
					jetton_transfers: [
						{ ...jetton("multi", "902"), destination: other, query_id: "1" },
						{ ...jetton("multi", "902"), destination: owner, query_id: "2" },
					],
				}),
			),
		);
		await expect(
			adapter().getTransaction("multi", {
				address: owner,
				assetCode: "USDT",
			}),
		).resolves.toMatchObject({ to: owner, eventIndex: 2 });
	});
	it("classifies provider throttling without treating it as malformed data", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 429 })),
		);
		const instance = adapter();
		const error = await instance
			.findTransactions({ address: owner, assetCode: "USDT" })
			.catch((cause) => cause);
		expect(instance.classifyError(error)).toBe("rate_limit");
	});
	it("redacts unexpected provider failures from health details", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("provider-secret-and-url")),
		);
		const health = await adapter().healthCheck();
		expect(health).toMatchObject({
			healthy: false,
			detail: "TON health check failed: network",
		});
		expect(health.detail).not.toContain("provider-secret-and-url");
	});
});

function adapter() {
	return new TonAdapter({
		apiUrl: "https://toncenter.com/api/v3",
		nativeAsset: "GRAM",
		tokens: { USDT: { master, decimals: 6 } },
	});
}

function jetton(hash: string, lt: string) {
	return {
		amount: "1",
		destination: owner,
		jetton_master: master,
		source: `UQ${"c".repeat(46)}`,
		transaction_hash: hash,
		transaction_lt: lt,
		transaction_now: 1_700_000_000,
	};
}

function json(value: unknown) {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}
