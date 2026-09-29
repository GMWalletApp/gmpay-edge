import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	cancelOrderAsAdmin,
	queueAdminPaymentCheck,
	recordExternalRefund,
	resendOrderNotification,
} from "#/features/orders/server/admin-actions";
import { applyMigrations } from "./migrations";

describe("admin order operations", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const send = vi.fn().mockResolvedValue(undefined);
	const context = {
		actorUserId: "actor",
		requestId: "request-admin-order",
		ipAddress: "203.0.113.10",
	};

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-admin-order-actions" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it("queues an immediate payment scan with the existing cursor and audits it", async () => {
		const env = { DB: db, PAYMENT_QUEUE: { send } } as unknown as Env;
		await expect(
			queueAdminPaymentCheck(env, "order-pending", context),
		).resolves.toEqual({ queued: true });
		expect(send).toHaveBeenCalledWith({
			kind: "payment.scan",
			version: 1,
			orderId: "order-pending",
			receivingMethodId: "method",
		});
		const audit = await db
			.prepare(
				"SELECT action, actor_user_id, request_id FROM audit_logs WHERE target_id = 'order-pending' AND action = 'order.payment_check_requested'",
			)
			.first<Record<string, unknown>>();
		expect(audit).toMatchObject({
			action: "order.payment_check_requested",
			actor_user_id: "actor",
			request_id: "request-admin-order",
		});
	});

	it("uses stable not-found and status-conflict errors for payment checks", async () => {
		const env = { DB: db, PAYMENT_QUEUE: { send } } as unknown as Env;
		await expect(
			queueAdminPaymentCheck(env, "missing-order", context),
		).rejects.toMatchObject({
			code: "order_payment_target_not_found",
			status: 404,
		});
		await expect(
			queueAdminPaymentCheck(env, "order-paid", context),
		).rejects.toMatchObject({ code: "order_status_conflict", status: 409 });
	});

	it("cancels atomically and emits one event across retries", async () => {
		const env = { DB: db } as Env;
		await expect(
			cancelOrderAsAdmin(env, "order-pending", context),
		).resolves.toMatchObject({ changed: true, status: "cancelled" });
		await expect(
			cancelOrderAsAdmin(env, "order-pending", context),
		).resolves.toMatchObject({ changed: false, status: "cancelled" });
		const lock = await db
			.prepare(
				"SELECT released_at FROM receiving_method_locks WHERE order_id = 'order-pending'",
			)
			.first<{ released_at: number | null }>();
		expect(lock?.released_at).not.toBeNull();
		await expect(
			count(
				db,
				"webhook_events",
				"deduplication_key = 'order-pending:cancelled'",
			),
		).resolves.toBe(1);
		await expect(
			count(db, "audit_logs", "action = 'order.cancelled_by_admin'"),
		).resolves.toBe(1);
	});

	it("records an external refund once and rejects refunds for unpaid orders", async () => {
		const env = { DB: db } as Env;
		const input = {
			orderId: "order-paid",
			reference: "exchange-withdrawal-42",
			note: "Refunded from the external custody account",
		};
		await expect(
			recordExternalRefund(env, input, context),
		).resolves.toMatchObject({
			changed: true,
			status: "refunded",
		});
		await expect(
			recordExternalRefund(env, input, context),
		).resolves.toMatchObject({
			changed: false,
			status: "refunded",
		});
		const order = await db
			.prepare("SELECT status, version FROM orders WHERE id = 'order-paid'")
			.first();
		expect(order).toEqual({ status: "refunded", version: 1 });
		await expect(
			count(db, "audit_logs", "action = 'order.external_refund_recorded'"),
		).resolves.toBe(1);
		await expect(
			count(db, "webhook_events", "deduplication_key = 'order-paid:refunded'"),
		).resolves.toBe(1);
		await expect(
			recordExternalRefund(env, { ...input, orderId: "order-unpaid" }, context),
		).rejects.toMatchObject({ code: "order_status_conflict", status: 409 });
		await expect(
			recordExternalRefund(
				env,
				{ ...input, orderId: "missing-order" },
				context,
			),
		).rejects.toMatchObject({ code: "order_not_found", status: 404 });
	});

	it("persists and queues each requested manual merchant notification", async () => {
		send.mockClear();
		const env = {
			DB: db,
			WEBHOOK_QUEUE: { send },
		} as unknown as Env;
		await expect(
			resendOrderNotification(env, "order-notify", context),
		).resolves.toEqual({ queued: true });
		await expect(
			resendOrderNotification(env, "order-notify", context),
		).resolves.toEqual({ queued: true });
		expect(send).toHaveBeenCalledTimes(2);
		await expect(
			count(db, "webhook_events", "order_id = 'order-notify'"),
		).resolves.toBe(2);
		await expect(
			count(db, "webhook_deliveries", "order_id = 'order-notify'"),
		).resolves.toBe(2);
		await expect(
			count(
				db,
				"audit_logs",
				"target_id = 'order-notify' AND action = 'order.notification_resent'",
			),
		).resolves.toBe(2);
	});

	it("rejects manual notifications without an order destination", async () => {
		const env = {
			DB: db,
			WEBHOOK_QUEUE: { send },
		} as unknown as Env;
		await expect(
			resendOrderNotification(env, "order-unpaid", context),
		).rejects.toMatchObject({
			code: "order_notification_missing",
			status: 409,
		});
		await expect(
			resendOrderNotification(env, "missing-order", context),
		).rejects.toMatchObject({ code: "order_not_found", status: 404 });
	});

	it.each(["cancelled", "refunded"] as const)(
		"rolls back %s, its audit, and its lock when outbox persistence fails",
		async (nextStatus) => {
			const id = `atomic-${nextStatus}`;
			const initialStatus = nextStatus === "cancelled" ? "pending" : "paid";
			await db
				.prepare(`INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, received_amount_units, api_key_id, notify_url, expires_at, version, created_at, updated_at)
		 VALUES (?, ?, ?, '100', 'USD', 2, '0', 'merchant-key', 'https://merchant.example/notify', 9999999999999, 0, 1, 1)`)
				.bind(id, id, initialStatus)
				.run();
			await db
				.prepare(
					"INSERT INTO receiving_method_locks (id, receiving_method_id, asset_id, order_id, expected_amount_units, expires_at, reusable_at, created_at) VALUES (?, 'method', 'asset', ?, '42', 9999999999999, 9999999999999, 1)",
				)
				.bind(id, id)
				.run();
			const env = { DB: db, WEBHOOK_QUEUE: { send } } as unknown as Env;
			const execute = () =>
				nextStatus === "cancelled"
					? cancelOrderAsAdmin(env, id, context)
					: recordExternalRefund(
							env,
							{
								orderId: id,
								reference: "external-refund",
								note: "Recorded external refund",
							},
							context,
						);
			await db
				.prepare(
					`CREATE TRIGGER reject_admin_outbox BEFORE INSERT ON webhook_deliveries BEGIN SELECT RAISE(FAIL, 'simulated outbox failure'); END`,
				)
				.run();
			try {
				await expect(execute()).rejects.toThrow("simulated outbox failure");
				expect(
					await db
						.prepare("SELECT status, version FROM orders WHERE id = ?")
						.bind(id)
						.first(),
				).toEqual({ status: initialStatus, version: 0 });
				expect(
					await db
						.prepare(
							"SELECT released_at FROM receiving_method_locks WHERE order_id = ?",
						)
						.bind(id)
						.first(),
				).toEqual({ released_at: null });
				expect(
					await db
						.prepare(
							"SELECT COUNT(*) AS count FROM webhook_events WHERE order_id = ?",
						)
						.bind(id)
						.first(),
				).toEqual({ count: 0 });
				expect(
					await db
						.prepare(
							"SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ?",
						)
						.bind(id)
						.first(),
				).toEqual({ count: 0 });
			} finally {
				await db.prepare("DROP TRIGGER reject_admin_outbox").run();
			}
			await expect(execute()).resolves.toMatchObject({
				changed: true,
				status: nextStatus,
			});
		},
	);
});

