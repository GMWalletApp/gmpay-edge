import { Miniflare } from "miniflare";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	enqueueProviderEventIds,
	recoverProviderEventOutbox,
} from "#/features/payments/server/provider-event-outbox";
import {
	loadPaymentProviderEventPage,
	retryPaymentProviderEvent,
} from "#/features/webhooks/server/payment-provider-event-admin";
import type {
	NormalizedTransaction,
	PaymentAdapter,
} from "#/integrations/chains/types";
import { applyMigrations } from "./migrations";

const mocks = vi.hoisted(() => ({ createPaymentMethodAdapters: vi.fn() }));

vi.mock("#/features/payment-settings/server/method-adapter", () => ({
	createPaymentMethodAdapters: mocks.createPaymentMethodAdapters,
}));

import { handlePaymentProviderEvent } from "#/server/queue/payment-provider-event";

const sourceId = "22222222-2222-4222-8222-222222222222";
const target = "0xbe3f4b43db5eb49d1f48f53443b9abce45da3b79";
const storedTarget = "0xBe3f4B43db5eB49D1f48f53443B9aBcE45da3B79";
const contract = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

describe("provider payment event consumer", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-provider-event" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	beforeEach(() => {
		mocks.createPaymentMethodAdapters.mockReset();
		mocks.createPaymentMethodAdapters.mockResolvedValue([
			{ adapter: adapter((hash) => transaction(hash)) },
		]);
	});

	afterAll(async () => miniflare.dispose());

	it("authoritatively resolves a shadow event without mutating money state", async () => {
		await insertEvent(db, "event-shadow", "tx-shadow", false, "shadow");
		const message = queueMessage("event-shadow");
		await handlePaymentProviderEvent(message, { DB: db } as Env);

		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
		const [adapterCall] = mocks.createPaymentMethodAdapters.mock.calls;
		expect(adapterCall?.[0]).toBe(db);
		expect(adapterCall?.slice(1)).toEqual(["asset-usdc", storedTarget]);
		const state = await providerState(db, "event-shadow");
		expect(state).toEqual({
			event_status: "ignored",
			last_error_code: "shadow_matched",
			order_status: "pending",
			payments: 0,
		});
	});

	it("uses the existing atomic accounting path when a source becomes active", async () => {
		await db
			.prepare("UPDATE payment_ingresses SET mode = 'active' WHERE id = ?")
			.bind(sourceId)
			.run();
		await insertEvent(db, "event-active", "tx-active");
		const message = queueMessage("event-active");
		await handlePaymentProviderEvent(message, { DB: db } as Env);

		expect(message.ack).toHaveBeenCalledOnce();
		expect(await providerState(db, "event-active")).toEqual({
			event_status: "succeeded",
			last_error_code: null,
			order_status: "paid",
			payments: 1,
		});

		mocks.createPaymentMethodAdapters.mockClear();
		const duplicate = queueMessage("event-active");
		await handlePaymentProviderEvent(duplicate, { DB: db } as Env);
		expect(duplicate.ack).toHaveBeenCalledOnce();
		expect(mocks.createPaymentMethodAdapters).not.toHaveBeenCalled();
	});

	it("does not retroactively account a shadow event after activation", async () => {
		await resetOrder(db);
		await insertEvent(
			db,
			"event-pre-activation",
			"tx-pre-activation",
			false,
			"shadow",
		);
		const message = queueMessage("event-pre-activation");
		await handlePaymentProviderEvent(message, { DB: db } as Env);

		expect(message.ack).toHaveBeenCalledOnce();
		expect(await providerState(db, "event-pre-activation")).toEqual({
			event_status: "ignored",
			last_error_code: "shadow_matched",
			order_status: "pending",
			payments: 0,
		});
	});

	it("treats the provider removed flag as a hint and trusts the RPC result", async () => {
		await resetOrder(db);
		await insertEvent(db, "event-removed-hint", "tx-removed-hint", true);
		const message = queueMessage("event-removed-hint");
		await handlePaymentProviderEvent(message, { DB: db } as Env);

		expect(message.ack).toHaveBeenCalledOnce();
		expect(await providerState(db, "event-removed-hint")).toEqual({
			event_status: "succeeded",
			last_error_code: null,
			order_status: "paid",
			payments: 1,
		});
	});

	it("quarantines a Webhook-RPC mismatch and exposes degraded source health", async () => {
		await resetOrder(db);
		await db
			.prepare(
				"UPDATE payment_ingresses SET health_status = 'healthy', last_error_code = NULL WHERE id = ?",
			)
			.bind(sourceId)
			.run();
		mocks.createPaymentMethodAdapters.mockResolvedValue([
			{
				adapter: adapter((hash) => ({
					...transaction(hash),
					to: "0x1111111111111111111111111111111111111111",
				})),
			},
		]);
		await insertEvent(db, "event-rpc-mismatch", "tx-rpc-mismatch");
		const message = queueMessage("event-rpc-mismatch");

		await handlePaymentProviderEvent(message, { DB: db } as Env);

		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
		expect(await providerState(db, "event-rpc-mismatch")).toEqual({
			event_status: "ignored",
			last_error_code: "webhook_rpc_mismatch",
			order_status: "pending",
			payments: 0,
		});
		await expect(
			db
				.prepare(
					"SELECT health_status, last_error_code FROM payment_ingresses WHERE id = ?",
				)
				.bind(sourceId)
				.first(),
		).resolves.toEqual({
			health_status: "degraded",
			last_error_code: "webhook_rpc_mismatch",
		});
	});

	it("records a post-expiry transfer as a late payment without degrading the source", async () => {
		await resetOrder(db);
		const expiredAt = Date.now() - 600_000;
		await db.batch([
			db
				.prepare(
					"UPDATE payment_ingresses SET health_status = 'healthy', last_error_code = NULL WHERE id = ?",
				)
				.bind(sourceId),
			db.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('orders.immediate_release_mode', 'true', 0, 0, 0)",
			),
			db
				.prepare(
					"UPDATE orders SET status = 'expired', expires_at = ?, version = version + 1 WHERE id = 'order-provider'",
				)
				.bind(expiredAt),
			db.prepare(
				"DELETE FROM receiving_method_locks WHERE order_id = 'order-provider'",
			),
		]);
		try {
			await insertEvent(db, "event-late-transfer", "tx-late-transfer");
			const message = queueMessage("event-late-transfer");
			await handlePaymentProviderEvent(message, { DB: db } as Env);

			expect(message.ack).toHaveBeenCalledOnce();
			expect(await providerState(db, "event-late-transfer")).toEqual({
				event_status: "succeeded",
				last_error_code: null,
				order_status: "expired",
				payments: 1,
			});
			await expect(
				db
					.prepare(
						"SELECT status FROM order_payments WHERE order_id = 'order-provider'",
					)
					.first(),
			).resolves.toEqual({ status: "pending_review" });

			// A transfer far outside the late window matches nothing: ignored,
			// but the ingress stays healthy because the RPC confirmed the transfer.
			mocks.createPaymentMethodAdapters.mockResolvedValue([
				{
					adapter: adapter((hash) => ({
						...transaction(hash),
						timestamp: new Date(expiredAt + 3 * 86_400_000),
					})),
				},
			]);
			await insertEvent(db, "event-stray-transfer", "tx-stray-transfer");
			const stray = queueMessage("event-stray-transfer");
			await handlePaymentProviderEvent(stray, { DB: db } as Env);
			expect(stray.ack).toHaveBeenCalledOnce();
			expect(await providerState(db, "event-stray-transfer")).toMatchObject({
				event_status: "ignored",
				last_error_code: "payment_attribution_not_found",
				payments: 1,
			});
			await expect(
				db
					.prepare(
						"SELECT health_status, last_error_code FROM payment_ingresses WHERE id = ?",
					)
					.bind(sourceId)
					.first(),
			).resolves.toEqual({ health_status: "healthy", last_error_code: null });
		} finally {
			await db.batch([
				db.prepare(
					"DELETE FROM system_settings WHERE key = 'orders.immediate_release_mode'",
				),
				db
					.prepare(
						"UPDATE orders SET status = 'pending', expires_at = ?, version = version + 1 WHERE id = 'order-provider'",
					)
					.bind(Date.now() + 900_000),
				db
					.prepare(
						`INSERT INTO receiving_method_locks
					 (id, receiving_method_id, asset_id, order_id, expected_amount_units,
					  collision_key, expires_at, reusable_at, created_at)
					 VALUES ('lock-provider', 'method-ethereum', 'asset-usdc', 'order-provider',
					  '10000000', 'method-ethereum:asset-usdc:10000000', ?, ?, ?)`,
					)
					.bind(Date.now() + 900_000, Date.now() + 86_400_000, Date.now()),
			]);
			await resetOrder(db);
		}
	});

	it("retains an ambiguous shared-address transfer without mutating money", async () => {
		await resetOrder(db);
		await insertCompetingOrder(db);
		mocks.createPaymentMethodAdapters.mockResolvedValue([
			{
				adapter: adapter((hash) => ({
					...transaction(hash),
					amountUnits: 4_000_000n,
				})),
			},
		]);
		await insertEvent(db, "event-ambiguous", "tx-ambiguous");
		const message = queueMessage("event-ambiguous");
		await handlePaymentProviderEvent(message, { DB: db } as Env);

		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
		expect(await providerState(db, "event-ambiguous")).toEqual({
			event_status: "ambiguous",
			last_error_code: "payment_attribution_ambiguous",
			order_status: "pending",
			payments: 0,
		});
		await db
			.prepare(
				"UPDATE receiving_method_locks SET collision_key = NULL WHERE id = 'lock-provider-competitor'",
			)
			.run();
	});

	it("persists retry state when the authoritative RPC has not indexed the transaction", async () => {
		await resetOrder(db);
		mocks.createPaymentMethodAdapters.mockResolvedValue([
			{ adapter: adapter(() => null) },
		]);
		await insertEvent(db, "event-retry", "tx-retry");
		const message = queueMessage("event-retry");
		await handlePaymentProviderEvent(message, { DB: db } as Env);

		expect(message.ack).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
		const event = await db
			.prepare(
				"SELECT status, attempt_count, last_error_code, next_attempt_at FROM inbound_provider_events WHERE id = 'event-retry'",
			)
			.first<{
				status: string;
				attempt_count: number;
				last_error_code: string;
				next_attempt_at: number;
			}>();
		expect(event).toMatchObject({
			status: "failed",
			attempt_count: 1,
			last_error_code: "transaction_not_found",
		});
		expect(event?.next_attempt_at).toBeGreaterThan(Date.now());
	});

	it("alerts after a delayed non-removed event remains absent from RPC", async () => {
		await resetOrder(db);
		await db
			.prepare(
				"UPDATE payment_ingresses SET health_status = 'healthy', last_error_code = NULL WHERE id = ?",
			)
			.bind(sourceId)
			.run();
		mocks.createPaymentMethodAdapters.mockResolvedValue([
			{ adapter: adapter(() => null) },
		]);
		await insertEvent(db, "event-delayed-mismatch", "tx-delayed-mismatch");
		await db
			.prepare(
				"UPDATE inbound_provider_events SET attempt_count = 2 WHERE id = 'event-delayed-mismatch'",
			)
			.run();
		const message = queueMessage("event-delayed-mismatch");

		await handlePaymentProviderEvent(message, { DB: db } as Env);

		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
		expect(await providerState(db, "event-delayed-mismatch")).toEqual({
			event_status: "ignored",
			last_error_code: "webhook_rpc_mismatch",
			order_status: "pending",
			payments: 0,
		});
		await expect(
			db
				.prepare(
					"SELECT health_status, last_error_code FROM payment_ingresses WHERE id = ?",
				)
				.bind(sourceId)
				.first(),
		).resolves.toEqual({
			health_status: "degraded",
			last_error_code: "webhook_rpc_mismatch",
		});
	});

	it("dead-letters an event when no authoritative RPC adapter is available", async () => {
		mocks.createPaymentMethodAdapters.mockResolvedValue([]);
		await insertEvent(db, "event-no-adapter", "tx-no-adapter");
		const message = queueMessage("event-no-adapter");
		await handlePaymentProviderEvent(message, { DB: db } as Env);

		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
		const event = await db
			.prepare(
				"SELECT status, last_error_code FROM inbound_provider_events WHERE id = 'event-no-adapter'",
			)
			.first<{ status: string; last_error_code: string }>();
		expect(event).toEqual({
			status: "dead",
			last_error_code: "authoritative_adapter_unavailable",
		});
	});

	it("stops retrying an unconfirmed removed hint without mutating money", async () => {
		await resetOrder(db);
		mocks.createPaymentMethodAdapters.mockResolvedValue([
			{ adapter: adapter(() => null) },
		]);
		await insertEvent(db, "event-reorg-hint", "tx-reorg-hint", true);
		await db
			.prepare(
				"UPDATE inbound_provider_events SET attempt_count = 2 WHERE id = 'event-reorg-hint'",
			)
			.run();
		const message = queueMessage("event-reorg-hint");
		await handlePaymentProviderEvent(message, { DB: db } as Env);

		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
		expect(await providerState(db, "event-reorg-hint")).toEqual({
			event_status: "ignored",
			last_error_code: "reorg_hint",
			order_status: "pending",
			payments: 0,
		});
	});

	it("recovers an expired processing lease through the D1 outbox", async () => {
		await insertEvent(db, "event-expired-lease", "tx-expired-lease");
		await db
			.prepare(
				`UPDATE inbound_provider_events SET status = 'processing', lease_until = ?
				 WHERE id = 'event-expired-lease'`,
			)
			.bind(Date.now() - 1)
			.run();
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		let recoveryRecord: Record<string, unknown> | undefined;

		try {
			await expect(
				recoverProviderEventOutbox({
					DB: db,
					PAYMENT_QUEUE: { sendBatch } as unknown as Queue,
				}),
			).resolves.toEqual({ queued: 1, failed: 0 });
			recoveryRecord = JSON.parse(String(info.mock.calls[0]?.[0]));
		} finally {
			info.mockRestore();
		}
		expect(sendBatch).toHaveBeenCalledOnce();
		expect(recoveryRecord).toMatchObject({
			event: "payment_provider_outbox_recovered",
			selectedEvents: 1,
			recoveredLeases: 1,
			queuedEvents: 1,
			queueFailedEvents: 0,
			oldestEventAgeMs: expect.any(Number),
			outcome: "ok",
		});
		const event = await db
			.prepare(
				"SELECT status, lease_until, last_error_code FROM inbound_provider_events WHERE id = 'event-expired-lease'",
			)
			.first<{
				status: string;
				lease_until: number | null;
				last_error_code: string | null;
			}>();
		expect(event).toEqual({
			status: "queued",
			lease_until: null,
			last_error_code: "processing_lease_expired",
		});
	});

	it("does not overwrite a consumer claim after Queue accepts a message", async () => {
		await insertEvent(db, "event-outbox-race", "tx-outbox-race");
		await db
			.prepare(
				"UPDATE inbound_provider_events SET status = 'received' WHERE id = 'event-outbox-race'",
			)
			.run();
		const leaseUntil = Date.now() + 60_000;
		const sendBatch = vi.fn(async () => {
			await db
				.prepare(
					`UPDATE inbound_provider_events SET status = 'processing', lease_until = ?
					 WHERE id = 'event-outbox-race'`,
				)
				.bind(leaseUntil)
				.run();
		});

		await enqueueProviderEventIds(
			{
				DB: db,
				PAYMENT_QUEUE: { sendBatch } as unknown as Queue,
			},
			["event-outbox-race"],
		);

		const event = await db
			.prepare(
				"SELECT status, lease_until FROM inbound_provider_events WHERE id = 'event-outbox-race'",
			)
			.first<{ status: string; lease_until: number | null }>();
		expect(event).toEqual({ status: "processing", lease_until: leaseUntil });
	});

	it("lists provider events with source, status, and transaction filters", async () => {
		await insertEvent(db, "event-admin-list", "tx-admin-list");

		const page = await loadPaymentProviderEventPage(db, {
			pageIndex: 0,
			pageSize: 10,
			search: "tx-admin-list",
			sourceId,
			status: "queued",
		});

		expect(page.total).toBe(1);
		expect(page.items).toEqual([
			expect.objectContaining({
				id: "event-admin-list",
				sourceId,
				provider: "alchemy",
				network: "ethereum",
				transactionHash: "tx-admin-list",
				status: "queued",
				retryable: false,
			}),
		]);
	});

	it("durably requeues a manually retryable provider event", async () => {
		await insertEvent(db, "event-admin-retry", "tx-admin-retry");
		await db
			.prepare(
				`UPDATE inbound_provider_events SET status = 'dead', attempt_count = 5,
				 next_attempt_at = 1, lease_until = 2, last_error_code = 'rpc_unavailable',
				 processed_at = 3 WHERE id = 'event-admin-retry'`,
			)
			.run();
		const sendBatch = vi.fn().mockResolvedValue(undefined);

		await expect(
			retryPaymentProviderEvent(
				{
					DB: db,
					PAYMENT_QUEUE: { sendBatch } as unknown as Queue,
				},
				"event-admin-retry",
				10,
				{
					actorUserId: null,
					requestId: "request-admin-retry",
					ipAddress: "192.0.2.1",
				},
			),
		).resolves.toEqual({ id: "event-admin-retry", status: "queued" });
		expect(sendBatch).toHaveBeenCalledOnce();
		await expect(
			db
				.prepare(
					`SELECT status, attempt_count, next_attempt_at, lease_until,
					 last_error_code, processed_at, queued_at
					 FROM inbound_provider_events WHERE id = 'event-admin-retry'`,
				)
				.first(),
		).resolves.toEqual({
			status: "queued",
			attempt_count: 0,
			next_attempt_at: null,
			lease_until: null,
			last_error_code: null,
			processed_at: null,
			queued_at: 10,
		});
		await expect(
			db
				.prepare(
					`SELECT action, target_type, target_id, request_id, ip_address, after
					 FROM audit_logs WHERE target_id = 'event-admin-retry'`,
				)
				.first(),
		).resolves.toEqual({
			action: "payment_provider_event.retry_requested",
			target_type: "payment_provider_event",
			target_id: "event-admin-retry",
			request_id: "request-admin-retry",
			ip_address: "192.0.2.1",
			after: '{"status":"received"}',
		});
	});

	it("rejects manual retry for an event that is still queued", async () => {
		await insertEvent(
			db,
			"event-admin-not-retryable",
			"tx-admin-not-retryable",
		);

		await expect(
			retryPaymentProviderEvent(
				{
					DB: db,
					PAYMENT_QUEUE: { sendBatch: vi.fn() } as unknown as Queue,
				},
				"event-admin-not-retryable",
			),
		).rejects.toMatchObject({
			code: "payment_provider_event_not_retryable",
			status: 409,
		});
	});

	it("keeps the lease valid across eight sequential 30-second lookups", async () => {
		await resetOrder(db);
		await insertEvent(
			db,
			"event-long-lookup",
			"tx-long-lookup",
			false,
			"shadow",
		);
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		let calls = 0;
		mocks.createPaymentMethodAdapters.mockResolvedValue(
			Array.from({ length: 8 }, () => ({
				adapter: adapter((hash) => {
					calls += 1;
					now += 30_000;
					return calls === 8 ? transaction(hash) : null;
				}),
			})),
		);
		try {
			await handlePaymentProviderEvent(queueMessage("event-long-lookup"), {
				DB: db,
			} as Env);
			expect(calls).toBe(8);
			expect(await providerState(db, "event-long-lookup")).toMatchObject({
				event_status: "ignored",
				last_error_code: "shadow_matched",
				payments: 0,
			});
		} finally {
			clock.mockRestore();
		}
	});

	it("fences an expired lease before accounting even without a new owner", async () => {
		await resetOrder(db);
		await db
			.prepare("UPDATE payment_ingresses SET mode = 'active' WHERE id = ?")
			.bind(sourceId)
			.run();
		const id = "event-expired-owner";
		await insertEvent(db, id, "tx-expired-owner");
		mocks.createPaymentMethodAdapters.mockResolvedValue([
			{
				adapter: {
					...adapter(transaction),
					getTransaction: async (hash: string) => {
						await db
							.prepare(
								"UPDATE inbound_provider_events SET lease_until = ? WHERE id = ?",
							)
							.bind(Date.now() - 1, id)
							.run();
						return transaction(hash);
					},
				},
			},
		]);
		const message = queueMessage(id);
		await handlePaymentProviderEvent(message, { DB: db } as Env);
		expect(message.ack).toHaveBeenCalledOnce();
		expect(await providerState(db, id)).toMatchObject({
			event_status: "processing",
			order_status: "pending",
			payments: 0,
		});
		await recoverProviderEventOutbox({ DB: db });
		expect(await providerState(db, id)).toMatchObject({
			event_status: "failed",
			payments: 0,
		});
	});

	it.each(["payment", "mismatch", "error"] as const)(
		"fences a stale consumer's %s result after a new owner claims the event",
		async (result) => {
			await resetOrder(db);
			await db
				.prepare(
					"UPDATE payment_ingresses SET mode = 'active', health_status = 'healthy', last_error_code = NULL WHERE id = ?",
				)
				.bind(sourceId)
				.run();
			const id = `event-stale-${result}`;
			await insertEvent(db, id, `tx-stale-${result}`);
			mocks.createPaymentMethodAdapters.mockResolvedValue([
				{
					adapter: {
						...adapter(transaction),
						getTransaction: async (hash: string) => {
							await db
								.prepare(
									"UPDATE inbound_provider_events SET lease_token = 'new-owner', attempt_count = attempt_count + 1, lease_until = ? WHERE id = ?",
								)
								.bind(Date.now() + 300_000, id)
								.run();
							if (result === "error") throw new Error("Old provider failure");
							const tx = transaction(hash);
							return result === "mismatch"
								? { ...tx, to: "0x1111111111111111111111111111111111111111" }
								: tx;
						},
					},
				},
			]);
			const message = queueMessage(id);
			await handlePaymentProviderEvent(message, { DB: db } as Env);
			expect(message.ack).toHaveBeenCalledOnce();
			expect(
				await db
					.prepare(
						"SELECT status, lease_token, attempt_count FROM inbound_provider_events WHERE id = ?",
					)
					.bind(id)
					.first(),
			).toEqual({
				status: "processing",
				lease_token: "new-owner",
				attempt_count: 2,
			});
			expect(await providerState(db, id)).toMatchObject({
				order_status: "pending",
				payments: 0,
			});
			expect(
				await db
					.prepare(
						"SELECT health_status, last_error_code FROM payment_ingresses WHERE id = ?",
					)
					.bind(sourceId)
					.first(),
			).toEqual({ health_status: "healthy", last_error_code: null });
		},
	);
});

