import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { PaymentScanMessage } from "#/features/payments/types";
import type { NormalizedTransaction } from "#/integrations/chains/types";
import {
	advancePaymentScanCursor,
	handlePaymentScan,
	processScannedTransactions,
} from "#/server/queue";
import { applyMigrations } from "./migrations";

const target = "0x1111111111111111111111111111111111111111";
const sender = "0x2222222222222222222222222222222222222222";
const contract = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const transferTopic =
	"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

describe("payment scan cursor, health, and unattributed transfers", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-payment-scan-cursor" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	afterAll(async () => miniflare.dispose());

	it("advances the cursor only over fully scanned ranges and caps it at unattributed transfers", async () => {
		await expect(
			advancePaymentScanCursor(db, "order-shared-a", [{ blockNumber: 50n }], {
				truncated: {},
			}),
		).resolves.toBeNull();
		expect(await cursor(db, "order-shared-a")).toBeNull();
		await expect(
			advancePaymentScanCursor(db, "order-shared-a", [{ blockNumber: 50n }], {
				truncated: { scannedThroughBlock: 40n },
			}),
		).resolves.toBe(40n);
		expect(await cursor(db, "order-shared-a")).toBe("40");
		await expect(
			advancePaymentScanCursor(db, "order-shared-a", [{ blockNumber: 60n }], {
				capBlock: 45n,
			}),
		).resolves.toBe(45n);
		expect(await cursor(db, "order-shared-a")).toBe("45");
		await expect(
			advancePaymentScanCursor(db, "order-shared-a", [{ blockNumber: 60n }]),
		).resolves.toBe(60n);
		expect(await cursor(db, "order-shared-a")).toBe("60");
	});

	it("records an ambiguous shared-address transfer once and reports it for the cursor cap", async () => {
		const env = { DB: db, WEBHOOK_QUEUE: { send: vi.fn() } } as unknown as Env;
		const transfer = transaction({
			hash: "0xambiguous",
			amountUnits: 4_000_000n,
			blockNumber: 77n,
		});
		const unattributed: bigint[] = [];
		await expect(
			processScannedTransactions(env, "order-shared-a", [transfer], undefined, {
				onUnattributed: (item) => {
					unattributed.push(item.blockNumber);
				},
			}),
		).resolves.toEqual({ skippedPreviouslyAttributed: 0, skippedAmbiguous: 1 });
		expect(unattributed).toEqual([77n]);
		await processScannedTransactions(env, "order-shared-b", [transfer]);
		const audits = await db
			.prepare(
				"SELECT target_type, target_id, after FROM audit_logs WHERE action = 'payment.scan_unattributed'",
			)
			.all<{ target_type: string; target_id: string; after: string }>();
		expect(audits.results).toHaveLength(1);
		expect(audits.results[0]).toMatchObject({
			target_type: "transaction",
			target_id: "ethereum:0xambiguous:0",
		});
		expect(JSON.parse(audits.results[0]?.after ?? "{}")).toMatchObject({
			orderId: "order-shared-a",
			code: "payment_attribution_ambiguous",
			amountUnits: "4000000",
			blockNumber: "77",
		});
		const payments = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM order_payments WHERE order_id IN ('order-shared-a', 'order-shared-b')",
			)
			.first<{ count: number }>();
		expect(payments?.count).toBe(0);
	});

	it("keeps the connection healthy and still refreshes known payments when discovery fails permanently", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		const methods: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				const request = JSON.parse(String(init?.body)) as {
					method: string;
					params: unknown[];
				};
				methods.push(request.method);
				switch (request.method) {
					case "eth_blockNumber":
						return rpc("0xa");
					case "eth_getLogs":
						return new Response("bad request", { status: 400 });
					case "eth_getTransactionByHash":
						return rpc({
							blockHash: "0xblock",
							blockNumber: "0x9",
							from: sender,
							hash: "0xpending",
							to: contract,
							value: "0x0",
						});
					case "eth_getTransactionReceipt":
						return rpc({
							blockHash: "0xblock",
							blockNumber: "0x9",
							logs: [
								{
									address: contract,
									blockHash: "0xblock",
									blockNumber: "0x9",
									data: "0xf4240",
									logIndex: "0x0",
									removed: false,
									topics: [
										transferTopic,
										`0x${sender.slice(2).padStart(64, "0")}`,
										`0x${target.slice(2).padStart(64, "0")}`,
									],
									transactionHash: "0xpending",
								},
							],
							status: "0x1",
							transactionHash: "0xpending",
						});
					case "eth_getBlockByHash":
						return rpc({
							hash: "0xblock",
							number: "0x9",
							timestamp: "0x6553f100",
							transactions: [],
						});
					default:
						throw new Error(`Unexpected RPC method ${request.method}`);
				}
			}),
		);
		const ack = vi.fn();
		const retry = vi.fn();
		await handlePaymentScan(
			{
				body: {
					kind: "payment.scan",
					version: 1,
					receivingMethodId: "method-eth",
					orderId: "order-usdt",
				},
				ack,
				retry,
			} as unknown as Message<PaymentScanMessage>,
			{ DB: db, WEBHOOK_QUEUE: { send: vi.fn() } } as unknown as Env,
		);
		expect(ack).toHaveBeenCalledOnce();
		expect(retry).not.toHaveBeenCalled();
		expect(methods).toContain("eth_getLogs");
		expect(methods).toContain("eth_getTransactionReceipt");
		const health = await db
			.prepare(
				"SELECT health_status, last_error_code FROM payment_ingresses WHERE id = 'connection-primary'",
			)
			.first<{ health_status: string; last_error_code: string | null }>();
		expect(health).toEqual({ health_status: "healthy", last_error_code: null });
		const issue = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action = 'payment.scan_failed' AND target_id = 'order-usdt'",
			)
			.first<{ after: string }>();
		expect(JSON.parse(issue?.after ?? "{}")).toMatchObject({
			kind: "permanent",
		});
		const payment = await db
			.prepare(
				"SELECT confirmations, status FROM order_payments WHERE transaction_id = 'ethereum:0xpending:0'",
			)
			.first<{ confirmations: number; status: string }>();
		expect(payment).toEqual({ confirmations: 2, status: "confirmed" });
		const order = await db
			.prepare(
				"SELECT status, payment_scan_cursor FROM orders WHERE id = 'order-usdt'",
			)
			.first<{ status: string; payment_scan_cursor: string | null }>();
		expect(order).toEqual({ status: "paid", payment_scan_cursor: null });
	});
});

