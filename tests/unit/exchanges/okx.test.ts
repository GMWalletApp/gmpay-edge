import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OkxPayAdapter } from "#/integrations/exchanges/okx";
import billsFixture from "../../fixtures/providers/okx-funding-bills.json";

describe("OKX Pay adapter", () => {
	beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0));
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("signs funding bill requests and normalizes incoming transfers", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(billsFixture), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const [transaction] = await adapter().findTransactions({
			address: "123456",
			assetCode: "USDT",
			sinceBlock: 0n,
		});

		expect(transaction).toMatchObject({
			network: "okx",
			hash: "bill-1",
			to: "123456",
			assetCode: "USDT",
			amountUnits: 1_250_000_000n,
			confirmations: 1,
			success: true,
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/api/v5/asset/bills?");
		expect((init.headers as Record<string, string>)["OK-ACCESS-KEY"]).toBe(
			"api-key",
		);
		expect((init.headers as Record<string, string>)["OK-ACCESS-SIGN"]).toMatch(
			/^[A-Za-z0-9+/]+=*$/,
		);
	});

	it("rejects a channel address that differs from the credential account", async () => {
		await expect(
			adapter().findTransactions({ address: "654321", assetCode: "USDT" }),
		).rejects.toThrow("does not match");
	});

	it("keeps large decimal balance changes exact without floating-point checks", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			okx([
				{
					balChg: "9007199254740993.00000001",
					billId: "large-bill",
					ccy: "USDT",
					ts: "1700000000000",
					type: "72",
				},
				{
					balChg: "-1.00000000",
					billId: "negative-bill",
					ccy: "USDT",
					ts: "1700000000000",
					type: "72",
				},
			]),
		);
		vi.stubGlobal("fetch", fetchMock);

		const transactions = await adapter().findTransactions({
			address: "123456",
			assetCode: "USDT",
			sinceBlock: 0n,
		});
		expect(transactions).toHaveLength(1);
		expect(transactions[0]?.amountUnits).toBe(900719925474099300000001n);
	});

	it("ignores a negative funding bill during direct transaction lookup", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			okx([
				{
					balChg: "-1.00000000",
					billId: "withdrawal-bill",
					ccy: "USDT",
					ts: "1700000000000",
					type: "72",
				},
			]),
		);
		vi.stubGlobal("fetch", fetchMock);

		expect(await adapter().getTransaction("withdrawal-bill")).toBeNull();
	});

	it("rejects numeric balance changes instead of risking precision loss", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				okx([
					{
						balChg: 1.25,
						billId: "numeric-change",
						ccy: "USDT",
						ts: "1700000000000",
						type: "72",
					} as unknown as ReturnType<typeof bill>,
				]),
			),
		);
		await expect(
			adapter().findTransactions({
				address: "123456",
				assetCode: "USDT",
				sinceBlock: 0n,
			}),
		).rejects.toThrow();
	});

	it("adds the official simulated-trading header for demo credentials", async () => {
		const fetchMock = vi.fn().mockResolvedValue(okx([]));
		vi.stubGlobal("fetch", fetchMock);
		await adapter({ simulatedTrading: true }).findTransactions({
			address: "123456",
			assetCode: "USDT",
		});
		expect(
			(fetchMock.mock.calls[0]?.[1] as RequestInit)?.headers,
		).toMatchObject({ "x-simulated-trading": "1" });
	});

	it("paginates funding bills using the official after cursor", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const first = Array.from({ length: 100 }, (_, index) =>
			bill(String(200 - index)),
		);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(okx(first))
			.mockResolvedValueOnce(okx([bill("100")]));
		vi.stubGlobal("fetch", fetchMock);
		const transactions = await adapter().findTransactions({
			address: "123456",
			assetCode: "USDT",
			sinceBlock: 0n,
		});
		expect(transactions).toHaveLength(101);
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain("after=101");
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "okx",
				operation: "find_transactions",
				requestCount: 2,
				retryCount: 0,
				paginationRequestCount: 2,
			}),
		);
	});

	it("synchronizes server time and retries one rejected signed request", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		const serverTime = 1_700_000_012_345;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json(
					{ code: "50102", msg: "Timestamp request expired", data: [] },
					{ status: 401 },
				),
			)
			.mockResolvedValueOnce(
				Response.json({ code: "0", data: [{ ts: String(serverTime) }] }),
			)
			.mockResolvedValueOnce(okx([]));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			adapter().findTransactions({
				address: "123456",
				assetCode: "USDT",
				sinceBlock: 0n,
			}),
		).resolves.toEqual([]);
		expect(
			String(fetchMock.mock.calls[1]?.[0]).endsWith("/api/v5/public/time"),
		).toBe(true);
		expect(
			(fetchMock.mock.calls[2]?.[1] as RequestInit)?.headers,
		).toMatchObject({
			"OK-ACCESS-TIMESTAMP": new Date(serverTime).toISOString(),
		});
	});

	it("shares one timeout budget across clock synchronization and retry", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_700_000_000_000);
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation(() => new AbortController().signal);
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(async () => {
				vi.setSystemTime(1_700_000_000_400);
				return Response.json({ code: "50102", data: [] }, { status: 401 });
			})
			.mockImplementationOnce(async () => {
				vi.setSystemTime(1_700_000_000_800);
				return Response.json({
					code: "0",
					data: [{ ts: "1700000000800" }],
				});
			})
			.mockResolvedValueOnce(okx([]));
		vi.stubGlobal("fetch", fetchMock);
		await adapter({ timeoutMs: 1_000 }).findTransactions({
			address: "123456",
			assetCode: "USDT",
		});
		expect(timeout.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([
			1_000, 600, 200,
		]);
	});

	it("classifies authentication and throttling responses", async () => {
		const instance = adapter();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json(
						{ code: "50113", msg: "Invalid signature", data: [] },
						{ status: 401 },
					),
				),
		);
		const authentication = await instance
			.findTransactions({ address: "123456", assetCode: "USDT" })
			.catch((error) => error);
		expect(instance.classifyError(authentication)).toBe("authentication");
		expect(String(authentication)).not.toContain("Invalid signature");
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json(
						{ code: "50011", msg: "Rate limit", data: [] },
						{ status: 429 },
					),
				),
		);
		const throttled = await instance
			.findTransactions({ address: "123456", assetCode: "USDT" })
			.catch((error) => error);
		expect(instance.classifyError(throttled)).toBe("rate_limit");
	});
});

function adapter(overrides: Record<string, unknown> = {}) {
	return new OkxPayAdapter({
		apiKey: "api-key",
		secretKey: "secret-key",
		passphrase: "passphrase",
		accountId: "123456",
		apiUrl: "https://www.okx.com",
		assetDecimals: { USDT: 8 },
		...overrides,
	});
}

function bill(id: string) {
	return {
		balChg: "1",
		billId: id,
		ccy: "USDT",
		ts: "1700000000000",
		type: "72",
	};
}

function okx(data: ReturnType<typeof bill>[]) {
	return Response.json({ code: "0", msg: "", data });
}
