import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	loadDeadQueueMessageCounts,
	retryQueueWorkload,
} from "#/features/operations/server/retry-queue";
import { applyMigrations } from "./migrations";

describe("safe manual Queue retry", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-manual-queue-retry" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it("requeues only active snapshotted payments and audits counts", async () => {
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		await expect(
			retryQueueWorkload(
				{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
				"payment",
				{
					actorUserId: "actor",
					requestId: "retry-request",
					ipAddress: "203.0.113.9",
					now: 100,
				},
			),
		).resolves.toEqual({ queued: 1 });
		expect(sendBatch).toHaveBeenCalledWith([
			{
				body: {
					kind: "payment.scan",
					version: 1,
					orderId: "active-order",
					receivingMethodId: "receiving",
				},
			},
		]);
		const audit = await db
			.prepare(
				"SELECT request_id, ip_address, after FROM audit_logs WHERE action = 'queue.manual_retry'",
			)
			.first<{ request_id: string; ip_address: string; after: string }>();
		expect(audit).toMatchObject({
			request_id: "retry-request",
			ip_address: "203.0.113.9",
		});
		expect(JSON.parse(audit?.after ?? "null")).toEqual({
			queued: 1,
			failed: 0,
		});
		expect(audit?.after).not.toContain("active-order");
	});

	it("fails closed before writing an audit when the binding is unavailable", async () => {
		await expect(
			retryQueueWorkload({ DB: db } as Env, "payment", {
				actorUserId: "actor",
			}),
		).rejects.toMatchObject({
			code: "binding_unavailable",
			status: 503,
		});
	});

	it("reports Bun dead letters only where the durable queue table exists", async () => {
		await expect(loadDeadQueueMessageCounts(db)).resolves.toBeNull();
		// The Bun runtime creates this table itself; D1 deployments never have it.
		await db
			.prepare(
				`CREATE TABLE node_queue_messages (
				 id TEXT PRIMARY KEY NOT NULL, queue TEXT NOT NULL, body TEXT NOT NULL,
				 status TEXT NOT NULL CHECK (status IN ('ready', 'leased', 'dead')),
				 attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
				 lease_token TEXT, lease_expires_at INTEGER, last_error TEXT,
				 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
			)
			.run();
		await db
			.prepare(
				`INSERT INTO node_queue_messages (id, queue, body, status, attempts, available_at, created_at, updated_at)
				 VALUES ('dead-1', 'gmpay-edge-webhooks', '{}', 'dead', 9, 0, 0, 0),
				 ('dead-2', 'gmpay-edge-webhooks', '{}', 'dead', 9, 0, 0, 0),
				 ('ready-1', 'gmpay-edge-payments', '{}', 'ready', 0, 0, 0, 0)`,
			)
			.run();
		await expect(loadDeadQueueMessageCounts(db)).resolves.toEqual(
			new Map([["gmpay-edge-webhooks", 2]]),
		);
	});

	it("returns a stable error without exposing a Queue rejection", async () => {
		const sendBatch = vi
			.fn()
			.mockRejectedValue(new Error("provider token=queue-secret"));

		await expect(
			retryQueueWorkload(
				{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
				"payment",
				{ actorUserId: "actor" },
			),
		).rejects.toMatchObject({
			code: "queue_enqueue_failed",
			status: 502,
			message: "Payment Queue rejected the retry batch",
		});
		expect(sendBatch).toHaveBeenCalledOnce();
	});
});

async function seed(db: D1Database) {
	await db.batch([
		db.prepare(
			"INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at) VALUES ('actor', 'Root', 'root@example.com', 1, 1, 1, 1)",
		),
		db.prepare(
			"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', 1, 1)",
		),
		db.prepare(
			"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('asset', 'tron', 'USDT', 'USDT', 'token', 6, 1, 1)",
		),
		db.prepare(
			"UPDATE payment_assets SET default_confirmations = 20 WHERE id = 'asset'",
		),
		db.prepare(
			"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('receiving', 'Primary', 'tron', 'address', 'TAddress', 'TAddress', 1, 1, 1)",
		),
		db.prepare(
			"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at) VALUES ('active-order', 'ACTIVE', 'pending', '100', 'USD', 2, 'asset', '0', 9999999999999, 0, 1, 1), ('paid-order', 'PAID', 'paid', '100', 'USD', 2, 'asset', '1000000', 9999999999999, 0, 2, 2)",
		),
		...(["active-order", "paid-order"] as const).map((orderId) =>
			db.prepare(
				`INSERT INTO order_payment_snapshots
				 (order_id, receiving_method_id, receiving_method_name,
				  rail_code, rail_kind, asset_id, asset_code,
				  decimals, target_value, adapter, required_confirmations,
				  expected_amount_units, created_at)
				 VALUES ('${orderId}', 'receiving', 'Primary',
				  'tron', 'chain', 'asset', 'USDT', 6, 'TAddress', 'tron', 20,
				  '1000000', 1)`,
			),
		),
	]);
}
