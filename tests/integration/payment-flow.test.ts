import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryAdminDashboard } from "#/features/dashboard/server/query";
import { resolveLatePayment } from "#/features/payments/server/late-payment";
import { recordPaymentTransaction } from "#/features/payments/server/process";
import type { NormalizedTransaction } from "#/integrations/chains/types";
import {
	processScannedTransactions,
	refreshPendingPaymentTransactions,
} from "#/server/queue";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("D1 payment processing flow", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let env: Env;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-test" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		env = {
			DB: db,
			WEBHOOK_QUEUE: { send: async () => undefined },
		} as unknown as Env;
		await seedOrder(db);
	});

	afterAll(async () => miniflare.dispose());

	it("persists detection, confirmation, idempotency, and a chain reorganization", async () => {
		const detected = await recordPaymentTransaction(
			env,
			"order-1",
			transaction({ confirmations: 1 }),
		);
		expect(detected).toEqual({ duplicate: false, status: "confirming" });

		const confirmed = await recordPaymentTransaction(
			env,
			"order-1",
			transaction({ confirmations: 2 }),
		);
		expect(confirmed).toEqual({ duplicate: false, status: "paid" });

		const duplicate = await recordPaymentTransaction(
			env,
			"order-1",
			transaction({ confirmations: 2 }),
		);
		expect(duplicate).toEqual({ duplicate: true, status: "paid" });

		const reorged = await recordPaymentTransaction(
			env,
			"order-1",
			transaction({ confirmations: 0, canonical: false, blockHash: "fork" }),
		);
		expect(reorged).toEqual({ duplicate: false, status: "pending" });

		const order = await db
			.prepare(
				"SELECT status, received_amount_units, version FROM orders WHERE id = ?",
			)
			.bind("order-1")
			.first<{
				status: string;
				received_amount_units: string;
				version: number;
			}>();
		expect(order).toEqual({
			status: "pending",
			received_amount_units: "0",
			version: 3,
		});

		const counts = await db
			.prepare(`SELECT
			 (SELECT COUNT(*) FROM blockchain_transactions) AS transactions,
			 (SELECT COUNT(*) FROM order_payments) AS payments,
			 (SELECT COUNT(*) FROM webhook_events) AS events`)
			.first<{ transactions: number; payments: number; events: number }>();
		expect(counts).toEqual({ transactions: 1, payments: 1, events: 3 });

		const counters = createDatastoreCounters();
		const dashboard = await queryAdminDashboard(
			instrumentD1(db, counters),
			Date.now(),
		);
		expect(counters.d1Batch).toBe(1);
		expect(counters.d1Prepare).toBe(7);
		expect(dashboard.orders).toEqual({
			total: 1,
			active: 1,
			paid: 0,
			expired: 0,
		});
		expect(dashboard.receivingMethods).toEqual({ enabled: 1, total: 1 });
		expect(dashboard.recentOrders[0]).toMatchObject({
			id: "order-1",
			status: "pending",
		});
	});

	it("does not retry dashboard queries after its single batch fails", async () => {
		const counters = createDatastoreCounters();
		const unavailable = new Proxy(db, {
			get(target, property, receiver) {
				if (property === "batch")
					return async () => {
						throw new Error("D1 unavailable");
					};
				return Reflect.get(target, property, receiver);
			},
		}) as D1Database;
		await expect(
			queryAdminDashboard(instrumentD1(unavailable, counters)),
		).rejects.toThrow("D1 unavailable");
		expect(counters.d1Prepare).toBe(7);
		expect(counters.d1Batch).toBe(1);
	});

	it("reconciles split underpayments through confirming to fully paid", async () => {
		const now = Date.now();
		const target = "TSplit1111111111111111111111111111";
		await insertOrderWithSnapshot(db, {
			id: "order-split",
			externalOrderId: "merchant-order-split",
			status: "pending",
			target,
			expiresAt: now + 900_000,
			now,
		});

		await expect(
			recordPaymentTransaction(
				env,
				"order-split",
				transaction({
					hash: "tx-split-a",
					to: target,
					amountUnits: 4_000_000n,
					confirmations: 2,
				}),
			),
		).resolves.toEqual({ duplicate: false, status: "partially_paid" });
		await expect(
			recordPaymentTransaction(
				env,
				"order-split",
				transaction({
					hash: "tx-split-b",
					to: target,
					amountUnits: 6_000_000n,
					confirmations: 1,
				}),
			),
		).resolves.toEqual({ duplicate: false, status: "confirming" });
		await expect(
			recordPaymentTransaction(
				env,
				"order-split",
				transaction({
					hash: "tx-split-b",
					to: target,
					amountUnits: 6_000_000n,
					confirmations: 2,
				}),
			),
		).resolves.toEqual({ duplicate: false, status: "paid" });

		const state = await db
			.prepare(
				`SELECT o.status, o.received_amount_units,
				 (SELECT COUNT(*) FROM order_payments WHERE order_id = o.id) AS payments
				 FROM orders o WHERE o.id = 'order-split'`,
			)
			.first<{
				status: string;
				received_amount_units: string;
				payments: number;
			}>();
		expect(state).toEqual({
			status: "paid",
			received_amount_units: "10000000",
			payments: 2,
		});
		const events = await db
			.prepare(
				"SELECT type FROM webhook_events WHERE order_id = 'order-split' ORDER BY created_at, rowid",
			)
			.all<{ type: string }>();
		expect(events.results.map((event) => event.type)).toEqual([
			"order.partially_paid",
			"order.confirming",
			"order.paid",
		]);
	});

	it("returns an overpaid order to paid when the excess transfer is reorged", async () => {
		const now = Date.now();
		const target = "TOverpaid11111111111111111111111111";
		await insertOrderWithSnapshot(db, {
			id: "order-overpaid",
			externalOrderId: "merchant-order-overpaid",
			status: "pending",
			target,
			expiresAt: now + 900_000,
			now,
		});
		await recordPaymentTransaction(
			env,
			"order-overpaid",
			transaction({ hash: "tx-exact", to: target, confirmations: 2 }),
		);
		await expect(
			recordPaymentTransaction(
				env,
				"order-overpaid",
				transaction({
					hash: "tx-excess",
					to: target,
					amountUnits: 1_000_000n,
					confirmations: 2,
				}),
			),
		).resolves.toEqual({ duplicate: false, status: "overpaid" });
		await expect(
			recordPaymentTransaction(
				env,
				"order-overpaid",
				transaction({
					hash: "tx-excess",
					to: target,
					amountUnits: 1_000_000n,
					confirmations: 0,
					canonical: false,
					blockHash: "fork-excess",
				}),
			),
		).resolves.toEqual({ duplicate: false, status: "paid" });

		const state = await db
			.prepare(
				"SELECT status, received_amount_units FROM orders WHERE id = 'order-overpaid'",
			)
			.first<{ status: string; received_amount_units: string }>();
		expect(state).toEqual({
			status: "paid",
			received_amount_units: "10000000",
		});
		const events = await db
			.prepare(
				"SELECT type FROM webhook_events WHERE order_id = 'order-overpaid' ORDER BY created_at, rowid",
			)
			.all<{ type: string }>();
		expect(events.results.map((event) => event.type)).toEqual([
			"order.paid",
			"order.overpaid",
			"order.paid",
		]);
	});

	it("requires two consecutive provider misses before rolling back a payment", async () => {
		const now = Date.now();
		await insertOrderWithSnapshot(db, {
			id: "order-missing",
			externalOrderId: "merchant-order-missing",
			status: "pending",
			target: "TMissing111111111111111111111111111",
			expiresAt: now + 900_000,
			now,
		});
		const observed = transaction({
			hash: "tx-missing",
			to: "TMissing111111111111111111111111111",
			confirmations: 1,
		});
		await recordPaymentTransaction(env, "order-missing", observed);
		let addressHistoryScans = 0;
		const absentAdapter = {
			getTransaction: async () => null,
			findTransactions: async () => {
				addressHistoryScans += 1;
				return [];
			},
		} as unknown as import("#/integrations/chains/types").PaymentAdapter<unknown>;

		await expect(
			refreshPendingPaymentTransactions(db, "order-missing", absentAdapter),
		).resolves.toEqual([]);
		const firstMiss = await db
			.prepare(
				"SELECT status FROM blockchain_transactions WHERE tx_hash = 'tx-missing'",
			)
			.first<{ status: string }>();
		expect(firstMiss?.status).toBe("missing");
		const orderAfterFirstMiss = await db
			.prepare("SELECT status FROM orders WHERE id = 'order-missing'")
			.first<{ status: string }>();
		expect(orderAfterFirstMiss?.status).toBe("confirming");
		const recoveredAdapter = {
			getTransaction: async () => observed,
			findTransactions: async () => {
				addressHistoryScans += 1;
				return [];
			},
		} as unknown as import("#/integrations/chains/types").PaymentAdapter<unknown>;
		const recovered = await refreshPendingPaymentTransactions(
			db,
			"order-missing",
			recoveredAdapter,
		);
		await processScannedTransactions(env, "order-missing", recovered);
		const recoveredState = await db
			.prepare(
				"SELECT status FROM blockchain_transactions WHERE tx_hash = 'tx-missing'",
			)
			.first<{ status: string }>();
		expect(recoveredState?.status).toBe("pending");

		await expect(
			refreshPendingPaymentTransactions(db, "order-missing", absentAdapter),
		).resolves.toEqual([]);

		const secondMiss = await refreshPendingPaymentTransactions(
			db,
			"order-missing",
			absentAdapter,
		);
		expect(secondMiss).toHaveLength(1);
		expect(secondMiss[0]).toMatchObject({
			hash: "tx-missing",
			confirmations: 0,
			canonical: false,
		});
		expect(addressHistoryScans).toBe(0);
		await processScannedTransactions(env, "order-missing", secondMiss);
		const rolledBack = await db
			.prepare(
				"SELECT status, received_amount_units FROM orders WHERE id = 'order-missing'",
			)
			.first<{ status: string; received_amount_units: string }>();
		expect(rolledBack).toEqual({
			status: "pending",
			received_amount_units: "0",
		});
	});

	it("reverses paid state when confirmations fall or execution fails", async () => {
		const now = Date.now();
		await insertOrderWithSnapshot(db, {
			id: "order-reversal",
			externalOrderId: "merchant-order-reversal",
			status: "pending",
			target: "TReversal11111111111111111111111111",
			expiresAt: now + 900_000,
			now,
		});
		const settled = transaction({
			hash: "tx-reversal",
			to: "TReversal11111111111111111111111111",
			confirmations: 2,
		});
		await expect(
			recordPaymentTransaction(env, "order-reversal", settled),
		).resolves.toEqual({ duplicate: false, status: "paid" });
		await expect(
			recordPaymentTransaction(env, "order-reversal", {
				...settled,
				confirmations: 1,
			}),
		).resolves.toEqual({ duplicate: false, status: "confirming" });
		const confirmationLoss = await db
			.prepare(
				`SELECT o.status, o.received_amount_units, o.paid_at,
				 op.status AS payment_status, bt.status AS chain_status
				 FROM orders o JOIN order_payments op ON op.order_id = o.id
				 JOIN blockchain_transactions bt
				 ON op.transaction_id = bt.network || ':' || bt.tx_hash || ':' || bt.event_index
				 WHERE o.id = 'order-reversal'`,
			)
			.first<{
				status: string;
				received_amount_units: string;
				paid_at: number | null;
				payment_status: string;
				chain_status: string;
			}>();
		expect(confirmationLoss).toEqual({
			status: "confirming",
			received_amount_units: "10000000",
			paid_at: null,
			payment_status: "confirming",
			chain_status: "pending",
		});

		await expect(
			recordPaymentTransaction(env, "order-reversal", {
				...settled,
				confirmations: 0,
				success: false,
			}),
		).resolves.toEqual({ duplicate: false, status: "pending" });
		const failed = await db
			.prepare(
				`SELECT o.status, o.received_amount_units,
				 op.status AS payment_status, bt.status AS chain_status
				 FROM orders o JOIN order_payments op ON op.order_id = o.id
				 JOIN blockchain_transactions bt
				 ON op.transaction_id = bt.network || ':' || bt.tx_hash || ':' || bt.event_index
				 WHERE o.id = 'order-reversal'`,
			)
			.first<Record<string, string>>();
		expect(failed).toEqual({
			status: "pending",
			received_amount_units: "0",
			payment_status: "rejected",
			chain_status: "failed",
		});
	});

	it("records a late payment for review without reopening the expired order", async () => {
		const now = Date.now();
		await insertOrderWithSnapshot(db, {
			id: "order-late",
			externalOrderId: "merchant-order-late",
			status: "expired",
			target: "TLate11111111111111111111111111111",
			expiresAt: now - 1,
			version: 1,
			now,
		});
		await expect(
			recordPaymentTransaction(
				env,
				"order-late",
				transaction({
					hash: "tx-late",
					to: "TLate11111111111111111111111111111",
					confirmations: 2,
				}),
			),
		).resolves.toEqual({ duplicate: false, status: "expired" });
		const order = await db
			.prepare(
				"SELECT status, received_amount_units FROM orders WHERE id = 'order-late'",
			)
			.first<{ status: string; received_amount_units: string }>();
		expect(order).toEqual({ status: "expired", received_amount_units: "0" });
		const payment = await db
			.prepare(
				"SELECT id, status FROM order_payments WHERE order_id = 'order-late'",
			)
			.first<{ id: string; status: string }>();
		expect(payment?.status).toBe("pending_review");
		const audit = await db
			.prepare(
				"SELECT action FROM audit_logs WHERE target_id = 'order-late' ORDER BY created_at DESC LIMIT 1",
			)
			.first<{ action: string }>();
		expect(audit?.action).toBe("payment.late_review_required");
		const lateEvent = await db
			.prepare(
				"SELECT type, payload FROM webhook_events WHERE order_id = 'order-late' AND type = 'payment.late_detected'",
			)
			.first<{ type: string; payload: string }>();
		expect(lateEvent?.type).toBe("payment.late_detected");
		expect(JSON.parse(lateEvent?.payload ?? "{}")).toMatchObject({
			event: "payment.late_detected",
			instance: { name: "GMPay Edge", url: "" },
			orderId: "order-late",
			status: "expired",
			payment: {
				lateAmountUnits: "10000000",
				policy: "review",
			},
			transaction: { hash: "tx-late", confirmations: 2 },
		});
		await expect(
			recordPaymentTransaction(
				env,
				"order-late",
				transaction({
					hash: "tx-late",
					to: "TLate11111111111111111111111111111",
					confirmations: 2,
				}),
			),
		).resolves.toEqual({ duplicate: true, status: "expired" });
		const eventCount = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM webhook_events WHERE order_id = 'order-late' AND type = 'payment.late_detected'",
			)
			.first<{ count: number }>();
		expect(eventCount?.count).toBe(1);
		if (!payment) throw new Error("Expected late payment");
		await expect(
			resolveLatePayment(env, payment.id, "accept"),
		).resolves.toMatchObject({ status: "paid", decision: "accept" });
		const accepted = await db
			.prepare(
				"SELECT status, received_amount_units FROM orders WHERE id = 'order-late'",
			)
			.first<{ status: string; received_amount_units: string }>();
		expect(accepted).toEqual({
			status: "paid",
			received_amount_units: "10000000",
		});
		const acceptedEvent = await db
			.prepare(
				"SELECT payload FROM webhook_events WHERE order_id = 'order-late' AND type = 'order.paid'",
			)
			.first<{ payload: string }>();
		expect(JSON.parse(acceptedEvent?.payload ?? "{}")).toMatchObject({
			event: "order.paid",
			orderId: "order-late",
			status: "paid",
			payment: { receivedAmountUnits: "10000000" },
			transaction: { id: "tron:tx-late:0", hash: "tx-late" },
		});
	});

	it("rolls back every side effect when concurrent payment updates lose the version race", async () => {
		const now = Date.now();
		await insertOrderWithSnapshot(db, {
			id: "order-race",
			externalOrderId: "merchant-order-race",
			status: "pending",
			target: "TRace11111111111111111111111111111",
			expiresAt: now + 900_000,
			now,
		});
		const payment = transaction({
			hash: "tx-race",
			to: "TRace11111111111111111111111111111",
			confirmations: 2,
		});
		const outcomes = await Promise.allSettled([
			recordPaymentTransaction(env, "order-race", payment),
			recordPaymentTransaction(env, "order-race", payment),
		]);
		expect(
			outcomes.filter((result) => result.status === "fulfilled"),
		).toHaveLength(2);
		expect(
			outcomes.filter(
				(result) => result.status === "fulfilled" && result.value.duplicate,
			),
		).toHaveLength(1);
		const counts = await db
			.prepare(`SELECT
			 (SELECT COUNT(*) FROM order_payments WHERE order_id = 'order-race') AS payments,
			 (SELECT COUNT(*) FROM webhook_events WHERE order_id = 'order-race') AS events`)
			.first<{ payments: number; events: number }>();
		expect(counts).toEqual({ payments: 1, events: 1 });
		await expect(
			recordPaymentTransaction(env, "order-race", payment),
		).resolves.toEqual({
			duplicate: true,
			status: "paid",
		});
		await insertOrderWithSnapshot(db, {
			id: "order-reuse",
			externalOrderId: "merchant-order-reuse",
			status: "pending",
			target: "TRace11111111111111111111111111111",
			expiresAt: now + 1_800_000,
			now,
		});
		await expect(
			recordPaymentTransaction(env, "order-reuse", payment),
		).rejects.toMatchObject({
			code: "transaction_already_attributed",
			status: 409,
		});
		const reused = await db
			.prepare(
				"SELECT status, received_amount_units FROM orders WHERE id = 'order-reuse'",
			)
			.first<{ status: string; received_amount_units: string }>();
		expect(reused).toEqual({ status: "pending", received_amount_units: "0" });
	});

	it("emits one late-rejected event when an administrator rejects a reviewed payment", async () => {
		const now = Date.now();
		await insertOrderWithSnapshot(db, {
			id: "order-reject",
			externalOrderId: "merchant-order-reject",
			status: "expired",
			target: "TReject1111111111111111111111111111",
			expiresAt: now - 1,
			version: 1,
			now,
		});
		await recordPaymentTransaction(
			env,
			"order-reject",
			transaction({
				hash: "tx-reject",
				to: "TReject1111111111111111111111111111",
				confirmations: 2,
			}),
		);
		const payment = await db
			.prepare("SELECT id FROM order_payments WHERE order_id = 'order-reject'")
			.first<{ id: string }>();
		if (!payment) throw new Error("Expected reviewed late payment");
		await expect(
			resolveLatePayment(env, payment.id, "reject"),
		).resolves.toEqual({
			orderId: "order-reject",
			status: "expired",
			decision: "reject",
		});
		await expect(resolveLatePayment(env, payment.id, "reject")).rejects.toThrow(
			"already been resolved",
		);
		const events = await db
			.prepare(
				"SELECT type, payload FROM webhook_events WHERE order_id = 'order-reject' ORDER BY created_at",
			)
			.all<{ type: string; payload: string }>();
		expect(events.results.map((event) => event.type)).toEqual([
			"payment.late_detected",
			"payment.late_rejected",
		]);
		expect(JSON.parse(events.results[1]?.payload ?? "{}")).toMatchObject({
			event: "payment.late_rejected",
			instance: { name: "GMPay Edge", url: "" },
			orderId: "order-reject",
			status: "expired",
			payment: {
				lateAmountUnits: "10000000",
				policy: "review",
				decision: "reject",
			},
			transaction: { hash: "tx-reject", confirmations: 2 },
		});
		const state = await db
			.prepare(
				`SELECT op.status AS payment_status, bt.status AS transaction_status,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'payment.late_rejected' AND target_id = 'order-reject') AS audits
				 FROM order_payments op JOIN blockchain_transactions bt
				 ON op.transaction_id = bt.network || ':' || bt.tx_hash || ':' || bt.event_index
				 WHERE op.id = ?`,
			)
			.bind(payment.id)
			.first<{
				payment_status: string;
				transaction_status: string;
				audits: number;
			}>();
		expect(state).toEqual({
			payment_status: "rejected",
			transaction_status: "failed",
			audits: 1,
		});
	});

	it("applies only one concurrent late-payment decision", async () => {
		const now = Date.now();
		await insertOrderWithSnapshot(db, {
			id: "order-decision",
			externalOrderId: "merchant-order-decision",
			status: "expired",
			target: "TDecision11111111111111111111111111",
			expiresAt: now - 1,
			version: 1,
			now,
		});
		await recordPaymentTransaction(
			env,
			"order-decision",
			transaction({
				hash: "tx-decision",
				to: "TDecision11111111111111111111111111",
				confirmations: 2,
			}),
		);
		const payment = await db
			.prepare(
				"SELECT id FROM order_payments WHERE order_id = 'order-decision'",
			)
			.first<{ id: string }>();
		if (!payment) throw new Error("Expected late payment");
		const outcomes = await Promise.allSettled([
			resolveLatePayment(env, payment.id, "accept"),
			resolveLatePayment(env, payment.id, "reject"),
		]);
		const fulfilled = outcomes.filter(
			(result) => result.status === "fulfilled",
		);
		expect(fulfilled.length).toBeLessThanOrEqual(1);
		if (fulfilled.length === 0) {
			await resolveLatePayment(env, payment.id, "accept");
		}
		const state = await db
			.prepare(`SELECT
			 (SELECT status FROM orders WHERE id = 'order-decision') AS order_status,
			 (SELECT status FROM order_payments WHERE id = ?) AS payment_status,
			 (SELECT COUNT(*) FROM audit_logs WHERE target_id = 'order-decision' AND action IN ('payment.late_accepted', 'payment.late_rejected')) AS decisions`)
			.bind(payment.id)
			.first<{
				order_status: string;
				payment_status: string;
				decisions: number;
			}>();
		expect(state?.decisions).toBe(1);
		expect(
			(state?.order_status === "paid" &&
				state.payment_status === "confirmed") ||
				(state?.order_status === "expired" &&
					state.payment_status === "rejected"),
		).toBe(true);
	});

	it("skips an old attributed transfer and continues a reused address scan", async () => {
		const now = Date.now();
		await insertOrderWithSnapshot(db, {
			id: "order-old-scan",
			externalOrderId: "merchant-old-scan",
			status: "pending",
			target: "TReusedScan11111111111111111111111",
			expiresAt: now + 900_000,
			now,
		});
		const oldTransfer = transaction({
			hash: "tx-old-scan",
			to: "TReusedScan11111111111111111111111",
			confirmations: 2,
		});
		await recordPaymentTransaction(env, "order-old-scan", oldTransfer);
		await insertOrderWithSnapshot(db, {
			id: "order-new-scan",
			externalOrderId: "merchant-new-scan",
			status: "pending",
			target: "TReusedScan11111111111111111111111",
			expiresAt: now + 1_800_000,
			now,
		});
		const result = await processScannedTransactions(env, "order-new-scan", [
			oldTransfer,
			transaction({
				hash: "tx-new-scan",
				to: "TReusedScan11111111111111111111111",
				confirmations: 2,
			}),
		]);
		expect(result).toEqual({
			skippedPreviouslyAttributed: 1,
			skippedAmbiguous: 0,
		});
		const order = await db
			.prepare(
				"SELECT status, received_amount_units FROM orders WHERE id = 'order-new-scan'",
			)
			.first<{ status: string; received_amount_units: string }>();
		expect(order).toEqual({
			status: "paid",
			received_amount_units: "10000000",
		});
	});

	it("attributes by immutable snapshots after immediate lock release", async () => {
		const now = Date.now();
		const target = "TConcurrent1111111111111111111111111";
		await insertOrderWithSnapshot(db, {
			id: "order-attribution-a",
			externalOrderId: "merchant-attribution-a",
			status: "pending",
			target,
			expiresAt: now + 900_000,
			expectedAmountUnits: "10000000",
			now,
		});
		await insertOrderWithSnapshot(db, {
			id: "order-attribution-b",
			externalOrderId: "merchant-attribution-b",
			status: "pending",
			target,
			expiresAt: now + 900_000,
			expectedAmountUnits: "10000001",
			now,
		});
		await db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('orders.immediate_release_mode', 'true', 0, 0, 0)",
			)
			.run();

		const result = await processScannedTransactions(
			env,
			"order-attribution-a",
			[
				transaction({
					hash: "tx-attribution-b",
					to: target,
					amountUnits: 10_000_001n,
					confirmations: 2,
					timestamp: new Date(now),
				}),
			],
		);
		expect(result).toEqual({
			skippedPreviouslyAttributed: 1,
			skippedAmbiguous: 0,
		});
		const orders = await db
			.prepare(
				"SELECT id, status, received_amount_units FROM orders WHERE id IN ('order-attribution-a','order-attribution-b') ORDER BY id",
			)
			.all<{ id: string; status: string; received_amount_units: string }>();
		expect(orders.results).toEqual([
			{
				id: "order-attribution-a",
				status: "pending",
				received_amount_units: "0",
			},
			{
				id: "order-attribution-b",
				status: "paid",
				received_amount_units: "10000001",
			},
		]);
		await db
			.prepare(
				"DELETE FROM system_settings WHERE key = 'orders.immediate_release_mode'",
			)
			.run();
	});

	it("refreshes confirmations of a paid order without new events or a paid_at rewrite", async () => {
		const now = Date.now();
		const target = "TIdempotent111111111111111111111111";
		await insertOrderWithSnapshot(db, {
			id: "order-idempotent",
			externalOrderId: "merchant-idempotent",
			status: "pending",
			target,
			expiresAt: now + 900_000,
			now,
		});
		const settled = transaction({
			hash: "tx-idempotent",
			to: target,
			confirmations: 2,
		});
		await expect(
			recordPaymentTransaction(env, "order-idempotent", settled),
		).resolves.toEqual({ duplicate: false, status: "paid" });
		const before = await orderPaymentState(db, "order-idempotent");
		expect(before.paid_at).toBeTypeOf("number");
		expect(before.events).toBe(1);

		for (const confirmations of [3, 40]) {
			await expect(
				recordPaymentTransaction(env, "order-idempotent", {
					...settled,
					confirmations,
					blockHash: "canonical",
				}),
			).resolves.toEqual({ duplicate: true, status: "paid" });
		}
		const after = await orderPaymentState(db, "order-idempotent");
		expect(after).toEqual({
			...before,
			payment_confirmations: 40,
			chain_confirmations: 40,
		});
	});

	it("completes an expired order when its attributed payment confirms", async () => {
		const now = Date.now();
		const target = "TExpiredConfirming111111111111111";
		await insertOrderWithSnapshot(db, {
			id: "order-expired-confirming",
			externalOrderId: "merchant-expired-confirming",
			status: "expired",
			target,
			expiresAt: now - 60_000,
			version: 2,
			now,
		});
		await insertAttributedPayment(db, {
			orderId: "order-expired-confirming",
			hash: "tx-expired-confirming",
			target,
			amountUnits: "10000000",
			now,
		});
		await expect(
			recordPaymentTransaction(
				env,
				"order-expired-confirming",
				transaction({
					hash: "tx-expired-confirming",
					to: target,
					confirmations: 2,
				}),
			),
		).resolves.toEqual({ duplicate: false, status: "paid" });
		const events = await db
			.prepare(
				"SELECT type FROM webhook_events WHERE order_id = 'order-expired-confirming' ORDER BY created_at, rowid",
			)
			.all<{ type: string }>();
		expect(events.results.map((event) => event.type)).toEqual(["order.paid"]);
		await expect(
			db
				.prepare(
					"SELECT status, received_amount_units FROM orders WHERE id = 'order-expired-confirming'",
				)
				.first(),
		).resolves.toEqual({ status: "paid", received_amount_units: "10000000" });
	});

	it("keeps an expired order terminal while an attributed partial payment settles", async () => {
		const now = Date.now();
		const target = "TExpiredPartial1111111111111111111";
		await insertOrderWithSnapshot(db, {
			id: "order-expired-partial",
			externalOrderId: "merchant-expired-partial",
			status: "expired",
			target,
			expiresAt: now - 60_000,
			version: 2,
			now,
		});
		await insertAttributedPayment(db, {
			orderId: "order-expired-partial",
			hash: "tx-expired-partial",
			target,
			amountUnits: "4000000",
			now,
		});
		await expect(
			recordPaymentTransaction(
				env,
				"order-expired-partial",
				transaction({
					hash: "tx-expired-partial",
					to: target,
					amountUnits: 4_000_000n,
					confirmations: 2,
				}),
			),
		).resolves.toEqual({ duplicate: false, status: "expired" });
		const state = await db
			.prepare(
				`SELECT o.status, o.received_amount_units, op.status AS payment_status,
				 (SELECT COUNT(*) FROM webhook_events WHERE order_id = o.id) AS events
				 FROM orders o JOIN order_payments op ON op.order_id = o.id WHERE o.id = 'order-expired-partial'`,
			)
			.first();
		expect(state).toEqual({
			status: "expired",
			received_amount_units: "4000000",
			payment_status: "confirmed",
			events: 0,
		});
	});

	it("counts reviewed late payments only once an administrator accepts them", async () => {
		const now = Date.now();
		const target = "TTwoLate11111111111111111111111111";
		await insertOrderWithSnapshot(db, {
			id: "order-two-late",
			externalOrderId: "merchant-two-late",
			status: "expired",
			target,
			expiresAt: now - 1,
			version: 1,
			now,
		});
		await recordPaymentTransaction(
			env,
			"order-two-late",
			transaction({ hash: "tx-late-a", to: target, confirmations: 2 }),
		);
		await recordPaymentTransaction(
			env,
			"order-two-late",
			transaction({
				hash: "tx-late-b",
				to: target,
				amountUnits: 1_000_000n,
				confirmations: 2,
			}),
		);
		const payments = await db
			.prepare(
				"SELECT id, transaction_id, status FROM order_payments WHERE order_id = 'order-two-late' ORDER BY transaction_id",
			)
			.all<{ id: string; transaction_id: string; status: string }>();
		expect(payments.results.map((payment) => payment.status)).toEqual([
			"pending_review",
			"pending_review",
		]);
		const [first, second] = payments.results;
		if (!(first && second)) throw new Error("Expected two late payments");
		await expect(
			resolveLatePayment(env, first.id, "accept"),
		).resolves.toMatchObject({ status: "paid" });
		await expect(
			db
				.prepare(
					"SELECT status, received_amount_units FROM orders WHERE id = 'order-two-late'",
				)
				.first(),
		).resolves.toEqual({ status: "paid", received_amount_units: "10000000" });
		await expect(
			resolveLatePayment(env, second.id, "reject"),
		).resolves.toMatchObject({ status: "paid", decision: "reject" });
		await expect(
			db
				.prepare(
					"SELECT status, received_amount_units FROM orders WHERE id = 'order-two-late'",
				)
				.first(),
		).resolves.toEqual({ status: "paid", received_amount_units: "10000000" });
	});

	it("tracks chain state of a payment awaiting review without counting it", async () => {
		const now = Date.now();
		const target = "TReviewTrack1111111111111111111111";
		await insertOrderWithSnapshot(db, {
			id: "order-review-track",
			externalOrderId: "merchant-review-track",
			status: "expired",
			target,
			expiresAt: now - 1,
			version: 1,
			now,
		});
		const late = transaction({
			hash: "tx-review-track",
			to: target,
			confirmations: 1,
		});
		await recordPaymentTransaction(env, "order-review-track", late);
		await expect(
			recordPaymentTransaction(env, "order-review-track", {
				...late,
				confirmations: 3,
			}),
		).resolves.toEqual({ duplicate: true, status: "expired" });
		await expect(
			db
				.prepare(
					`SELECT op.status, op.confirmations, o.received_amount_units,
					 (SELECT COUNT(*) FROM webhook_events WHERE order_id = o.id) AS events
					 FROM order_payments op JOIN orders o ON o.id = op.order_id
					 WHERE o.id = 'order-review-track'`,
				)
				.first(),
		).resolves.toEqual({
			status: "pending_review",
			confirmations: 3,
			received_amount_units: "0",
			events: 1,
		});
		await expect(
			recordPaymentTransaction(env, "order-review-track", {
				...late,
				confirmations: 0,
				canonical: false,
				blockHash: "fork-review",
			}),
		).resolves.toEqual({ duplicate: true, status: "expired" });
		const payment = await db
			.prepare(
				"SELECT id, status FROM order_payments WHERE order_id = 'order-review-track'",
			)
			.first<{ id: string; status: string }>();
		expect(payment?.status).toBe("reorged");
		if (!payment) throw new Error("Expected reviewed payment");
		await expect(
			resolveLatePayment(env, payment.id, "accept"),
		).rejects.toMatchObject({ code: "payment_decision_already_resolved" });
	});

	it("does not guess a partial transfer between shared-address orders", async () => {
		const now = Date.now();
		const target = "TAmbiguous11111111111111111111111111";
		await insertOrderWithSnapshot(db, {
			id: "order-ambiguous-a",
			externalOrderId: "merchant-ambiguous-a",
			status: "pending",
			target,
			expiresAt: now + 900_000,
			expectedAmountUnits: "12000000",
			now,
		});
		await insertOrderWithSnapshot(db, {
			id: "order-ambiguous-b",
			externalOrderId: "merchant-ambiguous-b",
			status: "pending",
			target,
			expiresAt: now + 900_000,
			expectedAmountUnits: "12000001",
			now,
		});
		await db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('orders.immediate_release_mode', 'true', 0, 0, 0)",
			)
			.run();

		const result = await processScannedTransactions(env, "order-ambiguous-a", [
			transaction({
				hash: "tx-attribution-ambiguous",
				to: target,
				amountUnits: 4_000_000n,
				confirmations: 2,
				timestamp: new Date(now),
			}),
		]);
		expect(result).toEqual({
			skippedPreviouslyAttributed: 0,
			skippedAmbiguous: 1,
		});
		const count = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM order_payments WHERE order_id IN ('order-ambiguous-a','order-ambiguous-b')",
			)
			.first<{ count: number }>();
		expect(count?.count).toBe(0);
		await db
			.prepare(
				"DELETE FROM system_settings WHERE key = 'orders.immediate_release_mode'",
			)
			.run();
	});
});

