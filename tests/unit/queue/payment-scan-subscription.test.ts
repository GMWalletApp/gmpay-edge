import { describe, expect, it, vi } from "vitest";
import { scanTransactions } from "#/server/queue/payment-scan";

describe("payment scan WSS consumption", () => {
	it("merges bounded subscription events with the polling result", async () => {
		const transaction = {
			network: "ethereum" as const,
			hash: "0xpush",
			eventIndex: 0,
			from: "0x2222222222222222222222222222222222222222",
			to: "0x1111111111111111111111111111111111111111",
			assetCode: "USDT",
			amountUnits: 2n,
			blockNumber: 12n,
			blockHash: "0xblock",
			confirmations: 1,
			timestamp: new Date(),
			success: true,
		};
		const adapter = {
			findTransactions: vi.fn().mockResolvedValue([]),
			subscribeTransactions: vi.fn(
				async ({
					onTransaction,
				}: {
					onTransaction: (value: typeof transaction) => void;
				}) => {
					onTransaction(transaction);
					return { reconnects: 1 };
				},
			),
			getTransaction: vi.fn(),
		};
		const db = {
			prepare: vi.fn(() => ({
				bind: vi.fn(() => ({
					all: vi.fn().mockResolvedValue({ results: [] }),
				})),
			})),
		} as unknown as D1Database;

		await expect(
			scanTransactions(
				db,
				{
					kind: "payment.scan",
					version: 1,
					orderId: "order",
					receivingMethodId: "method",
					address: transaction.to,
				},
				"USDT",
				adapter as never,
			),
		).resolves.toMatchObject({ transactions: [transaction] });
		expect(adapter.findTransactions).toHaveBeenCalledOnce();
		expect(adapter.subscribeTransactions).toHaveBeenCalledOnce();
	});

	it("runs the bounded subscription alongside polling without delaying the result", async () => {
		const transaction = payment();
		let subscriptionSignal: AbortSignal | undefined;
		const adapter = {
			findTransactions: vi.fn().mockResolvedValue([transaction]),
			subscribeTransactions: vi.fn(
				({ signal }: { signal: AbortSignal }) =>
					new Promise<{ reconnects: number }>((resolve) => {
						subscriptionSignal = signal;
						signal.addEventListener("abort", () => resolve({ reconnects: 0 }), {
							once: true,
						});
					}),
			),
			getTransaction: vi.fn(),
		};

		await expect(
			scanTransactions(
				emptyPaymentsDb(),
				message(transaction.to),
				"USDT",
				adapter as never,
			),
		).resolves.toEqual({ transactions: [transaction] });
		expect(subscriptionSignal?.aborted).toBe(true);
	});

	it("keeps the authoritative poll result when the subscription fails", async () => {
		const transaction = payment();
		const adapter = {
			findTransactions: vi.fn().mockResolvedValue([transaction]),
			subscribeTransactions: vi
				.fn()
				.mockRejectedValue(new TypeError("socket unavailable")),
			getTransaction: vi.fn(),
		};

		await expect(
			scanTransactions(
				emptyPaymentsDb(),
				message(transaction.to),
				"USDT",
				adapter as never,
			),
		).resolves.toEqual({ transactions: [transaction] });
	});

	it("records a failed supplemental WSS connection without failing HTTP polling", async () => {
		const transaction = payment();
		const healthWrites: unknown[][] = [];
		const pollingAdapter = {
			findTransactions: vi.fn().mockResolvedValue([transaction]),
			getTransaction: vi.fn(),
		};
		const subscriptionAdapter = {
			subscribeTransactions: vi
				.fn()
				.mockRejectedValue(new TypeError("socket unavailable")),
			classifyError: vi.fn().mockReturnValue("network"),
		};

		await expect(
			scanTransactions(
				healthDb(healthWrites),
				message(transaction.to),
				"USDT",
				pollingAdapter as never,
				{
					connectionId: "connection-ethereum-wss",
					adapter: subscriptionAdapter as never,
				},
			),
		).resolves.toEqual({ transactions: [transaction] });
		expect(healthWrites).toContainEqual([
			"unhealthy",
			expect.any(Number),
			"network",
			expect.any(Number),
			"connection-ethereum-wss",
		]);
	});
});

function payment() {
	return {
		network: "ethereum" as const,
		hash: "0xpoll",
		eventIndex: 0,
		from: "0x2222222222222222222222222222222222222222",
		to: "0x1111111111111111111111111111111111111111",
		assetCode: "USDT",
		amountUnits: 2n,
		blockNumber: 12n,
		blockHash: "0xblock",
		confirmations: 1,
		timestamp: new Date(0),
		success: true,
	};
}

function message(address: string) {
	return {
		kind: "payment.scan" as const,
		version: 1 as const,
		orderId: "order",
		receivingMethodId: "method",
		address,
	};
}

function emptyPaymentsDb() {
	return {
		prepare: vi.fn(() => ({
			bind: vi.fn(() => ({
				all: vi.fn().mockResolvedValue({ results: [] }),
			})),
		})),
	} as unknown as D1Database;
}

function healthDb(writes: unknown[][]) {
	return {
		prepare(sql: string) {
			return {
				bind(...values: unknown[]) {
					return sql.startsWith("UPDATE payment_ingresses")
						? {
								run: async () => {
									writes.push(values);
								},
							}
						: { all: async () => ({ results: [] }) };
				},
			};
		},
	} as unknown as D1Database;
}
