import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations } from "./migrations";

describe("local D1 rows-read fixtures", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-rows-read-fixture" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db.batch(
			Array.from({ length: 100 }, (_, index) =>
				db
					.prepare(
						`INSERT INTO orders
						 (id, external_order_id, status, amount_minor, currency,
						  currency_decimals, received_amount_units, expires_at, created_at, updated_at)
						 VALUES (?, ?, ?, '100', 'USD', 2, '0', ?, ?, ?)`,
					)
					.bind(
						`rows-order-${index.toString().padStart(3, "0")}`,
						`ROWS-${index.toString().padStart(3, "0")}`,
						index < 60 ? "pending" : "paid",
						200_000 + index,
						100_000 + index,
						100_000 + index,
					),
			),
		);
	});

	afterAll(async () => miniflare.dispose());

	it("bounds default count and page rows read on a fixed 100-row fixture", async () => {
		const count = await db
			.prepare("SELECT COUNT(*) AS total FROM orders")
			.all<{ total: number }>();
		const page = await db
			.prepare(
				"SELECT id FROM orders ORDER BY created_at DESC, id DESC LIMIT 10",
			)
			.all<{ id: string }>();

		expect(count.results).toEqual([{ total: 100 }]);
		expect(page.results).toHaveLength(10);
		expect(count.meta.rows_read).toBe(100);
		expect(page.meta.rows_read).toBe(10);
	});

	it("uses covering and created-at indexes without a temporary sort", async () => {
		const countPlan = await explain(db, "SELECT COUNT(*) FROM orders");
		const pagePlan = await explain(
			db,
			"SELECT id FROM orders ORDER BY created_at DESC, id DESC LIMIT 10",
		);

		expect(countPlan).toContain("USING COVERING INDEX");
		expect(pagePlan).toContain("orders_created_at_idx");
		expect(pagePlan).not.toContain("USE TEMP B-TREE");
	});
});

describe("maintenance hot-query rows read", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-maintenance-rows-read" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seedMaintenanceRows(db);
	});

	afterAll(async () => miniflare.dispose());

	it("reduces expiration candidates from the status baseline to the bounded result", async () => {
		const baseline = await db
			.prepare(
				`SELECT id FROM orders INDEXED BY orders_status_idx
				 WHERE status IN ('pending', 'confirming', 'partially_paid')
				 AND expires_at <= 100
				 ORDER BY expires_at, id LIMIT 10`,
			)
			.all<{ id: string }>();
		const optimized = await db
			.prepare(
				`SELECT id FROM orders INDEXED BY orders_expiration_idx
				 WHERE status IN ('pending', 'confirming', 'partially_paid')
				 AND expires_at <= 100
				 ORDER BY expires_at, id LIMIT 10`,
			)
			.all<{ id: string }>();

		expect(optimized.results).toEqual(baseline.results);
		expect(baseline.meta.rows_read).toBeGreaterThanOrEqual(1_000);
		expect(optimized.meta.rows_read).toBeLessThanOrEqual(10);
	});

	it("excludes terminal order history from the payment-scan index", async () => {
		const query = (indexName: string) =>
			db
				.prepare(
					`SELECT id FROM orders INDEXED BY ${indexName}
					 WHERE status IN ('pending', 'confirming', 'partially_paid', 'paid', 'overpaid', 'expired')
					 AND ((status IN ('pending', 'confirming', 'partially_paid') AND expires_at > 0)
					  OR (status IN ('paid', 'overpaid') AND paid_at >= 0)
					  OR (status = 'expired' AND updated_at >= 0))
					 ORDER BY last_payment_scan_at, created_at, id LIMIT 10`,
				)
				.all<{ id: string }>();
		const baseline = await query("baseline_orders_payment_scan_idx");
		const optimized = await query("orders_payment_scan_idx");

		expect(optimized.results).toEqual(baseline.results);
		expect(baseline.meta.rows_read).toBeGreaterThanOrEqual(1_000);
		expect(optimized.meta.rows_read).toBeLessThanOrEqual(11);
	});

	it("excludes terminal deliveries from ordered outbox recovery", async () => {
		// Pending migration: the partial outbox index covers every non-terminal row.
		const query = (indexName: string) =>
			db
				.prepare(
					`SELECT id FROM webhook_deliveries INDEXED BY ${indexName}
					 WHERE status IN ('queued', 'failed', 'delivering')
					 AND (next_attempt_at IS NULL OR next_attempt_at <= 100)
					 ORDER BY created_at, id LIMIT 10`,
				)
				.all<{ id: string }>();
		const baseline = await query("baseline_webhook_deliveries_outbox_idx");
		const optimized = await query("webhook_deliveries_outbox_idx");

		expect(optimized.results).toEqual(baseline.results);
		expect(baseline.meta.rows_read).toBeGreaterThanOrEqual(1_000);
		expect(optimized.meta.rows_read).toBeLessThanOrEqual(10);
	});

	it("skips disabled connections while preserving health-check priority", async () => {
		const query = (indexName: string) =>
			db
				.prepare(
					`SELECT pc.id FROM payment_ingresses pc INDEXED BY ${indexName}
					 JOIN payment_rails pr ON pr.code = pc.rail_code
					 WHERE pc.enabled = 1 AND pr.kind = 'chain'
					 AND (pc.last_checked_at IS NULL OR pc.last_checked_at <= 100)
					 ORDER BY pc.last_checked_at IS NOT NULL, pc.last_checked_at,
					 pc.priority, pc.id LIMIT 10`,
				)
				.all<{ id: string }>();
		const baseline = await query("baseline_payment_ingresses_health_idx");
		const optimized = await query("payment_ingresses_health_due_idx");

		expect(optimized.results).toEqual(baseline.results);
		expect(baseline.meta.rows_read).toBeGreaterThanOrEqual(1_000);
		expect(optimized.meta.rows_read).toBeLessThanOrEqual(20);
	});

	it("runs PRAGMA optimize after the index migration", async () => {
		await expect(db.prepare("PRAGMA optimize").run()).resolves.toMatchObject({
			success: true,
		});
	});
});