function transaction(
	overrides: Partial<NormalizedTransaction>,
): NormalizedTransaction {
	return {
		network: "ethereum",
		hash: "0xtx",
		eventIndex: 0,
		from: sender,
		to: target,
		assetCode: "USDT",
		amountUnits: 1_000_000n,
		blockNumber: 9n,
		blockHash: "0xblock",
		confirmations: 2,
		timestamp: new Date(),
		success: true,
		canonical: true,
		...overrides,
	};
}

async function cursor(db: D1Database, orderId: string) {
	const row = await db
		.prepare("SELECT payment_scan_cursor FROM orders WHERE id = ?")
		.bind(orderId)
		.first<{ payment_scan_cursor: string | null }>();
	return row?.payment_scan_cursor ?? null;
}

function rpc(result: unknown) {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function seed(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db.prepare(
			`INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, metadata, created_at, updated_at)
			 VALUES ('ethereum', 'Ethereum', 'chain', 'evm', '{"nativeSymbol":"ETH"}', 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO payment_assets (id, rail_code, code, symbol, kind, contract_address, decimals, default_confirmations, created_at, updated_at)
				 VALUES ('asset-usdt', 'ethereum', 'USDT', 'USDT', 'token', ?, 6, 2, 1, 1)`,
			)
			.bind(contract),
		db.prepare(
			`INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, priority, enabled, health_status, created_at, updated_at)
			 VALUES ('connection-primary', 'ethereum', 'Primary', 'rpc', 'https://primary.example', 1, 1, 'healthy', 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at)
				 VALUES ('method-eth', 'Primary USDT', 'ethereum', 'address', ?, ?, 1, 1, 1)`,
			)
			.bind(target, target),
		db.prepare(
			"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('orders.immediate_release_mode', 'true', 0, 0, 0)",
		),
	]);
	await db.batch([
		...order(db, "order-usdt", "confirming", "1000000", "1000000", now),
		...order(db, "order-shared-a", "pending", "12000000", "0", now),
		...order(db, "order-shared-b", "pending", "12000001", "0", now),
		db
			.prepare(
				`INSERT INTO blockchain_transactions (id, network, tx_hash, event_index, from_address, to_address, asset_code, amount_units, block_number, block_hash, confirmations, status, observed_at, created_at, updated_at)
				 VALUES ('bt-pending', 'ethereum', '0xpending', 0, ?, ?, 'USDT', '1000000', '9', '0xblock', 1, 'pending', ?, ?, ?)`,
			)
			.bind(sender, target, now, now, now),
		db
			.prepare(
				`INSERT INTO order_payments (id, order_id, transaction_id, amount_units, confirmations, status, detected_at, created_at, updated_at)
				 VALUES ('op-pending', 'order-usdt', 'ethereum:0xpending:0', '1000000', 1, 'confirming', ?, ?, ?)`,
			)
			.bind(now, now, now),
	]);
}

function order(
	db: D1Database,
	id: string,
	status: string,
	expectedUnits: string,
	receivedUnits: string,
	now: number,
) {
	return [
		db
			.prepare(
				`INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals,
				  payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at)
				 VALUES (?, ?, ?, '100', 'USD', 2, 'asset-usdt', ?, ?, 0, ?, ?)`,
			)
			.bind(
				id,
				`merchant-${id}`,
				status,
				receivedUnits,
				now + 900_000,
				now,
				now,
			),
		db
			.prepare(
				`INSERT INTO order_payment_snapshots (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
				  asset_id, asset_code, decimals, target_value, connection_id, adapter, required_confirmations, expected_amount_units, created_at)
				 VALUES (?, 'method-eth', 'Primary USDT', 'ethereum', 'chain', 'asset-usdt', 'USDT', 6, ?, 'connection-primary', 'evm', 2, ?, ?)`,
			)
			.bind(id, target, expectedUnits, now),
	];
}
