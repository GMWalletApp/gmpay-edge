import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BinancePayAdapter } from "#/integrations/exchanges/binance";
import historyFixture from "../../fixtures/providers/binance-pay-history.json";

describe("Binance Pay adapter", () => {
	beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0));
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});
	it("signs history requests and normalizes receiver funds", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(historyFixture), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const [transaction] = await adapter().findTransactions({
			address: "123456",
			assetCode: "USDT",
		});
		expect(transaction).toMatchObject({
			network: "binance",
			hash: "pay-1",
			to: "123456",
			assetCode: "USDT",
			amountUnits: 1_250_000_000n,
			confirmations: 1,
			success: true,
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/sapi/v1/pay/transactions?");
		expect(url).toMatch(/signature=[0-9a-f]{64}/);
		expect((init.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe(
			"api-key",
		);
	});

	it("health-checks the Pay history permission instead of Spot account access", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				Response.json({ code: "000000", success: true, data: [] }),
			);
		vi.stubGlobal("fetch", fetchMock);
		await expect(adapter().healthCheck()).resolves.toMatchObject({
			healthy: true,
		});
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"/sapi/v1/pay/transactions?",
		);
		expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain(
			"/api/v3/account",
		);
	});

	it("does not probe the unrelated Spot account endpoint for a Pay receiver UID", async () => {
		const instance = adapter();
		expect("validateTarget" in instance).toBe(false);
		await expect(
			instance.createPaymentTarget({
				address: "123456",
				expiresAt: new Date(Date.now() + 60_000),
			}),
		).resolves.toMatchObject({ address: "123456" });
	});

	it("ignores zero and negative receiver funds", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			payResponse([
				{
					fundsDetail: [{ amount: "0", currency: "USDT" }],
					receiverInfo: { binanceId: "123456" },
					transactionId: "zero",
					transactionTime: 1_700_000_000_000,
				},
				{
					fundsDetail: [{ amount: "-1", currency: "USDT" }],
					receiverInfo: { binanceId: "123456" },
					transactionId: "negative",
					transactionTime: 1_700_000_000_001,
				},
			]),
		);
		vi.stubGlobal("fetch", fetchMock);

		expect(
			await adapter().findTransactions({
				address: "123456",
				assetCode: "USDT",
			}),
		).toEqual([]);
	});

	it("rejects numeric monetary fields instead of risking precision loss", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				payResponse([
					{
						fundsDetail: [{ amount: 1.25, currency: "USDT" }],
						receiverInfo: { binanceId: "123456" },
						transactionId: "numeric-amount",
						transactionTime: 1_700_000_000_000,
					} as unknown as ReturnType<typeof payRow>,
				]),
			),
		);
		await expect(
			adapter().findTransactions({ address: "123456", assetCode: "USDT" }),
		).rejects.toThrow();
	});

	it("selects the positive asset from a multi-fund transaction", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			payResponse([
				{
					fundsDetail: [
						{ amount: "-1", currency: "USDT" },
						{ amount: "2.5", currency: "USDC" },
					],
					receiverInfo: { binanceId: "123456" },
					transactionId: "multi-fund",
					transactionTime: 1_700_000_000_000,
				},
			]),
		);
		vi.stubGlobal("fetch", fetchMock);

		expect(await adapter().getTransaction("multi-fund")).toMatchObject({
			assetCode: "USDC",
			amountUnits: 250_000_000n,
		});
	});

	it("bounds a direct lookup around the observed payment time", async () => {
		const observedAtMs = 1_700_000_000_000;
		const fetchMock = vi
			.fn()
			.mockResolvedValue(payResponse([payRow("pay-1", observedAtMs)]));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			adapter().getTransaction("pay-1", { observedAtMs }),
		).resolves.toMatchObject({ hash: "pay-1" });
		const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(url.searchParams.get("startTime")).toBe(
			String(observedAtMs - 3_600_000),
		);
		expect(url.searchParams.get("endTime")).toBe(
			String(observedAtMs + 3_600_000),
		);
	});

	it("starts a first scan at the order lower bound instead of the lookback", async () => {
		const sinceTimestampMs = 1_700_000_000_000;
		const fetchMock = vi.fn().mockResolvedValue(payResponse([]));
		vi.stubGlobal("fetch", fetchMock);
		await adapter().findTransactions({
			address: "123456",
			assetCode: "USDT",
			sinceTimestampMs,
		});
		const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(url.searchParams.get("startTime")).toBe(String(sinceTimestampMs));
	});

	it("splits full Pay-history windows instead of accepting 100-row truncation", async () => {
		const full = Array.from({ length: 100 }, (_, index) =>
			payRow(`full-${index}`, 1_700_000_000_000 + index),
		);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(payResponse(full))
			.mockResolvedValueOnce(payResponse([payRow("left", 1_700_000_000_100)]))
			.mockResolvedValueOnce(payResponse([payRow("right", 1_700_000_000_900)]));
		vi.stubGlobal("fetch", fetchMock);
		const transactions = await adapter().findTransactions({
			address: "123456",
			assetCode: "USDT",
		});
		expect(transactions.map((transaction) => transaction.hash)).toEqual([
			"left",
			"right",
		]);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("synchronizes server time and retries one rejected signed request", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		const serverTime = 1_700_000_012_345;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json(
					{ code: -1021, msg: "Timestamp outside recvWindow" },
					{ status: 400 },
				),
			)
			.mockResolvedValueOnce(Response.json({ serverTime }))
			.mockResolvedValueOnce(payResponse([]));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			adapter().findTransactions({
				address: "123456",
				assetCode: "USDT",
			}),
		).resolves.toEqual([]);
		expect(String(fetchMock.mock.calls[1]?.[0]).endsWith("/api/v3/time")).toBe(
			true,
		);
		expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
			`timestamp=${serverTime}`,
		);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "binance",
				operation: "find_transactions",
				outcome: "success",
				status: "empty",
				requestCount: 3,
				retryCount: 1,
				paginationRequestCount: 1,
			}),
		);
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
				return Response.json({ code: -1021 }, { status: 400 });
			})
			.mockImplementationOnce(async () => {
				vi.setSystemTime(1_700_000_000_800);
				return Response.json({ serverTime: 1_700_000_000_800 });
			})
			.mockResolvedValueOnce(payResponse([]));
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
					Response.json({ code: -2015, msg: "Invalid key" }, { status: 401 }),
				),
		);
		const authentication = await instance
			.findTransactions({ address: "123456", assetCode: "USDT" })
			.catch((error) => error);
		expect(instance.classifyError(authentication)).toBe("authentication");
		expect(String(authentication)).not.toContain("Invalid key");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({}, { status: 429 })),
		);
		const throttled = await instance
			.findTransactions({ address: "123456", assetCode: "USDT" })
			.catch((error) => error);
		expect(instance.classifyError(throttled)).toBe("rate_limit");
	});
});

function adapter(overrides: Record<string, unknown> = {}) {
	return new BinancePayAdapter({
		apiKey: "api-key",
		secretKey: "secret-key",
		apiUrl: "https://api-gcp.binance.com",
		assetDecimals: { USDT: 8 },
		...overrides,
	});
}

function payRow(id: string, timestamp: number) {
	return {
		fundsDetail: [{ amount: "1", currency: "USDT" }],
		receiverInfo: { binanceId: "123456" },
		transactionId: id,
		transactionTime: timestamp,
	};
}

function payResponse(data: ReturnType<typeof payRow>[]) {
	return Response.json({ code: "000000", success: true, data });
}
