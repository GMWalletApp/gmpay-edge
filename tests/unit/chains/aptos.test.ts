import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AptosAdapter } from "#/integrations/chains/aptos";

const owner = `0x${"1".repeat(64)}`;
const shortOwner = `0x${"0".repeat(63)}1`;
const assetType = `0x${"2".repeat(64)}`;

describe("Aptos adapter", () => {
	beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0));
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	it("normalizes finalized fungible asset deposits", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: {
							fungible_asset_activities: [
								{
									amount: "2500000",
									asset_type: assetType,
									event_index: 7,
									is_transaction_success: true,
									owner_address: owner,
									transaction_timestamp: "2025-01-01T00:00:00Z",
									transaction_version: "12345",
									type: "deposit",
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		);
		const [transaction] = await adapter().findTransactions({
			address: owner,
			assetCode: "USDT",
			sinceBlock: 10000n,
		});
		expect(transaction).toMatchObject({
			network: "aptos",
			hash: "12345",
			to: owner,
			assetCode: "USDT",
			amountUnits: 2_500_000n,
			blockNumber: 12_345n,
			eventIndex: 7,
			confirmations: 1,
			success: true,
		});
	});
	it("normalizes short account addresses to 32 bytes", async () => {
		await expect(
			adapter().createPaymentTarget({ address: "0x1", expiresAt: new Date(0) }),
		).resolves.toMatchObject({ address: shortOwner });
	});
	it("rejects numeric atomic amounts before BigInt conversion", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					graphql([
						{ ...activity(777), amount: 2_500_000 },
					] as unknown as ReturnType<typeof activity>[]),
				),
		);
		await expect(
			adapter().findTransactions({ address: owner, assetCode: "USDT" }),
		).rejects.toThrow();
	});
	it("normalizes native APT deposits", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: {
							fungible_asset_activities: [
								{
									amount: "125000000",
									asset_type: "0x1::aptos_coin::AptosCoin",
									event_index: "3",
									is_transaction_success: true,
									owner_address: owner,
									transaction_timestamp: "2025-01-01T00:00:00Z",
									transaction_version: "12346",
									type: "deposit",
								},
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		);
		const [transaction] = await adapter().findTransactions({
			address: owner,
			assetCode: "APT",
		});
		expect(transaction).toMatchObject({
			assetCode: "APT",
			amountUnits: 125_000_000n,
			to: owner,
			success: true,
		});
	});
	it("paginates fungible asset activity with GraphQL offsets", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				graphql(
					Array.from({ length: 100 }, (_, index) => activity(1_000 - index)),
				),
			)
			.mockResolvedValueOnce(graphql([activity(900)]));
		vi.stubGlobal("fetch", fetchMock);
		const transactions = await adapter().findTransactions({
			address: owner,
			assetCode: "USDT",
		});
		expect(transactions).toHaveLength(101);
		const secondBody = JSON.parse(
			String((fetchMock.mock.calls[1]?.[1] as RequestInit)?.body),
		) as { variables: { offset: number } };
		expect(secondBody.variables.offset).toBe(100);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "aptos",
				operation: "find_transactions",
				requestCount: 2,
				paginationRequestCount: 2,
			}),
		);
	});
	it("passes the time lower bound to the Indexer and truncates at the page budget", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				graphql(
					Array.from({ length: 100 }, (_, index) => activity(1_000 - index)),
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		const transactions = await new AptosAdapter({
			indexerUrl: "https://api.mainnet.aptoslabs.com/v1/graphql",
			maxPages: 1,
			tokens: { USDT: { assetType, decimals: 6 } },
		}).findTransactions({
			address: owner,
			assetCode: "USDT",
			sinceTimestampMs: Date.UTC(2025, 5, 1),
		});
		expect(transactions).toHaveLength(100);
		expect(transactions.truncated).toEqual({});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit)?.body),
		) as { query: string; variables: { sinceTimestamp: string } };
		expect(body.variables.sinceTimestamp).toBe("2025-06-01T00:00:00.000Z");
		expect(body.query).toContain(
			"transaction_timestamp: { _gte: $sinceTimestamp }",
		);
	});
	it("shares one deadline across all activity pages", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const fetchMock = vi.fn(async () => {
			now = 1001;
			return graphql(
				Array.from({ length: 100 }, (_, index) => activity(1_000 - index)),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			new AptosAdapter({
				indexerUrl: "https://api.mainnet.aptoslabs.com/v1/graphql",
				timeoutMs: 1000,
				tokens: { USDT: { assetType, decimals: 6 } },
			}).findTransactions({ address: owner, assetCode: "USDT" }),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("selects the requested stable event from a multi-event version", async () => {
		const other = `0x${"3".repeat(64)}`;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				graphql([
					{ ...activity(777), event_index: 1, owner_address: other },
					{ ...activity(777), event_index: 9, owner_address: owner },
				]),
			),
		);
		await expect(
			adapter().getTransaction("777", {
				address: owner,
				assetCode: "USDT",
				eventIndex: 9,
			}),
		).resolves.toMatchObject({ to: owner, eventIndex: 9, hash: "777" });
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
	it("does not expose GraphQL provider diagnostics", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					errors: [{ message: "query failed for secret account 0x123" }],
				}),
			),
		);
		const health = await adapter().healthCheck();
		expect(health).toMatchObject({
			healthy: false,
			detail: "Aptos health check failed: invalid_response",
		});
		expect(health.detail).not.toContain("secret account");
	});
});

function adapter() {
	return new AptosAdapter({
		indexerUrl: "https://api.mainnet.aptoslabs.com/v1/graphql",
		tokens: { USDT: { assetType, decimals: 6 } },
	});
}

function activity(version: number) {
	return {
		amount: "1",
		asset_type: assetType,
		event_index: version % 11,
		is_transaction_success: true,
		owner_address: owner,
		transaction_timestamp: "2025-01-01T00:00:00Z",
		transaction_version: String(version),
		type: "deposit",
	};
}

function graphql(rows: ReturnType<typeof activity>[]) {
	return Response.json({ data: { fungible_asset_activities: rows } });
}
