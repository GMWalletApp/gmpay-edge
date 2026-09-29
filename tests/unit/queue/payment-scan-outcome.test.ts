import { describe, expect, it, vi } from "vitest";
import type { NormalizedTransaction } from "#/integrations/chains/types";
import { scanTransactions } from "#/server/queue/payment-scan";

const address = "0x1111111111111111111111111111111111111111";

describe("payment scan outcome", () => {
	it("passes the order lower bound and cursor to address discovery", async () => {
		const adapter = {
			findTransactions: vi.fn().mockResolvedValue([]),
			getTransaction: vi.fn(),
		};
		await scanTransactions(
			emptyPaymentsDb(),
			{ ...message(), sinceBlock: "120", sinceTimestampMs: 1_700_000_000_000 },
			"USDT",
			adapter as never,
		);
		expect(adapter.findTransactions).toHaveBeenCalledWith({
			address,
			assetCode: "USDT",
			sinceBlock: 120n,
			sinceTimestampMs: 1_700_000_000_000,
		});
	});

	it("still refreshes known payments and reports the failure when discovery throws", async () => {
		const stored = pendingRow();
		const refreshed = transaction({ confirmations: 4, blockHash: "0xnewer" });
		const failure = new TypeError("provider offline");
		const adapter = {
			findTransactions: vi.fn().mockRejectedValue(failure),
			getTransaction: vi.fn().mockResolvedValue(refreshed),
		};
		const outcome = await scanTransactions(
			paymentsDb([stored]),
			message(),
			"USDT",
			adapter as never,
		);
		expect(outcome).toEqual({
			transactions: [refreshed],
			discoveryError: { cause: failure },
		});
		expect(adapter.getTransaction).toHaveBeenCalledWith("0xpending", {
			address,
			assetCode: "USDT",
			eventIndex: 0,
			observedAtMs: stored.observed_at,
		});
	});

	it("propagates truncation from a bounded discovery", async () => {
		const found = transaction({ hash: "0xfound" });
		const adapter = {
			findTransactions: vi
				.fn()
				.mockResolvedValue(
					Object.assign([found], { truncated: { scannedThroughBlock: 12n } }),
				),
			getTransaction: vi.fn(),
		};
		await expect(
			scanTransactions(emptyPaymentsDb(), message(), "USDT", adapter as never),
		).resolves.toEqual({
			transactions: [found],
			truncated: { scannedThroughBlock: 12n },
		});
	});
});

function message() {
	return {
		kind: "payment.scan" as const,
		version: 1 as const,
		orderId: "order",
		receivingMethodId: "method",
		address,
	};
}

function transaction(
	overrides: Partial<NormalizedTransaction> = {},
): NormalizedTransaction {
	return {
		network: "ethereum",
		hash: "0xpending",
		eventIndex: 0,
		from: "0x2222222222222222222222222222222222222222",
		to: address,
		assetCode: "USDT",
		amountUnits: 2n,
		blockNumber: 9n,
		blockHash: "0xblock",
		confirmations: 1,
		timestamp: new Date(1_700_000_000_000),
		success: true,
		canonical: true,
		...overrides,
	};
}

function pendingRow() {
	return {
		network: "ethereum",
		tx_hash: "0xpending",
		event_index: 0,
		from_address: "0x2222222222222222222222222222222222222222",
		to_address: address,
		asset_code: "USDT",
		amount_units: "2",
		block_number: "9",
		block_hash: "0xblock",
		confirmations: 1,
		status: "pending",
		observed_at: 1_700_000_000_000,
	};
}

function paymentsDb(rows: ReturnType<typeof pendingRow>[]) {
	return {
		prepare: vi.fn(() => ({
			bind: vi.fn(() => ({
				all: vi.fn().mockResolvedValue({ results: rows }),
				run: vi.fn().mockResolvedValue({}),
			})),
		})),
	} as unknown as D1Database;
}

function emptyPaymentsDb() {
	return paymentsDb([]);
}
