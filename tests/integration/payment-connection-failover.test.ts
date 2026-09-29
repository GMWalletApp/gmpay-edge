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
import type { createReceivingMethodAdapters } from "#/features/payment-settings/server/method-adapter";
import { handlePaymentScan } from "#/server/queue";
import { applyMigrations } from "./migrations";

describe("payment connection failover", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-connection-failover" },
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

	it("tries the next enabled connection and updates health without failing the order", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				calls.push(url);
				if (url.includes("primary"))
					return new Response("offline", { status: 503 });
				const request = JSON.parse(String(init?.body)) as { method: string };
				if (request.method === "eth_blockNumber") return rpc("0xa");
				if (request.method === "eth_getBlockByNumber")
					return rpc({
						hash: "0xblock",
						number: "0xa",
						timestamp: "0x6553f100",
						transactions: [],
					});
				throw new Error(`Unexpected RPC method ${request.method}`);
			}),
		);
		let acknowledged = false;
		let retried = false;
		await handlePaymentScan(
			{
				body: {
					kind: "payment.scan",
					version: 1,
					receivingMethodId: "asset-eth",
					orderId: "order-eth",
				},
				ack: () => {
					acknowledged = true;
				},
				retry: () => {
					retried = true;
				},
			} as unknown as Message<
				import("#/features/payments/types").PaymentScanMessage
			>,
			{ DB: db } as Env,
		);
		expect({ acknowledged, retried }).toEqual({
			acknowledged: true,
			retried: false,
		});
		expect(calls[0]).toBe("https://primary.example");
		expect(calls.slice(1)).not.toHaveLength(0);
		expect(
			calls.slice(1).every((url) => url === "https://fallback.example"),
		).toBe(true);
		const health = await db
			.prepare(
				"SELECT id, health_status, last_error_code FROM payment_ingresses ORDER BY priority",
			)
			.all<{
				id: string;
				health_status: string;
				last_error_code: string | null;
			}>();
		expect(health.results).toEqual([
			{
				id: "connection-primary",
				health_status: "unhealthy",
				last_error_code: "network",
			},
			{
				id: "connection-fallback",
				health_status: "healthy",
				last_error_code: null,
			},
		]);
		const order = await db
			.prepare("SELECT status FROM orders WHERE id = 'order-eth'")
			.first<{ status: string }>();
		expect(order?.status).toBe("pending");
		const metrics = info.mock.calls
			.map(([record]) => record)
			.filter(
				(record): record is Record<string, unknown> =>
					typeof record === "object" &&
					record !== null &&
					record.event === "provider_operation" &&
					record.operation === "payment_scan",
			);
		expect(metrics).toEqual([
			expect.objectContaining({
				adapter: "evm",
				outcome: "failure",
				errorCode: "network",
				failoverCount: 1,
			}),
			expect.objectContaining({
				adapter: "evm",
				outcome: "success",
				status: "empty",
				failoverCount: 1,
			}),
		]);
	});

	it("does not attribute a downstream D1 failure to the provider or fail over", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		await db
			.prepare(
				"UPDATE payment_ingresses SET health_status = 'healthy', last_error_code = NULL",
			)
			.run();
		await db
			.prepare(
				`CREATE TRIGGER reject_healthy_connection_update
			 BEFORE UPDATE OF health_status ON payment_ingresses
			 WHEN NEW.health_status = 'healthy'
			 BEGIN SELECT RAISE(FAIL, 'simulated downstream D1 failure'); END`,
			)
			.run();
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				calls.push(String(input));
				const request = JSON.parse(String(init?.body)) as { method: string };
				if (request.method === "eth_blockNumber") return rpc("0xa");
				if (request.method === "eth_getBlockByNumber")
					return rpc({
						hash: "0xblock",
						number: "0xa",
						timestamp: "0x6553f100",
						transactions: [],
					});
				throw new Error(`Unexpected RPC method ${request.method}`);
			}),
		);
		try {
			await expect(
				handlePaymentScan(
					{
						body: {
							kind: "payment.scan",
							version: 1,
							receivingMethodId: "asset-eth",
							orderId: "order-eth",
						},
						ack: vi.fn(),
						retry: vi.fn(),
					} as unknown as Message<
						import("#/features/payments/types").PaymentScanMessage
					>,
					{ DB: db } as Env,
				),
			).rejects.toThrow("simulated downstream D1 failure");
		} finally {
			await db.prepare("DROP TRIGGER reject_healthy_connection_update").run();
		}

		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((url) => url === "https://primary.example")).toBe(true);
		const metrics = info.mock.calls
			.map(([record]) => record)
			.filter(
				(record): record is Record<string, unknown> =>
					typeof record === "object" &&
					record !== null &&
					record.event === "provider_operation" &&
					record.operation === "payment_scan",
			);
		expect(metrics).toEqual([
			expect.objectContaining({
				adapter: "evm",
				outcome: "success",
				failoverCount: 0,
			}),
		]);
	});

	it.each([
		{ firstAsset: "USDT", paidAsset: "USDT" },
		{ firstAsset: "USDT", paidAsset: "ETH" },
		{ firstAsset: "ETH", paidAsset: "USDT" },
	])(
		"keeps $paidAsset payments isolated when scanning $firstAsset first with a shared cache",
		async ({ firstAsset, paidAsset }) => {
			const multiAssetRuntime = new Miniflare({
				modules: true,
				script: "export default { fetch() { return new Response('ok') } }",
				d1Databases: { DB: "multi-asset-scan" },
			});
			try {
				const db = await multiAssetRuntime.getD1Database("DB");
				await applyMigrations(db);
				await seed(db);
				const target = "0x1111111111111111111111111111111111111111";
				const contract = "0xdac17f958d2ee523a2206206994597c13d831ec7";
				await db.batch([
					db
						.prepare(
							"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, contract_address, decimals, created_at, updated_at) VALUES ('asset-usdt', 'ethereum', 'USDT', 'USDT', 'token', ?, 6, 1, 1)",
						)
						.bind(contract),
					db.prepare(
						"INSERT INTO receiving_method_assets (id, receiving_method_id, payment_asset_id, created_at, updated_at) VALUES ('link-usdt', 'asset-eth', 'asset-usdt', 1, 1)",
					),
					db.prepare(`INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at)
			 VALUES ('order-usdt', 'merchant-usdt', 'pending', '100', 'USD', 2, 'asset-usdt', '0', 9999999999999, 0, 1, 1)`),
					db
						.prepare(`INSERT INTO order_payment_snapshots (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind, asset_id, asset_code, decimals, target_value, connection_id, adapter, required_confirmations, expected_amount_units, created_at)
			 VALUES ('order-usdt', 'asset-eth', 'Primary ETH', 'ethereum', 'chain', 'asset-usdt', 'USDT', 6, ?, 'connection-primary', 'evm', 2, '1000000', 1)`)
						.bind(target),
				]);
				expect(
					(
						await db
							.prepare(
								"SELECT payment_asset_id FROM receiving_method_assets WHERE receiving_method_id = 'asset-eth' ORDER BY payment_asset_id",
							)
							.all()
					).results,
				).toEqual([
					{ payment_asset_id: "asset-eth" },
					{ payment_asset_id: "asset-usdt" },
				]);
				const methods: string[] = [];
				vi.spyOn(console, "info").mockImplementation(() => undefined);
				vi.stubGlobal(
					"fetch",
					vi.fn(async (_input: unknown, init?: RequestInit) => {
						const request = JSON.parse(String(init?.body)) as {
							method: string;
							params: Array<{ address?: string }>;
						};
						methods.push(request.method);
						if (request.method === "eth_blockNumber") return rpc("0xa");
						if (request.method === "eth_getLogs") {
							expect(request.params[0]?.address).toBe(contract);
							if (paidAsset !== "USDT") return rpc([]);
							return rpc([
								{
									address: contract,
									blockHash: "0xblock",
									blockNumber: "0x9",
									data: "0xf4240",
									logIndex: "0x0",
									removed: false,
									topics: [
										"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
										`0x${"2".repeat(64)}`,
										`0x${target.slice(2).padStart(64, "0")}`,
									],
									transactionHash: "0xmultiasset",
								},
							]);
						}
						if (
							["eth_getBlockByNumber", "eth_getBlockByHash"].includes(
								request.method,
							)
						)
							return rpc({
								hash: "0xblock",
								number: "0x9",
								timestamp: "0x6553f100",
								transactions:
									paidAsset === "ETH"
										? [
												{
													blockHash: "0xblock",
													blockNumber: "0x9",
													from: `0x${"2".repeat(40)}`,
													hash: "0xmultiasset-native",
													to: target,
													value: "0xde0b6b3a7640000",
												},
											]
										: [],
							});
						if (request.method === "eth_getTransactionReceipt")
							return rpc({
								blockHash: "0xblock",
								blockNumber: "0x9",
								logs: [],
								status: "0x1",
								transactionHash: "0xmultiasset-native",
							});
						throw new Error(`Unexpected RPC method ${request.method}`);
					}),
				);
				const cache = new Map<
					string,
					ReturnType<typeof createReceivingMethodAdapters>
				>();
				const orderIds =
					firstAsset === "USDT"
						? ["order-usdt", "order-eth"]
						: ["order-eth", "order-usdt"];
				for (const orderId of orderIds) {
					const start = methods.length;
					const ack = vi.fn();
					const retry = vi.fn();
					await handlePaymentScan(
						{
							body: {
								kind: "payment.scan",
								version: 1,
								receivingMethodId: "asset-eth",
								orderId,
							},
							ack,
							retry,
						} as unknown as Parameters<typeof handlePaymentScan>[0],
						{ DB: db, WEBHOOK_QUEUE: { send: vi.fn() } } as unknown as Env,
						undefined,
						cache,
					);
					expect(ack).toHaveBeenCalledOnce();
					expect(retry).not.toHaveBeenCalled();
					if (orderId === "order-usdt")
						expect(methods.slice(start)).toContain("eth_getLogs");
					else expect(methods.slice(start)).not.toContain("eth_getLogs");
				}
				expect(cache.size).toBe(2);
				const orders = await db
					.prepare(
						"SELECT id, status, received_amount_units FROM orders ORDER BY id",
					)
					.all();
				expect(orders.results).toEqual([
					{
						id: "order-eth",
						status: paidAsset === "ETH" ? "paid" : "pending",
						received_amount_units:
							paidAsset === "ETH" ? "1000000000000000000" : "0",
					},
					{
						id: "order-usdt",
						status: paidAsset === "USDT" ? "paid" : "pending",
						received_amount_units: paidAsset === "USDT" ? "1000000" : "0",
					},
				]);
			} finally {
				await multiAssetRuntime.dispose();
			}
		},
	);
});

