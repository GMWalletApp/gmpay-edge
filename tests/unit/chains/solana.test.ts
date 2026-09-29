import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SolanaAdapter } from "#/integrations/chains/solana";

const owner = "11111111111111111111111111111111";
const tokenAccount = "22222222222222222222222222222222";
const sourceAccount = "33333333333333333333333333333333";
const mint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

describe("Solana adapter", () => {
	beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0));
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	it("discovers token accounts and normalizes parsed SPL transfers", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(rpc({ value: [{ pubkey: tokenAccount }] }))
				.mockResolvedValueOnce(
					rpc([
						{
							signature: "signature",
							slot: 100,
							blockTime: 1_700_000_000,
							err: null,
							confirmationStatus: "finalized",
						},
					]),
				)
				.mockResolvedValueOnce(
					rpc({
						blockTime: 1_700_000_000,
						slot: 100,
						transaction: {
							message: {
								accountKeys: [sourceAccount, tokenAccount],
								recentBlockhash: "blockhash",
								instructions: [
									{
										parsed: {
											type: "transferChecked",
											info: {
												source: sourceAccount,
												destination: tokenAccount,
												mint,
												tokenAmount: { amount: "4200000" },
											},
										},
									},
								],
							},
						},
						meta: {
							err: null,
							innerInstructions: [],
							postTokenBalances: [{ accountIndex: 1, mint, owner }],
						},
					}),
				),
		);
		const [transaction] = await adapter().findTransactions({
			address: owner,
			assetCode: "USDT",
			sinceBlock: 90n,
		});
		expect(transaction).toMatchObject({
			network: "solana",
			hash: "signature",
			from: sourceAccount,
			to: owner,
			assetCode: "USDT",
			amountUnits: 4_200_000n,
			blockNumber: 100n,
			confirmations: 1,
			success: true,
		});
	});
	it("normalizes native SOL system transfers", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					rpc([
						{
							signature: "native-signature",
							slot: 101,
							blockTime: 1_700_000_001,
							err: null,
							confirmationStatus: "finalized",
						},
					]),
				)
				.mockResolvedValueOnce(
					rpc({
						blockTime: 1_700_000_001,
						slot: 101,
						transaction: {
							message: {
								accountKeys: [sourceAccount, owner],
								recentBlockhash: "native-blockhash",
								instructions: [
									{
										parsed: {
											type: "transfer",
											info: {
												source: sourceAccount,
												destination: owner,
												lamports: 1_500_000_000,
											},
										},
									},
								],
							},
						},
						meta: { err: null, innerInstructions: [] },
					}),
				),
		);
		const [transaction] = await adapter().findTransactions({
			address: owner,
			assetCode: "SOL",
			sinceBlock: 100n,
		});
		expect(transaction).toMatchObject({
			network: "solana",
			hash: "native-signature",
			from: sourceAccount,
			to: owner,
			assetCode: "SOL",
			amountUnits: 1_500_000_000n,
			blockNumber: 101n,
			confirmations: 1,
			success: true,
		});
	});
	it("ignores unsafe numeric native amounts", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(rpc([signature("unsafe-signature", 101)]))
				.mockResolvedValueOnce(
					rpc({
						blockTime: 1_700_000_001,
						slot: 101,
						transaction: {
							message: {
								accountKeys: [sourceAccount, owner],
								recentBlockhash: "unsafe-blockhash",
								instructions: [
									{
										parsed: {
											type: "transfer",
											info: {
												source: sourceAccount,
												destination: owner,
												lamports: Number.MAX_SAFE_INTEGER + 1,
											},
										},
									},
								],
							},
						},
						meta: { err: null, innerInstructions: [] },
					}),
				),
		);
		expect(
			await adapter().findTransactions({
				address: owner,
				assetCode: "SOL",
				sinceBlock: 100n,
			}),
		).toEqual([]);
	});
	it("paginates signatures with the before cursor", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				rpc([signature("sig-3", 103), signature("sig-2", 102)]),
			)
			.mockResolvedValueOnce(rpc([signature("sig-1", 101)]))
			.mockImplementation(async () => rpc(null));
		vi.stubGlobal("fetch", fetchMock);
		await new SolanaAdapter({
			rpcUrl: "https://api.mainnet-beta.solana.com",
			signaturePageSize: 2,
		}).findTransactions({ address: owner, assetCode: "SOL", sinceBlock: 100n });
		const secondRequest = JSON.parse(
			String((fetchMock.mock.calls[1]?.[1] as RequestInit)?.body),
		) as { params: [string, { before?: string }] };
		expect(secondRequest.params[1].before).toBe("sig-2");
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "solana",
				operation: "find_transactions",
				requestCount: 5,
				paginationRequestCount: 2,
			}),
		);
	});
	it("rejects token account fan-out above the configured limit", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			rpc({
				value: [{ pubkey: tokenAccount }, { pubkey: sourceAccount }],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			new SolanaAdapter({
				rpcUrl: "https://api.mainnet-beta.solana.com",
				maxTokenAccounts: 1,
				tokens: { USDT: { mint, decimals: 6 } },
			}).findTransactions({ address: owner, assetCode: "USDT" }),
		).rejects.toThrow("token account scan exceeded");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("returns the newest signatures as a truncated scan when the budget is spent", async () => {
		const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
			const request = JSON.parse(String((init as RequestInit)?.body)) as {
				method: string;
			};
			return request.method === "getSignaturesForAddress"
				? rpc([signature("bounded-signature", 101)])
				: rpc(null);
		});
		vi.stubGlobal("fetch", fetchMock);
		const transactions = await new SolanaAdapter({
			rpcUrl: "https://api.mainnet-beta.solana.com",
			signaturePageSize: 1,
			maxScanSignatures: 1,
		}).findTransactions({ address: owner, assetCode: "SOL" });
		expect(transactions).toHaveLength(0);
		expect(transactions.truncated).toEqual({});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it("stops at the block-time lower bound without paging further", async () => {
		const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
			const request = JSON.parse(String((init as RequestInit)?.body)) as {
				method: string;
			};
			return request.method === "getSignaturesForAddress"
				? rpc([
						signature("recent", 103),
						{ ...signature("too-old", 102), blockTime: 1_600_000_000 },
					])
				: rpc(null);
		});
		vi.stubGlobal("fetch", fetchMock);
		const transactions = await new SolanaAdapter({
			rpcUrl: "https://api.mainnet-beta.solana.com",
			signaturePageSize: 2,
		}).findTransactions({
			address: owner,
			assetCode: "SOL",
			sinceTimestampMs: 1_650_000_000_000,
		});
		expect(transactions).toHaveLength(0);
		expect(transactions.truncated).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const lookups = fetchMock.mock.calls.map(
			([, init]) =>
				(
					JSON.parse(String((init as RequestInit)?.body)) as {
						params: [string];
					}
				).params[0],
		);
		expect(lookups).toEqual([owner, "recent"]);
	});
	it("rejects a transaction without execution metadata as an invalid response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				rpc({
					blockTime: 1_700_000_000,
					slot: 100,
					transaction: {
						message: {
							accountKeys: [sourceAccount, tokenAccount],
							recentBlockhash: "blockhash",
							instructions: [transferInstruction(tokenAccount, "1")],
						},
					},
					meta: null,
				}),
			),
		);
		const instance = adapter();
		const error = await instance
			.getTransaction("no-meta", { address: owner, assetCode: "USDT" })
			.catch((cause) => cause);
		expect(instance.classifyError(error)).toBe("invalid_response");
	});
	it("skips instructions whose parsed payload is not a transfer shape", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				rpc({
					blockTime: 1_700_000_000,
					slot: 100,
					transaction: {
						message: {
							accountKeys: [sourceAccount, tokenAccount],
							recentBlockhash: "blockhash",
							instructions: [
								{ parsed: { type: "transferChecked", info: { mint } } },
								{ parsed: "not-an-object" },
								{ programId: "11111111111111111111111111111111", data: "raw" },
								{
									parsed: {
										type: "transferChecked",
										info: {
											source: sourceAccount,
											destination: tokenAccount,
											mint,
											tokenAmount: { amount: "not-a-number" },
										},
									},
								},
							],
						},
					},
					meta: {
						err: null,
						innerInstructions: [],
						postTokenBalances: [{ accountIndex: 1, mint, owner }],
					},
				}),
			),
		);
		await expect(
			adapter().getTransaction("shapes", { address: owner, assetCode: "USDT" }),
		).resolves.toBeNull();
	});
	it("shares one deadline between signature and transaction requests", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const fetchMock = vi.fn(async () => {
			now = 1001;
			return rpc([signature("slow-signature", 101)]);
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			new SolanaAdapter({
				rpcUrl: "https://api.mainnet-beta.solana.com",
				timeoutMs: 1000,
			}).findTransactions({ address: owner, assetCode: "SOL" }),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("selects the requested transfer from a multi-transfer transaction", async () => {
		const other = "44444444444444444444444444444444";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				rpc({
					blockTime: 1_700_000_000,
					slot: 200,
					transaction: {
						message: {
							accountKeys: [sourceAccount, other, tokenAccount],
							recentBlockhash: "blockhash",
							instructions: [
								transferInstruction(other, "1"),
								transferInstruction(tokenAccount, "2"),
							],
						},
					},
					meta: {
						err: null,
						innerInstructions: [],
						postTokenBalances: [
							{ accountIndex: 1, mint, owner: other },
							{ accountIndex: 2, mint, owner },
						],
					},
				}),
			),
		);
		await expect(
			adapter().getTransaction("multi-signature", {
				address: owner,
				assetCode: "USDT",
			}),
		).resolves.toMatchObject({ to: owner, eventIndex: 1, amountUnits: 2n });
	});
	it("classifies provider throttling without treating it as malformed data", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 429 })),
		);
		const instance = adapter();
		const error = await instance
			.findTransactions({ address: owner, assetCode: "SOL" })
			.catch((cause) => cause);
		expect(instance.classifyError(error)).toBe("rate_limit");
	});
	it("observes confirmation lookups at their provider request owner", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				rpc({
					value: [{ confirmationStatus: "finalized", confirmations: null }],
				}),
			),
		);
		await expect(
			adapter().getConfirmations({ hash: "signature" } as never),
		).resolves.toBe(1);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "solana",
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
			detail: "Solana health check failed: network",
		});
		expect(health.detail).not.toContain("provider-secret-and-url");
	});
});

function adapter() {
	return new SolanaAdapter({
		rpcUrl: "https://api.mainnet-beta.solana.com",
		tokens: { USDT: { mint, decimals: 6 } },
	});
}
function rpc(result: unknown) {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function signature(value: string, slot: number) {
	return {
		signature: value,
		slot,
		blockTime: 1_700_000_000,
		err: null,
		confirmationStatus: "finalized",
	};
}

function transferInstruction(destination: string, amount: string) {
	return {
		parsed: {
			type: "transferChecked",
			info: {
				source: sourceAccount,
				destination,
				mint,
				tokenAmount: { amount },
			},
		},
	};
}