function transaction(
	overrides: Partial<NormalizedTransaction>,
): NormalizedTransaction {
	return {
		network: "tron",
		hash: "tx-1",
		eventIndex: 0,
		from: "TFrom1111111111111111111111111111",
		to: "TTarget11111111111111111111111111",
		assetCode: "USDT",
		amountUnits: 10_000_000n,
		blockNumber: 100n,
		blockHash: "canonical",
		confirmations: 1,
		timestamp: new Date("2026-07-12T00:00:00Z"),
		success: true,
		...overrides,
	};
}

async function seedOrder(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('asset-1', 'tron', 'USDT', 'USDT', 'token', 6, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, enabled, health_status, created_at, updated_at) VALUES ('connection-1', 'tron', 'TRON', 'rpc', 'https://api.trongrid.io', 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 2, created_at = ?, updated_at = ? WHERE id = 'asset-1'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('asset-1', 'TRON simulator', 'tron', 'address', 'TTarget11111111111111111111111111', 'TTarget11111111111111111111111111', 1, ?, ?)",
			)
			.bind(now, now),
	]);
	await insertOrderWithSnapshot(db, {
		id: "order-1",
		externalOrderId: "merchant-order-1",
		status: "pending",
		target: "TTarget11111111111111111111111111",
		expiresAt: now + 900_000,
		now,
	});
}