async function count(db: D1Database, table: string, where: string) {
	const row = await db
		.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function seed(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"INSERT INTO api_keys (id, name, pid, secret_encrypted, scopes, created_at, updated_at) VALUES ('merchant-key', 'Merchant', '100000000099', 'encrypted', '[\"orders:create\",\"orders:read\"]', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at) VALUES ('actor', 'Root', 'root@example.com', 1, 1, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('asset', 'tron', 'USDT', 'USDT', 'token', 6, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, enabled, health_status, created_at, updated_at) VALUES ('connection', 'tron', 'TRON', 'rpc', 'https://api.trongrid.io', 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 1, created_at = ?, updated_at = ? WHERE id = 'asset'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('method', 'Primary USDT', 'tron', 'address', 'TAdminPending', 'TAdminPending', 1, ?, ?)",
			)
			.bind(now, now),
		...[
			["order-pending", "pending", "0", "100"],
			["order-paid", "paid", "1000000", null],
			["order-unpaid", "pending", "0", null],
			["order-notify", "paid", "1000000", null],
		].map(([id, status, received, cursor]) =>
			db
				.prepare(
					"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, payment_scan_cursor, version, created_at, updated_at) VALUES (?, ?, ?, '100', 'USD', 2, 'asset', ?, ?, ?, 0, ?, ?)",
				)
				.bind(
					id,
					`${id}-number`,
					status,
					received,
					now + 60_000,
					cursor,
					now,
					now,
				),
		),
		db
			.prepare(
				"INSERT INTO receiving_method_locks (id, receiving_method_id, asset_id, order_id, expected_amount_units, expires_at, reusable_at, created_at) VALUES ('lock-pending', 'method', 'asset', 'order-pending', '1000000', ?, ?, ?)",
			)
			.bind(now + 60_000, now + 86_460_000, now),
		...[
			["order-pending", "TAdminPending"],
			["order-paid", "TAdminPaid"],
			["order-unpaid", "TAdminUnpaid"],
			["order-notify", "TAdminNotify"],
		].map(([id, address]) =>
			db
				.prepare(
					`INSERT INTO order_payment_snapshots
					 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
					  asset_id, asset_code, decimals, target_value, connection_id, adapter,
					  required_confirmations, expected_amount_units, created_at)
					 VALUES (?, 'method', 'Primary USDT', 'tron', 'chain', 'asset', 'USDT', 6,
					  ?, 'connection', 'tron', 1, '1000000', ?)`,
				)
				.bind(id, address, now),
		),
		db.prepare(
			"UPDATE orders SET api_key_id = 'merchant-key', notify_url = 'https://merchant.example/notify' WHERE id = 'order-notify'",
		),
	]);
}
