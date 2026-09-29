import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("hot list query plans", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-query-plans" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
	});

	afterAll(async () => miniflare.dispose());

	it("uses the order created-at index without a temporary sort", async () => {
		const details = await explain(
			db,
			`SELECT o.id,
				COALESCE((SELECT MAX(op.confirmations) FROM order_payments op
					WHERE op.order_id = o.id), 0) AS confirmations
			 FROM orders o
			 LEFT JOIN payment_assets a ON a.id = o.payment_asset_id
			 LEFT JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 LEFT JOIN payment_rails pr ON pr.code = COALESCE(ops.rail_code, a.rail_code)
			 ORDER BY o.created_at DESC, o.id DESC LIMIT 500`,
		);

		expect(details).toContain("SCAN o USING INDEX orders_created_at_idx");
		expect(details).toContain(
			"SEARCH op USING INDEX order_payments_order_idx (order_id=?)",
		);
		expect(details).not.toContain("USE TEMP B-TREE");
	});

	it("uses the payment detected-at index without a temporary sort", async () => {
		const details = await explain(
			db,
			`SELECT op.id, op.detected_at
			 FROM order_payments op
			 JOIN orders o ON o.id = op.order_id
			 JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 ORDER BY op.detected_at DESC, op.id DESC LIMIT 500`,
		);

		expect(details).toContain(
			"SCAN op USING INDEX order_payments_detected_at_idx",
		);
		expect(details).not.toContain("USE TEMP B-TREE");
	});

	it("uses stable indexes for review, webhook, audit, and scan lists", async () => {
		const review = await explain(
			db,
			`SELECT pr.id
			 FROM payment_reviews pr INDEXED BY payment_reviews_list_idx
			 CROSS JOIN orders o ON o.id = pr.order_id
			 CROSS JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 ORDER BY CASE pr.status WHEN 'pending' THEN 0 ELSE 1 END,
			 pr.created_at DESC, pr.id DESC LIMIT 10`,
		);
		const webhook = await explain(
			db,
			`SELECT d.id
			 FROM webhook_deliveries d INDEXED BY webhook_deliveries_created_idx
			 CROSS JOIN webhook_events e ON e.id = d.event_id
			 CROSS JOIN orders o ON o.id = d.order_id
			 ORDER BY d.created_at DESC, d.id DESC LIMIT 10`,
		);
		const audit = await explain(
			db,
			`SELECT al.id FROM audit_logs al
			 ORDER BY al.created_at DESC, al.id DESC LIMIT 25`,
		);
		const scans = await explain(
			db,
			`SELECT o.id
			 FROM orders o INDEXED BY orders_payment_scan_idx
			 CROSS JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 WHERE o.status IN ('pending','confirming','partially_paid','paid','overpaid','expired')
			 AND ((o.status IN ('pending','confirming','partially_paid') AND o.expires_at > 0)
			  OR (o.status IN ('paid','overpaid') AND o.paid_at >= 0)
			  OR (o.status = 'expired' AND o.updated_at >= 0))
			 ORDER BY o.last_payment_scan_at, o.created_at, o.id LIMIT 100`,
		);

		expect(review).toContain("SCAN pr USING INDEX payment_reviews_list_idx");
		expect(webhook).toContain(
			"SCAN d USING INDEX webhook_deliveries_created_idx",
		);
		expect(audit).toContain(
			"SCAN al USING COVERING INDEX audit_logs_created_idx",
		);
		expect(scans).toContain("SCAN o USING INDEX orders_payment_scan_idx");
		for (const details of [review, webhook, audit, scans])
			expect(details).not.toContain("USE TEMP B-TREE");
	});

	it("scans only non-terminal webhook outbox rows in delivery order", async () => {
		// Pending migration: webhook_deliveries_outbox_idx becomes
		// (created_at, id, status, next_attempt_at) WHERE status IN ('queued', 'failed', 'delivering').
		const sweep = await explain(
			db,
			`SELECT id, event_id, status, attempt_count, created_at FROM webhook_deliveries
			 WHERE status IN ('queued', 'failed', 'delivering')
			 AND (next_attempt_at IS NULL OR next_attempt_at <= 0)
			 ORDER BY created_at, id LIMIT 100`,
		);
		const probe = await explain(
			db,
			`SELECT EXISTS(SELECT 1 FROM webhook_deliveries
			 WHERE status IN ('queued', 'failed', 'delivering')
			 AND (next_attempt_at IS NULL OR next_attempt_at <= 0) LIMIT 1) AS due`,
		);
		const counts = await explain(
			db,
			`SELECT COALESCE(SUM(status = 'queued'), 0) AS queued,
			 COALESCE(SUM(status = 'delivering'), 0) AS delivering,
			 COALESCE(SUM(status = 'failed'), 0) AS failed
			 FROM webhook_deliveries WHERE status IN ('queued', 'failed', 'delivering')`,
		);

		expect(sweep).toContain(
			"SCAN webhook_deliveries USING INDEX webhook_deliveries_outbox_idx",
		);
		expect(sweep).not.toContain("USE TEMP B-TREE");
		expect(probe).toContain(
			"SCAN webhook_deliveries USING COVERING INDEX webhook_deliveries_outbox_idx",
		);
		expect(counts).toContain(
			"SCAN webhook_deliveries USING COVERING INDEX webhook_deliveries_outbox_idx",
		);
	});

	it("checks webhook foreign keys by index when an order allocation is rolled back", async () => {
		// Pending migration: webhook_events_order_idx and webhook_deliveries_order_idx.
		const details = await explain(
			db,
			`DELETE FROM orders WHERE id = 'order'
			 AND NOT EXISTS (SELECT 1 FROM order_payment_snapshots WHERE order_id = 'order')`,
		);

		expect(details).toContain(
			"SEARCH webhook_events USING COVERING INDEX webhook_events_order_idx (order_id=?)",
		);
		expect(details).toContain(
			"SEARCH webhook_deliveries USING COVERING INDEX webhook_deliveries_order_idx (order_id=?)",
		);
		expect(details).not.toContain("SCAN webhook_events");
		expect(details).not.toContain("SCAN webhook_deliveries");
	});

	it("seeks expirable orders by expiry without a temporary sort", async () => {
		const details = await explain(
			db,
			`SELECT o.id FROM orders o INDEXED BY orders_expiration_idx
			 WHERE o.status IN ('pending', 'confirming', 'partially_paid')
			 AND o.expires_at <= 0
			 ORDER BY o.expires_at, o.id LIMIT 100`,
		);

		expect(details).toContain(
			"SEARCH o USING INDEX orders_expiration_idx (expires_at<?)",
		);
		expect(details).not.toContain("USE TEMP B-TREE");
	});

	it("orders due health checks with the enabled-connection expression index", async () => {
		const details = await explain(
			db,
			`SELECT pc.id FROM payment_ingresses pc
			 JOIN payment_rails pr ON pr.code = pc.rail_code
			 WHERE pc.enabled = 1 AND pr.kind = 'chain'
			 AND (pc.last_checked_at IS NULL OR pc.last_checked_at <= 0)
			 ORDER BY pc.last_checked_at IS NOT NULL, pc.last_checked_at,
			 pc.priority, pc.id LIMIT 20`,
		);

		expect(details).toContain(
			"SCAN pc USING INDEX payment_ingresses_health_due_idx",
		);
		expect(details).not.toContain("USE TEMP B-TREE");
	});

	it("uses bounded indexes for provider event recovery and address matching", async () => {
		const outbox = await explain(
			db,
			`SELECT id FROM inbound_provider_events INDEXED BY inbound_provider_events_outbox_idx
			 WHERE status IN ('received','failed')
			 AND (next_attempt_at IS NULL OR next_attempt_at <= 0)
			 ORDER BY status, next_attempt_at, received_at, id LIMIT 100`,
		);
		const leases = await explain(
			db,
			`SELECT id FROM inbound_provider_events INDEXED BY inbound_provider_events_lease_idx
			 WHERE status = 'processing' AND lease_until <= 0
			 ORDER BY lease_until, id LIMIT 100`,
		);
		const sources = await explain(
			db,
			`SELECT id FROM payment_ingresses INDEXED BY payment_ingresses_reconcile_idx
			 WHERE reconcile_required_at IS NOT NULL
			 ORDER BY reconcile_required_at, id LIMIT 4`,
		);
		const evmTarget = await explain(
			db,
			`SELECT order_id FROM order_payment_snapshots
			 WHERE rail_code = 'ethereum' AND asset_code = 'USDC'
			 AND LOWER(target_value) = LOWER('0x1111111111111111111111111111111111111111')
			 LIMIT 101`,
		);
		const strictTarget = await explain(
			db,
			`SELECT order_id FROM order_payment_snapshots
			 WHERE rail_code = 'tron' AND asset_code = 'USDT'
				 AND target_value = 'TTarget' LIMIT 101`,
		);
		const recentEvents = await explain(
			db,
			`SELECT id FROM inbound_provider_events
			 INDEXED BY inbound_provider_events_source_received_idx
			 WHERE source_id = 'source-id'
				 ORDER BY received_at DESC, id DESC LIMIT 1000`,
		);
		const providerEvents = await explain(
			db,
			`SELECT event.id FROM inbound_provider_events event
			 INDEXED BY inbound_provider_events_received_idx
			 JOIN payment_ingresses source ON source.id = event.source_id
			 ORDER BY event.received_at DESC, event.id DESC LIMIT 10`,
		);
		const retainedEvents = await explain(
			db,
			`SELECT id FROM inbound_provider_events
			 INDEXED BY inbound_provider_events_retention_idx
			 WHERE status IN ('succeeded', 'ignored', 'ambiguous', 'dead')
				 AND processed_at < 0 ORDER BY processed_at, id LIMIT 500`,
		);
		const retainedDeliveries = await explain(
			db,
			`SELECT delivery.id FROM inbound_provider_deliveries delivery
			 INDEXED BY inbound_provider_deliveries_retention_idx
			 WHERE delivery.received_at < 0 AND NOT EXISTS (
			  SELECT 1 FROM inbound_provider_events event
			  WHERE event.source_id = delivery.source_id
			  AND event.provider_event_id = delivery.provider_event_id
			 ) ORDER BY delivery.received_at, delivery.id LIMIT 500`,
		);
		const retainedReceipts = await explain(
			db,
			`SELECT id FROM inbound_webhook_receipts
			 INDEXED BY inbound_webhook_receipts_retention_idx
			 WHERE received_at < 0 ORDER BY received_at, id LIMIT 500`,
		);

		expect(outbox).toContain("inbound_provider_events_outbox_idx");
		expect(leases).toContain("inbound_provider_events_lease_idx");
		expect(sources).toContain("payment_ingresses_reconcile_idx");
		expect(evmTarget).toContain("order_payment_snapshots_target_nocase_idx");
		expect(strictTarget).toContain("order_payment_snapshots_target_idx");
		expect(recentEvents).toContain(
			"inbound_provider_events_source_received_idx",
		);
		expect(providerEvents).toContain("inbound_provider_events_received_idx");
		expect(retainedEvents).toContain("inbound_provider_events_retention_idx");
		expect(retainedDeliveries).toContain(
			"inbound_provider_deliveries_retention_idx",
		);
		expect(retainedReceipts).toContain(
			"inbound_webhook_receipts_retention_idx",
		);
		for (const details of [
			outbox,
			leases,
			sources,
			evmTarget,
			strictTarget,
			recentEvents,
			providerEvents,
			retainedEvents,
			retainedDeliveries,
			retainedReceipts,
		])
			expect(details).not.toContain("USE TEMP B-TREE");
	});

	it("keeps order pagination stable and applies the same filter to count", async () => {
		const now = Date.now();
		await db.batch(
			["a", "b", "c"].map((suffix, index) =>
				db
					.prepare(
						`INSERT INTO orders
						(id, external_order_id, status, amount_minor, currency,
						 currency_decimals, received_amount_units, expires_at, created_at, updated_at)
						VALUES (?, ?, 'pending', '100', 'USD', 2, '0', ?, ?, ?)`,
					)
					.bind(
						`pagination-${suffix}`,
						`PAGE-${suffix.toUpperCase()}`,
						now + 60_000,
						now - index,
						now - index,
					),
			),
		);

		const count = await db
			.prepare(
				"SELECT COUNT(*) AS total FROM orders WHERE external_order_id LIKE ?",
			)
			.bind("%PAGE-%")
			.first<{ total: number }>();
		const page = await db
			.prepare(
				`SELECT id FROM orders
				 WHERE external_order_id LIKE ?
				 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
			)
			.bind("%PAGE-%", 2, 0)
			.all<{ id: string }>();
		const secondPage = await db
			.prepare(
				`SELECT id FROM orders
				 WHERE external_order_id LIKE ?
				 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
			)
			.bind("%PAGE-%", 2, 2)
			.all<{ id: string }>();

		expect(count?.total).toBe(3);
		expect(page.results).toHaveLength(2);
		expect(secondPage.results).toHaveLength(1);
		expect(new Set(page.results.map((row) => row.id))).not.toContain(
			secondPage.results[0]?.id,
		);
	});

	it("keeps payment pagination stable and applies the same filter to count", async () => {
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					`INSERT OR IGNORE INTO payment_rails
					 (code, name, kind, adapter, created_at, updated_at)
					 VALUES ('pagination-rail', 'Pagination Rail', 'chain', 'tron', ?, ?)`,
				)
				.bind(now, now),
			db
				.prepare(
					`INSERT OR IGNORE INTO payment_assets
					 (id, rail_code, code, symbol, kind, decimals, created_at, updated_at)
					 VALUES ('pagination-asset', 'pagination-rail', 'USDT', 'USDT', 'token', 6, ?, ?)`,
				)
				.bind(now, now),
			db
				.prepare(
					`INSERT OR IGNORE INTO receiving_methods
					 (id, name, rail_code, target_type, target_value, normalized_target_value,
					  enabled, created_at, updated_at)
					 VALUES ('pagination-receiving', 'Pagination Target', 'pagination-rail',
					  'address', 'pagination-address', 'pagination-address', 1, ?, ?)`,
				)
				.bind(now, now),
			db
				.prepare(
					`INSERT OR IGNORE INTO receiving_method_assets
					 (id, receiving_method_id, payment_asset_id, created_at, updated_at)
					 VALUES ('pagination-link', 'pagination-receiving', 'pagination-asset', ?, ?)`,
				)
				.bind(now, now),
		]);
		await db.batch(
			["a", "b", "c"].flatMap((suffix, index) => {
				const orderId = `payment-pagination-order-${suffix}`;
				return [
					db
						.prepare(
							`INSERT INTO orders
							 (id, external_order_id, status, amount_minor, currency, currency_decimals,
							  received_amount_units, expires_at, created_at, updated_at)
							 VALUES (?, ?, 'paid', '100', 'USD', 2, '1000000', ?, ?, ?)`,
						)
						.bind(
							orderId,
							`PAYMENT-PAGE-${suffix.toUpperCase()}`,
							now + 60_000,
							now - index,
							now - index,
						),
					db
						.prepare(
							`INSERT INTO order_payment_snapshots
							 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind, asset_id, asset_code, decimals,
							  target_value, adapter, required_confirmations, expected_amount_units)
							 VALUES (?, 'pagination-receiving', 'Pagination Target', 'pagination-rail', 'chain',
							  'pagination-asset', 'USDT', 6, 'pagination-address', 'tron', 1, '1000000')`,
						)
						.bind(orderId),
					db
						.prepare(
							`INSERT INTO order_payments
							 (id, order_id, transaction_id, amount_units, confirmations, status,
							  detected_at, created_at, updated_at)
							 VALUES (?, ?, ?, '1000000', 1, 'confirmed', ?, ?, ?)`,
						)
						.bind(
							`payment-pagination-${suffix}`,
							orderId,
							`tx-pagination-${suffix}`,
							now - index,
							now - index,
							now - index,
						),
				];
			}),
		);

		const search = "%PAYMENT-PAGE-%";
		const count = await db
			.prepare(
				`SELECT COUNT(*) AS total
				 FROM order_payments op JOIN orders o ON o.id = op.order_id
				 WHERE op.transaction_id LIKE ? OR op.order_id LIKE ? OR o.external_order_id LIKE ?`,
			)
			.bind(search, search, search)
			.first<{ total: number }>();
		const page = await db
			.prepare(
				`SELECT op.id
				 FROM order_payments op JOIN orders o ON o.id = op.order_id
				 WHERE op.transaction_id LIKE ? OR op.order_id LIKE ? OR o.external_order_id LIKE ?
				 ORDER BY op.detected_at DESC, op.id DESC LIMIT ? OFFSET ?`,
			)
			.bind(search, search, search, 2, 2)
			.all<{ id: string }>();

		expect(count?.total).toBe(3);
		expect(page.results).toHaveLength(1);
		expect(page.results[0]?.id).toBe("payment-pagination-c");

		// A new payment arriving after the first page was read must not shift
		// the snapshot used by the next page.
		await db
			.prepare(
				`INSERT INTO order_payments
				 (id, order_id, transaction_id, amount_units, confirmations, status,
				  detected_at, created_at, updated_at)
				 VALUES ('payment-pagination-new', 'payment-pagination-order-a',
				  'tx-pagination-new', '1000000', 1, 'confirmed', ?, ?, ?)`,
			)
			.bind(now + 100, now + 100, now + 100)
			.run();
		const snapshotCount = await db
			.prepare(
				`SELECT COUNT(*) AS total
				 FROM order_payments op JOIN orders o ON o.id = op.order_id
				 WHERE (op.transaction_id LIKE ? OR op.order_id LIKE ? OR o.external_order_id LIKE ?)
				 AND op.detected_at <= ?`,
			)
			.bind(search, search, search, now)
			.first<{ total: number }>();
		expect(snapshotCount?.total).toBe(3);
	});

	it("uses keyset cursors for sequential order and payment history", async () => {
		const orderFirst = await db
			.prepare(
				`SELECT id, created_at FROM orders
				 WHERE external_order_id LIKE 'PAGE-%'
				 ORDER BY created_at DESC, id DESC LIMIT 2`,
			)
			.all<{ id: string; created_at: number }>();
		const orderCursor = orderFirst.results.at(-1);
		expect(orderCursor).toBeTruthy();
		const orderNext = await db
			.prepare(
				`SELECT id FROM orders
				 WHERE external_order_id LIKE 'PAGE-%'
				 AND (created_at < ? OR (created_at = ? AND id < ?))
				 ORDER BY created_at DESC, id DESC LIMIT 2`,
			)
			.bind(orderCursor?.created_at, orderCursor?.created_at, orderCursor?.id)
			.all<{ id: string }>();
		expect(orderNext.results).toEqual([{ id: "pagination-c" }]);
		expect(
			new Set([
				...orderFirst.results.map((row) => row.id),
				...orderNext.results.map((row) => row.id),
			]).size,
		).toBe(3);

		const paymentFirst = await db
			.prepare(
				`SELECT id, detected_at FROM order_payments
				 WHERE id IN ('payment-pagination-a', 'payment-pagination-b', 'payment-pagination-c')
				 ORDER BY detected_at DESC, id DESC LIMIT 2`,
			)
			.all<{ id: string; detected_at: number }>();
		const paymentCursor = paymentFirst.results.at(-1);
		expect(paymentCursor).toBeTruthy();
		const paymentNext = await db
			.prepare(
				`SELECT id FROM order_payments
				 WHERE id IN ('payment-pagination-a', 'payment-pagination-b', 'payment-pagination-c')
				 AND (detected_at < ? OR (detected_at = ? AND id < ?))
				 ORDER BY detected_at DESC, id DESC LIMIT 2`,
			)
			.bind(
				paymentCursor?.detected_at,
				paymentCursor?.detected_at,
				paymentCursor?.id,
			)
			.all<{ id: string }>();
		expect(paymentNext.results).toEqual([{ id: "payment-pagination-c" }]);
		expect(
			new Set([
				...paymentFirst.results.map((row) => row.id),
				...paymentNext.results.map((row) => row.id),
			]).size,
		).toBe(3);
	});

	it("uses the created-at index for Telegram subscriptions", async () => {
		const targets = await explain(
			db,
			`SELECT target.id, target.bot_id, b.name AS bot_name,
			 target.template_translations, target.name,
			 target.target_type, target.target_id, target.locale, target.events,
			 target.enabled, target.created_at
			 FROM telegram_notification_bindings target
			 JOIN telegram_bots b ON b.id = target.bot_id
			 ORDER BY target.created_at DESC, target.id DESC LIMIT 10`,
		);

		expect(targets).toContain(
			"SCAN target USING INDEX telegram_notifications_created_idx",
		);
		expect(targets).not.toContain("USE TEMP B-TREE");
	});

	it("returns Telegram notification targets and exact totals in one batch", async () => {
		const now = Date.now();
		await db
			.prepare(
				`INSERT OR IGNORE INTO telegram_bots
				 (id, name, token_encrypted, webhook_secret_encrypted, created_at, updated_at)
				 VALUES ('target-pagination-bot', 'Target Pagination Bot', 'token', 'secret', ?, ?)`,
			)
			.bind(now, now)
			.run();
		await db.batch(
			["one", "two", "three"].map((suffix, index) =>
				db
					.prepare(
						`INSERT INTO telegram_notification_bindings
						 (id, bot_id, template_translations, name, target_type, target_id, locale, events, enabled,
						  created_at, updated_at)
						 VALUES (?, 'target-pagination-bot', '{}', ?, 'private', ?, 'en-US', '[]', 1, ?, ?)`,
					)
					.bind(
						`target-pagination-${suffix}`,
						`Target ${suffix}`,
						`800${index}`,
						now - index,
						now - index,
					),
			),
		);

		const counters = createDatastoreCounters();
		const measuredDb = instrumentD1(db, counters);
		const search = "%Target%";
		const [countResult, pageResult] = await measuredDb.batch([
			measuredDb
				.prepare(
					`SELECT COUNT(*) AS total
					 FROM telegram_notification_bindings target
					 JOIN telegram_bots b ON b.id = target.bot_id
					 WHERE target.name LIKE ? OR target.target_id LIKE ? OR b.name LIKE ?`,
				)
				.bind(search, search, search),
			measuredDb
				.prepare(
					`SELECT target.id
					 FROM telegram_notification_bindings target
					 JOIN telegram_bots b ON b.id = target.bot_id
					 WHERE target.name LIKE ? OR target.target_id LIKE ? OR b.name LIKE ?
					 ORDER BY target.created_at DESC, target.id DESC LIMIT ? OFFSET ?`,
				)
				.bind(search, search, search, 1, 1),
		]);
		const count = countResult?.results?.[0] as { total: number } | undefined;
		const page = pageResult as D1Result<{ id: string }>;

		expect(count?.total).toBe(3);
		expect(page.results).toEqual([{ id: "target-pagination-two" }]);
		expect(counters.d1Prepare).toBe(2);
		expect(counters.d1Batch).toBe(1);
	});

	it("uses the webhook delivery index for the admin history order", async () => {
		const details = await explain(
			db,
			`SELECT d.id, e.type, o.id AS order_id
			 FROM webhook_deliveries d
			 JOIN webhook_events e ON e.id = d.event_id
			 JOIN orders o ON o.id = d.order_id
			 ORDER BY d.created_at DESC, d.id DESC LIMIT 10`,
		);

		expect(details).toContain(
			"SCAN d USING INDEX webhook_deliveries_created_idx",
		);
		expect(details).not.toContain("USE TEMP B-TREE FOR ORDER BY");
	});

	it("uses the delivery-attempt index for newest-first diagnostics", async () => {
		const details = await explain(
			db,
			`SELECT attempt, request_id, response_status, duration_ms,
			 error_code, response_excerpt, request_snapshot, attempted_at
			 FROM webhook_attempts WHERE delivery_id = 'delivery'
			 ORDER BY attempt DESC`,
		);

		expect(details).toContain(
			"webhook_attempts_delivery_attempt_uidx (delivery_id=?)",
		);
		expect(details).not.toContain("USE TEMP B-TREE FOR ORDER BY");
	});

	it("uses the endpoint receipt index without a temporary sort", async () => {
		const details = await explain(
			db,
			`SELECT id, request_id, method, request_path, signature_status,
			 processing_status, response_status, duration_ms, error_code, received_at
			 FROM inbound_webhook_receipts WHERE endpoint_code = 'endpoint'
			 ORDER BY received_at DESC, id DESC LIMIT 10 OFFSET 10`,
		);

		expect(details).toContain(
			"inbound_webhook_receipts_list_idx (endpoint_code=?)",
		);
		expect(details).not.toContain("USE TEMP B-TREE FOR ORDER BY");
	});
});

async function explain(db: D1Database, query: string) {
	const result = await db
		.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.all<{ detail: string }>();
	return result.results.map((row) => row.detail).join("\n");
}