function adapter(
	getTransaction: (hash: string) => NormalizedTransaction | null,
): PaymentAdapter<unknown> {
	return {
		id: "evm",
		network: "ethereum",
		configSchema: {} as PaymentAdapter<unknown>["configSchema"],
		validateConfig: (value) => value,
		createPaymentTarget: async ({ address, expiresAt }) => ({
			address,
			expiresAt,
		}),
		getTransaction: async (hash) => getTransaction(hash),
		findTransactions: async () => [],
		validateAddress: () => true,
		validatePayment: () => true,
		getConfirmations: async () => 2,
		healthCheck: async () => ({
			healthy: true,
			latencyMs: 1,
			checkedAt: new Date(),
		}),
		classifyError: () => "permanent",
		isRetryable: () => false,
	};
}

function transaction(hash: string): NormalizedTransaction {
	return {
		network: "ethereum",
		hash,
		eventIndex: 110,
		from: "0x503828976d22510aad0201ac7ec88293211d23da",
		to: target,
		assetCode: "USDC",
		amountUnits: 10_000_000n,
		blockNumber: 100n,
		blockHash: "0xcanonical",
		confirmations: 2,
		timestamp: new Date(),
		success: true,
	};
}

function queueMessage(eventId: string) {
	return {
		id: `message-${eventId}`,
		timestamp: new Date(),
		attempts: 1,
		body: {
			kind: "payment.provider_event" as const,
			version: 1 as const,
			eventId,
		},
		ack: vi.fn(),
		retry: vi.fn(),
	};
}

