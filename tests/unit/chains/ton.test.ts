import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TonAdapter } from "#/integrations/chains/ton";

// Operator-stored user-friendly forms and the raw uppercase forms toncenter
// v3 returns for the same accounts.
const owner = "UQCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqppe";
const ownerBounceable = "EQCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqseb";
const ownerRaw = `0:${"A".repeat(64)}`;
const master = `0:${"b".repeat(64)}`;
const masterRaw = `0:${"B".repeat(64)}`;
const senderRaw = `0:${"C".repeat(64)}`;
const senderFriendly = "UQDMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzG38";
const otherRaw = `0:${"D".repeat(64)}`;
const addressBook = {
	[ownerRaw]: { user_friendly: owner },
	[senderRaw]: { user_friendly: senderFriendly },
	[otherRaw]: {
		user_friendly: "UQDd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3USz",
	},
};

describe("TON adapter", () => {
	beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0));
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	it("normalizes incoming Jetton transfers from raw v3 payloads", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				jettonPage([
					{ ...jetton("ton-hash", "900"), amount: "3000000", query_id: "7" },
				]),
			);
		vi.stubGlobal("fetch", fetchMock);
		const [transaction] = await adapter().findTransactions({
			address: owner,
			assetCode: "USDT",
			sinceBlock: 800n,
			sinceTimestampMs: 1_690_000_000_000,
		});
		expect(transaction).toMatchObject({
			network: "ton",
			hash: "ton-hash",
			eventIndex: 7,
			from: senderFriendly,
			to: owner,
			assetCode: "USDT",
			amountUnits: 3_000_000n,
			blockNumber: 900n,
			confirmations: 1,
			success: true,
		});
		const url = String(fetchMock.mock.calls[0]?.[0]);
		expect(url).toContain(
			`owner_address=${encodeURIComponent(`0:${"a".repeat(64)}`)}`,
		);
		expect(url).toContain(`jetton_master=${encodeURIComponent(master)}`);
		expect(url).toContain("start_lt=800");
		expect(url).toContain("start_utime=1690000000");
	});
	it("rejects numeric Jetton amounts before BigInt conversion", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jettonPage([{ ...jetton("numeric", "900"), amount: 1.25 }]),
				),
		);
		await expect(
			adapter().findTransactions({ address: owner, assetCode: "USDT" }),
		).rejects.toThrow();
	});
	it("validates user-friendly TON addresses by checksum", () => {
		expect(adapter().validateAddress(owner)).toBe(true);
		expect(adapter().validateAddress(ownerBounceable)).toBe(true);
		expect(adapter().validateAddress(master)).toBe(false);
		expect(adapter().validateAddress(`UQ${"a".repeat(46)}`)).toBe(false);
	});
	it("rejects a Jetton master that is not a TON address", () => {
		expect(
			() =>
				new TonAdapter({
					apiUrl: "https://toncenter.com/api/v3",
					tokens: { USDT: { master: "not-an-address", decimals: 6 } },
				}),
		).toThrow();
	});
	it("normalizes native TON transfers under the GRAM asset symbol", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				transactionPage([
					{
						...nativeTransaction("native-hash", "901"),
						in_msg: {
							...nativeTransaction("native-hash", "901").in_msg,
							value: "2500000000",
						},
					},
				]),
			),
		);
		const [transaction] = await adapter().findTransactions({
			address: owner,
			assetCode: "GRAM",
		});
		expect(transaction).toMatchObject({
			assetCode: "GRAM",
			amountUnits: 2_500_000_000n,
			from: senderFriendly,
			to: owner,
			success: true,
			confirmations: 1,
		});
	});
	it("fails closed for aborted, bounced, or unattested executions", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					jettonPage([
						{ ...jetton("jetton-ok", "905"), transaction_aborted: false },
						{ ...jetton("jetton-aborted", "904"), transaction_aborted: true },
						{
							...jetton("jetton-unknown", "903"),
							transaction_aborted: undefined,
						},
					]),
				)
				.mockResolvedValueOnce(
					transactionPage([
						nativeTransaction("native-ok", "905"),
						{
							...nativeTransaction("native-aborted", "904"),
							description: {
								...nativeTransaction("native-aborted", "904").description,
								aborted: true,
							},
						},
						{
							...nativeTransaction("native-bounced", "903"),
							in_msg: {
								...nativeTransaction("native-bounced", "903").in_msg,
								bounced: true,
							},
						},
						{
							...nativeTransaction("native-unattested", "902"),
							description: undefined,
						},
						{
							...nativeTransaction("native-uninitialised", "901"),
							description: {
								type: "ord",
								aborted: false,
								destroyed: false,
								credit_first: true,
								compute_ph: { skipped: true, reason: "no_state" },
								action: null,
							},
						},
					]),
				),
		);
		const jettons = await adapter().findTransactions({
			address: owner,
			assetCode: "USDT",
		});
		expect(
			Object.fromEntries(jettons.map((item) => [item.hash, item.success])),
		).toEqual({
			"jetton-ok": true,
			"jetton-aborted": false,
			"jetton-unknown": false,
		});
		const natives = await adapter().findTransactions({
			address: owner,
			assetCode: "GRAM",
		});
		expect(
			Object.fromEntries(natives.map((item) => [item.hash, item.success])),
		).toEqual({
			"native-ok": true,
			"native-aborted": false,
			"native-bounced": false,
			"native-unattested": false,
			"native-uninitialised": true,
		});
	});
	it("paginates Jetton transfers until the offset page is exhausted", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const firstPage = Array.from({ length: 100 }, (_, index) =>
			jetton(`hash-${index}`, String(1_000 - index)),
		);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jettonPage(firstPage))
			.mockResolvedValueOnce(jettonPage([jetton("hash-100", "900")]));
		vi.stubGlobal("fetch", fetchMock);
		const transactions = await adapter().findTransactions({
			address: owner,
			assetCode: "USDT",
			sinceBlock: 800n,
		});
		expect(transactions).toHaveLength(101);
		expect(transactions.truncated).toBeUndefined();
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
	it("stops paging once a page reaches the time lower bound", async () => {
		const page = Array.from({ length: 100 }, (_, index) =>
			jetton(`hash-${index}`, String(1_000 - index)),
		);
		page[99] = { ...jetton("too-old", "901"), transaction_now: 1_600_000_000 };
		const fetchMock = vi.fn().mockResolvedValue(jettonPage(page));
		vi.stubGlobal("fetch", fetchMock);
		const transactions = await adapter().findTransactions({
			address: owner,
			assetCode: "USDT",
			sinceTimestampMs: 1_650_000_000_000,
		});
		expect(transactions).toHaveLength(99);
		expect(transactions.truncated).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("returns the newest rows as a truncated scan when the page budget is exhausted", async () => {
		const page = Array.from({ length: 100 }, (_, index) =>
			jetton(`hash-${index}`, String(1_000 - index)),
		);
		const fetchMock = vi.fn().mockResolvedValue(jettonPage(page));
		vi.stubGlobal("fetch", fetchMock);
		const transactions = await adapter({ maxPages: 1 }).findTransactions({
			address: owner,
			assetCode: "USDT",
		});
		expect(transactions).toHaveLength(100);
		expect(transactions.truncated).toEqual({});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("shares one deadline across all transfer pages", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const fetchMock = vi.fn(async () => {
			now = 1001;
			return jettonPage(
				Array.from({ length: 100 }, (_, index) =>
					jetton(`hash-${index}`, String(1_000 - index)),
				),
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			adapter({ timeoutMs: 1000 }).findTransactions({
				address: owner,
				assetCode: "USDT",
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("matches a stored friendly target against raw provider destinations", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				jettonPage([
					{ ...jetton("multi", "902"), destination: otherRaw, query_id: "1" },
					{ ...jetton("multi", "902"), destination: ownerRaw, query_id: "2" },
				]),
			),
		);
		await expect(
			adapter().getTransaction("multi", {
				address: owner,
				assetCode: "USDT",
			}),
		).resolves.toMatchObject({ to: owner, eventIndex: 2, assetCode: "USDT" });
	});
	it("ignores Jetton transfers of unconfigured masters", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					jettonPage([
						{ ...jetton("foreign", "902"), jetton_master: otherRaw },
					]),
				),
		);
		await expect(
			adapter().getTransaction("foreign", {
				address: owner,
				assetCode: "USDT",
			}),
		).resolves.toBeNull();
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

function adapter(overrides: Record<string, unknown> = {}) {
	return new TonAdapter({
		apiUrl: "https://toncenter.com/api/v3",
		nativeAsset: "GRAM",
		tokens: { USDT: { master, decimals: 6 } },
		...overrides,
	});
}

function jetton(hash: string, lt: string) {
	return {
		query_id: "0",
		source: senderRaw,
		destination: ownerRaw,
		amount: "1",
		source_wallet: `0:${"E".repeat(64)}`,
		jetton_master: masterRaw,
		transaction_hash: hash,
		transaction_lt: lt,
		transaction_now: 1_700_000_000,
		transaction_aborted: false,
		response_destination: senderRaw,
		custom_payload: null,
		forward_ton_amount: "1",
		forward_payload: null,
	};
}

function nativeTransaction(hash: string, lt: string) {
	return {
		account: ownerRaw,
		hash,
		lt,
		now: 1_700_000_000,
		orig_status: "active",
		end_status: "active",
		total_fees: "1000000",
		description: {
			type: "ord",
			aborted: false,
			destroyed: false,
			credit_first: true,
			compute_ph: { skipped: false, success: true, exit_code: 0 },
			action: { success: true, valid: true, no_funds: false, result_code: 0 },
		},
		in_msg: {
			hash: `${hash}-in`,
			source: senderRaw,
			destination: ownerRaw,
			value: "1000000000",
			bounce: false,
			bounced: false,
			created_lt: lt,
		},
		out_msgs: [],
	};
}

function jettonPage(jetton_transfers: unknown[]) {
	return json({ jetton_transfers, address_book: addressBook });
}

function transactionPage(transactions: unknown[]) {
	return json({ transactions, address_book: addressBook });
}

function json(value: unknown) {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}