async function seed(db: D1Database) {
	await db.batch([
		db.prepare(
			"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('ethereum', 'Ethereum', 'chain', 'evm', 1, 1)",
		),
		db.prepare(
			"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('asset-eth', 'ethereum', 'ETH', 'ETH', 'native', 18, 1, 1)",
		),
		db.prepare(
			`INSERT OR IGNORE INTO payment_rails
			 (code, name, kind, adapter, metadata, created_at, updated_at)
			 VALUES ('ethereum', 'Ethereum', 'chain', 'evm', '{"nativeSymbol":"ETH"}', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO payment_ingresses
			 (id, rail_code, name, type, endpoint, priority, enabled, health_status, created_at, updated_at)
			 VALUES
			 ('connection-primary', 'ethereum', 'Primary', 'rpc', 'https://primary.example', 1, 1, 'healthy', 1, 1),
			 ('connection-fallback', 'ethereum', 'Fallback', 'rpc', 'https://fallback.example', 2, 1, 'healthy', 1, 1)`,
		),
		db.prepare(
			"UPDATE payment_assets SET default_confirmations = 2, created_at = 1, updated_at = 1 WHERE id = 'asset-eth'",
		),
		db.prepare(
			"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('asset-eth', 'Primary ETH', 'ethereum', 'address', '0x1111111111111111111111111111111111111111', '0x1111111111111111111111111111111111111111', 1, 1, 1)",
		),
		db.prepare(
			`INSERT INTO orders
			 (id, external_order_id, status, amount_minor, currency, currency_decimals,
			  payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at)
			 VALUES ('order-eth', 'merchant-eth', 'pending', '1', 'ETH', '1',
			 'asset-eth', '0', 9999999999999, 0, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO order_payment_snapshots
			 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
			 asset_id, asset_code, decimals, target_value, connection_id, adapter,
			 required_confirmations, expected_amount_units, created_at)
			 VALUES ('order-eth', 'asset-eth', 'Primary ETH', 'ethereum', 'chain',
			 'asset-eth', 'ETH', 18, '0x1111111111111111111111111111111111111111',
			 'connection-primary', 'evm', 2, '1000000000000000000', 1)`,
		),
	]);
}

function rpc(result: unknown) {
	return Response.json({ jsonrpc: "2.0", id: 1, result });
}
