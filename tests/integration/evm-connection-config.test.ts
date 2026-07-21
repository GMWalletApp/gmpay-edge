import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPaymentConnectionAdapter } from "#/features/payment-settings/server/method-adapter";
import { EvmAdapter } from "#/integrations/chains/evm";
import { applyMigrations } from "./migrations";

describe("EVM connection scan configuration", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-evm-connection-config" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db.batch([
			db.prepare(
				`INSERT OR IGNORE INTO payment_rails
				 (code, name, kind, adapter, metadata, created_at, updated_at)
				 VALUES ('ethereum', 'Ethereum', 'chain', 'evm', '{"nativeSymbol":"ETH"}', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO payment_assets
				 (id, rail_code, code, symbol, kind, decimals, created_at, updated_at)
				 VALUES ('evm-config-asset', 'ethereum', 'ETH', 'ETH', 'native', 18, 1, 1)`,
			),
			db.prepare(
				`INSERT INTO payment_ingresses
				 (id, rail_code, name, type, transport, endpoint, priority, enabled,
				  health_status, timeout_ms, block_lookback, log_block_range,
				  max_scan_transactions, created_at, updated_at)
				 VALUES ('evm-config-connection', 'ethereum', 'Configured EVM', 'rpc',
				  'http', 'https://rpc.example', 1, 1, 'healthy', 12000, 2400, 240, 120, 1, 1)`,
			),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it("migrates and passes persisted values to the adapter", async () => {
		const columns = await db
			.prepare("PRAGMA table_info(payment_ingresses)")
			.all<{ name: string }>();
		expect(columns.results.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"timeout_ms",
				"block_lookback",
				"log_block_range",
				"max_scan_transactions",
			]),
		);

		const adapter = await createPaymentConnectionAdapter(
			db,
			"evm-config-connection",
		);
		expect(adapter).toBeInstanceOf(EvmAdapter);
		expect((adapter as EvmAdapter).config).toMatchObject({
			timeoutMs: 12_000,
			blockLookback: 2400,
			logBlockRange: 240,
			maxScanTransactions: 120,
		});
	});
});
