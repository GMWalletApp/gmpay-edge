import type { NormalizedTransaction, TransactionScan } from "./types";

/** Marks a partial scan; see `ScanTruncation` for the cursor contract. */
export function truncatedScan(
	transactions: NormalizedTransaction[],
	scannedThroughBlock?: bigint,
): TransactionScan {
	return Object.assign(transactions, {
		truncated: scannedThroughBlock === undefined ? {} : { scannedThroughBlock },
	});
}