async function orderPaymentState(db: D1Database, orderId: string) {
	const state = await db
		.prepare(
			`SELECT o.status, o.paid_at, op.confirmations AS payment_confirmations,
			 op.confirmed_at, bt.confirmations AS chain_confirmations,
			 (SELECT COUNT(*) FROM webhook_events WHERE order_id = o.id) AS events
			 FROM orders o JOIN order_payments op ON op.order_id = o.id
			 JOIN blockchain_transactions bt
			 ON op.transaction_id = bt.network || ':' || bt.tx_hash || ':' || bt.event_index
			 WHERE o.id = ?`,
		)
		.bind(orderId)
		.first<{
			status: string;
			paid_at: number | null;
			payment_confirmations: number;
			confirmed_at: number | null;
			chain_confirmations: number;
			events: number;
		}>();
	if (!state) throw new Error(`Missing payment state for ${orderId}`);
	return state;
}

/** An attributed, still confirming payment that was counted before the order expired. */
async function insertAttributedPayment(
	db: D1Database,
	input: {
		orderId: string;
		hash: string;
		target: string;
		amountUnits: string;
		now: number;
	},
) {
	await db.batch([
		db
			.prepare(
				`INSERT INTO order_payments (id, order_id, transaction_id, amount_units,
				 confirmations, status, detected_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 1, 'confirming', ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				input.orderId,
				`tron:${input.hash}:0`,
				input.amountUnits,
				input.now,
				input.now,
				input.now,
			),
		db
			.prepare(
				`INSERT INTO blockchain_transactions (id, network, tx_hash, event_index,
				 from_address, to_address, asset_code, amount_units, block_number, block_hash,
				 confirmations, status, observed_at, created_at, updated_at)
				 VALUES (?, 'tron', ?, 0, 'TFrom1111111111111111111111111111', ?, 'USDT', ?, '100',
				 'canonical', 1, 'pending', ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				input.hash,
				input.target,
				input.amountUnits,
				input.now,
				input.now,
				input.now,
			),
		db
			.prepare("UPDATE orders SET received_amount_units = ? WHERE id = ?")
			.bind(input.amountUnits, input.orderId),
	]);
}

async function insertOrderWithSnapshot(
	db: D1Database,
	input: {
		id: string;
		externalOrderId: string;
		status: "pending" | "expired";
		target: string;
		expiresAt: number;
		now: number;
		version?: number;
		expectedAmountUnits?: string;
	},
) {
	await db.batch([
		db
			.prepare(
				`INSERT INTO orders
				 (id, external_order_id, status, amount_minor, currency, currency_decimals,
				  payment_asset_id, received_amount_units, expires_at, version,
				  created_at, updated_at)
				 VALUES (?, ?, ?, '1000', 'USD', 2, 'asset-1', '0', ?, ?, ?, ?)`,
			)
			.bind(
				input.id,
				input.externalOrderId,
				input.status,
				input.expiresAt,
				input.version ?? 0,
				input.now,
				input.now,
			),
		db
			.prepare(
				`INSERT INTO order_payment_snapshots
				 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind, asset_id, asset_code, decimals,
				  target_value, connection_id, adapter, required_confirmations,
				  expected_amount_units, created_at)
				 VALUES (?, 'asset-1', 'TRON simulator',
				  'tron', 'chain', 'asset-1', 'USDT', 6, ?, 'connection-1', 'tron',
					  2, ?, ?)`,
			)
			.bind(
				input.id,
				input.target,
				input.expectedAmountUnits ?? "10000000",
				input.now,
			),
	]);
}