async function seed(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('ethereum', 'Ethereum', 'chain', 'evm', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				`INSERT INTO payment_assets
				 (id, rail_code, code, symbol, kind, contract_address, decimals,
				  default_confirmations, created_at, updated_at)
				 VALUES ('asset-usdc', 'ethereum', 'USDC', 'USDC', 'token', ?, 6, 2, ?, ?)`,
			)
			.bind(contract, now, now),
		db
			.prepare(
				`INSERT INTO receiving_methods
				 (id, name, rail_code, target_type, target_value, normalized_target_value,
				  enabled, created_at, updated_at)
				 VALUES ('method-ethereum', 'Ethereum receiving', 'ethereum', 'address', ?, ?, 1, ?, ?)`,
			)
			.bind(storedTarget, target, now, now),
		db
			.prepare(
				`INSERT INTO orders
				 (id, external_order_id, status, amount_minor, currency, currency_decimals,
				  payment_asset_id, received_amount_units, expires_at, created_at, updated_at)
				 VALUES ('order-provider', 'merchant-provider', 'pending', '1000', 'USD', 2,
				  'asset-usdc', '0', ?, ?, ?)`,
			)
			.bind(now + 900_000, now, now),
		db
			.prepare(
				`INSERT INTO order_payment_snapshots
				 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
				  asset_id, asset_code, decimals, contract_address, target_value, adapter,
				  required_confirmations, expected_amount_units, created_at)
				 VALUES ('order-provider', 'method-ethereum', 'Ethereum receiving', 'ethereum',
				  'chain', 'asset-usdc', 'USDC', 6, ?, ?, 'evm', 2, '10000000', ?)`,
			)
			.bind(contract, storedTarget, now),
		db
			.prepare(
				`INSERT INTO receiving_method_locks
				 (id, receiving_method_id, asset_id, order_id, expected_amount_units,
				  collision_key, expires_at, reusable_at, created_at)
				 VALUES ('lock-provider', 'method-ethereum', 'asset-usdc', 'order-provider',
				  '10000000', 'method-ethereum:asset-usdc:10000000', ?, ?, ?)`,
			)
			.bind(now + 900_000, now + 86_400_000, now),
		db
			.prepare(
				`INSERT INTO payment_ingresses
				 (id, name, type, transport, provider, network, external_network, external_source_id, config_encrypted,
				  mode, enabled, created_at, updated_at)
				 VALUES (?, 'Payment event push', 'provider_webhook', 'webhook', 'alchemy', 'ethereum', 'ETH_MAINNET', 'wh-provider', 'encrypted',
				  'shadow', 1, ?, ?)`,
			)
			.bind(sourceId, now, now),
	]);
}