async function seedMaintenanceRows(db: D1Database) {
	await db.batch([
		db.prepare(
			"CREATE INDEX baseline_orders_payment_scan_idx ON orders (last_payment_scan_at, created_at, id)",
		),
		db.prepare(
			`CREATE INDEX baseline_webhook_deliveries_outbox_idx
			 ON webhook_deliveries (created_at, id)`,
		),
		db.prepare(
			`CREATE INDEX baseline_payment_ingresses_health_idx
			 ON payment_ingresses
			 (last_checked_at IS NOT NULL, last_checked_at, priority, id)`,
		),
		db.prepare(
			`INSERT INTO api_keys
			 (id, name, pid, secret_encrypted, scopes, enabled, created_at, updated_at)
			 VALUES ('rows-api-key', 'Rows fixture', 'rows-pid', 'encrypted', '[]', 1, 0, 0)`,
		),
		db.prepare(
			`INSERT INTO orders
			 (id, external_order_id, api_key_id, status, amount_minor, currency,
			  currency_decimals, received_amount_units, expires_at, created_at, updated_at)
			 VALUES ('rows-webhook-order', 'ROWS-WEBHOOK', 'rows-api-key', 'paid',
			  '100', 'USD', 2, '100', 10, 0, 0)`,
		),
	]);
	await db.batch([
		db.prepare(
			`INSERT INTO payment_rails
			 (code, name, kind, adapter, created_at, updated_at)
			 VALUES ('rows-chain', 'Rows chain', 'chain', 'evm', 0, 0)`,
		),
		db.prepare(
			`INSERT INTO payment_assets
			 (id, rail_code, code, symbol, kind, decimals, default_confirmations, created_at, updated_at)
			 VALUES ('rows-asset', 'rows-chain', 'ROWS', 'ROWS', 'native', 18, 1, 0, 0)`,
		),
	]);
	await db
		.prepare(
			`WITH RECURSIVE sequence(value) AS (
			 SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 1010
			)
			INSERT INTO payment_ingresses
			 (id, rail_code, name, type, transport, priority, enabled,
			  health_status, created_at, updated_at)
			SELECT 'rows-connection-' || value, 'rows-chain', 'Rows ' || value,
			 'rpc', 'http', value, CASE WHEN value <= 1000 THEN 0 ELSE 1 END,
			 'unknown', value, value FROM sequence`,
		)
		.run();
	await db
		.prepare(
			`WITH RECURSIVE sequence(value) AS (
			 SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 1000
			)
			INSERT INTO orders
			 (id, external_order_id, status, amount_minor, currency,
			  currency_decimals, received_amount_units, expires_at, created_at, updated_at)
			SELECT 'rows-cancelled-' || value, 'ROWS-CANCELLED-' || value, 'cancelled',
			 '100', 'USD', 2, '0', 10, value, value FROM sequence`,
		)
		.run();
	await db
		.prepare(
			`WITH RECURSIVE sequence(value) AS (
			 SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 10
			)
			INSERT INTO orders
			 (id, external_order_id, status, amount_minor, currency,
			  currency_decimals, received_amount_units, expires_at, created_at, updated_at)
			SELECT 'rows-due-' || value, 'ROWS-DUE-' || value, 'pending',
			 '100', 'USD', 2, '0', value, 2000 + value, 2000 + value FROM sequence`,
		)
		.run();
	await db
		.prepare(
			`WITH RECURSIVE sequence(value) AS (
			 SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 1000
			)
			INSERT INTO orders
			 (id, external_order_id, status, amount_minor, currency,
			  currency_decimals, received_amount_units, expires_at, created_at, updated_at)
			SELECT 'rows-future-' || value, 'ROWS-FUTURE-' || value, 'pending',
			 '100', 'USD', 2, '0', 10000 + value, 3000 + value, 3000 + value FROM sequence`,
		)
		.run();
	await db
		.prepare(
			`WITH RECURSIVE sequence(value) AS (
			 SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 1010
			)
			INSERT INTO webhook_events
			 (id, order_id, type, deduplication_key, payload, created_at, updated_at)
			SELECT 'rows-event-' || value, 'rows-webhook-order', 'order.paid',
			 'rows-event-' || value, '{}', value, value FROM sequence`,
		)
		.run();
	await db
		.prepare(
			`WITH RECURSIVE sequence(value) AS (
			 SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 1010
			)
			INSERT INTO webhook_deliveries
			 (id, event_id, order_id, api_key_id, status, attempt_count, completed_at, created_at, updated_at)
			SELECT 'rows-delivery-' || value, 'rows-event-' || value,
			 'rows-webhook-order', 'rows-api-key',
			 CASE WHEN value <= 1000 THEN 'succeeded' ELSE 'queued' END,
			 CASE WHEN value <= 1000 THEN 1 ELSE 0 END,
			 CASE WHEN value <= 1000 THEN value ELSE NULL END, value, value FROM sequence`,
		)
		.run();
}

async function explain(db: D1Database, query: string) {
	const result = await db
		.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.all<{ detail: string }>();
	return result.results.map((row) => row.detail).join("\n");
}