async function insertEvent(
	db: D1Database,
	id: string,
	transactionHash: string,
	removed = false,
	ingestMode: "shadow" | "active" = "active",
) {
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO inbound_provider_events
			 (id, source_id, provider_event_id, activity_index, network, event_type,
			  transaction_hash, event_index, payload_hash, trigger, ingest_mode, status, received_at,
			  created_at, updated_at)
			 VALUES (?, ?, ?, 0, 'ethereum', 'address_activity', ?, 110, 'hash', ?, ?,
			  'queued', ?, ?, ?)`,
		)
		.bind(
			id,
			sourceId,
			`provider-${id}`,
			transactionHash,
			JSON.stringify({
				transactionHash,
				eventIndex: 110,
				fromAddress: "0x503828976d22510aad0201ac7ec88293211d23da",
				toAddress: target,
				assetCode: "USDC",
				contractAddress: contract,
				blockNumber: "0x64",
				removed,
			}),
			ingestMode,
			now,
			now,
			now,
		)
		.run();
}

async function insertCompetingOrder(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`INSERT INTO orders
				 (id, external_order_id, status, amount_minor, currency, currency_decimals,
				  payment_asset_id, received_amount_units, expires_at, created_at, updated_at)
				 VALUES ('order-provider-competitor', 'merchant-provider-competitor',
				  'pending', '1001', 'USD', 2, 'asset-usdc', '0', ?, ?, ?)`,
			)
			.bind(now + 900_000, now, now),
		db
			.prepare(
				`INSERT INTO order_payment_snapshots
				 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
				  asset_id, asset_code, decimals, contract_address, target_value, adapter,
				  required_confirmations, expected_amount_units, created_at)
				 VALUES ('order-provider-competitor', 'method-ethereum', 'Ethereum receiving',
				  'ethereum', 'chain', 'asset-usdc', 'USDC', 6, ?, ?, 'evm', 2,
				  '10000001', ?)`,
			)
			.bind(contract, storedTarget, now),
		db
			.prepare(
				`INSERT INTO receiving_method_locks
				 (id, receiving_method_id, asset_id, order_id, expected_amount_units,
				  collision_key, expires_at, reusable_at, created_at)
				 VALUES ('lock-provider-competitor', 'method-ethereum', 'asset-usdc',
				  'order-provider-competitor', '10000001',
				  'method-ethereum:asset-usdc:10000001', ?, ?, ?)`,
			)
			.bind(now + 900_000, now + 86_400_000, now),
	]);
}

async function providerState(db: D1Database, eventId: string) {
	return db
		.prepare(`SELECT event.status AS event_status, event.last_error_code,
		 order_row.status AS order_status,
		 (SELECT COUNT(*) FROM order_payments WHERE order_id = order_row.id) AS payments
		 FROM inbound_provider_events event
		 CROSS JOIN orders order_row ON order_row.id = 'order-provider'
		 WHERE event.id = ?`)
		.bind(eventId)
		.first<{
			event_status: string;
			last_error_code: string | null;
			order_status: string;
			payments: number;
		}>();
}

async function resetOrder(db: D1Database) {
	await db.batch([
		db.prepare("DELETE FROM webhook_events WHERE order_id = 'order-provider'"),
		db.prepare("DELETE FROM blockchain_transactions"),
		db.prepare("DELETE FROM order_payments WHERE order_id = 'order-provider'"),
		db.prepare(
			"UPDATE orders SET status = 'pending', received_amount_units = '0', paid_at = NULL, version = version + 1 WHERE id = 'order-provider'",
		),
		db.prepare(
			"UPDATE receiving_method_locks SET released_at = NULL WHERE order_id = 'order-provider'",
		),
	]);
}
