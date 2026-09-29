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
import {
	defaultTelegramNotificationTranslations,
	reconcileTelegramDefaults,
} from "#/features/telegram/defaults";
import { processTelegramUpdate } from "#/features/telegram/server/inline";
import { persistTelegramDeliveryFailures } from "#/features/telegram/server/telegram";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("Telegram Inline payment creation", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-telegram-inline-create" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await reconcileTelegramDefaults(db, Date.now());
		await seed(db);
	});

	afterEach(() => vi.unstubAllGlobals());
	afterAll(async () => miniflare.dispose());

	it("creates an order only after the user chooses the inline result", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
		vi.stubGlobal("fetch", fetchMock);

		await processTelegramUpdate({
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 10,
				chosen_inline_result: {
					result_id: "create-payment",
					from: { id: 12345 },
					query: "new 18.25 USD USDT tron Invoice 42",
					inline_message_id: "inline-message-10",
				},
			},
		});

		const order = await db
			.prepare(
				"SELECT id, amount_minor, currency, currency_decimals, description, metadata FROM orders LIMIT 1",
			)
			.first<{
				id: string;
				amount_minor: string;
				currency: string;
				currency_decimals: number;
				description: string;
				metadata: string;
			}>();
		expect(order).toMatchObject({
			amount_minor: "1825",
			currency: "USD",
			currency_decimals: 2,
			description: "Invoice 42",
		});
		expect(JSON.parse(order?.metadata ?? "{}")).toMatchObject({
			source: "telegram_inline",
			telegramUserId: "12345",
		});
		const snapshot = await db
			.prepare(
				"SELECT target_value FROM order_payment_snapshots WHERE order_id = ?",
			)
			.bind(order?.id)
			.first<{ target_value: string }>();
		expect(snapshot?.target_value).toBe("TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj");
		const audit = await db
			.prepare("SELECT action, target_id FROM audit_logs LIMIT 1")
			.first<{ action: string; target_id: string }>();
		expect(audit).toEqual({
			action: "telegram.inline_order_created",
			target_id: order?.id,
		});
		expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/editMessageText$/);
		const telegramBody = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
		);
		expect(telegramBody.inline_message_id).toBe("inline-message-10");
		expect(telegramBody.chat_id).toBeUndefined();
		expect(telegramBody.text).toContain(
			`https://pay.example/checkout/${order?.id}`,
		);

		await processTelegramUpdate({
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 10,
				chosen_inline_result: {
					result_id: "create-payment",
					from: { id: 12345 },
					query: "new 18.25 USD USDT tron Invoice 42",
				},
			},
		});
		const counts = await db
			.prepare(
				"SELECT (SELECT COUNT(*) FROM orders) AS orders_count, (SELECT COUNT(*) FROM audit_logs WHERE action = 'telegram.inline_order_created') AS audits_count",
			)
			.first<{ orders_count: number; audits_count: number }>();
		expect(counts).toEqual({ orders_count: 1, audits_count: 1 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries notification delivery without creating a second order", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("Telegram unavailable"))
			.mockResolvedValueOnce(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const input = {
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 11,
				chosen_inline_result: {
					result_id: "create-payment",
					from: { id: 12345 },
					query: "new 20 USD USDT tron Retry delivery",
				},
			},
		} as const;
		await expect(processTelegramUpdate(input)).rejects.toThrow(
			"Telegram Bot API request failed",
		);
		await expect(processTelegramUpdate(input)).resolves.toBeUndefined();
		const state = await db
			.prepare(`SELECT
				(SELECT COUNT(*) FROM orders) AS orders_count,
				(SELECT COUNT(*) FROM audit_logs WHERE action = 'telegram.inline_order_created') AS audits_count,
				(SELECT response_status FROM idempotency_keys WHERE key = 'telegram:bot-a:11') AS response_status`)
			.first<{
				orders_count: number;
				audits_count: number;
				response_status: number;
			}>();
		expect(state).toEqual({
			orders_count: 2,
			audits_count: 2,
			response_status: 200,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("atomically claims concurrent chosen results without parsing database errors", async () => {
		const before = await db
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM orders) AS orders_count,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'telegram.inline_order_created') AS audits_count`,
			)
			.first<{ orders_count: number; audits_count: number }>();
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const input = {
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 16,
				chosen_inline_result: {
					result_id: "create-payment",
					from: { id: 12345 },
					query: "new 21 USD USDT tron Concurrent delivery",
				},
			},
		} as const;

		await Promise.all([
			processTelegramUpdate(input),
			processTelegramUpdate(input),
		]);

		const after = await db
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM orders) AS orders_count,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'telegram.inline_order_created') AS audits_count,
				 (SELECT COUNT(*) FROM idempotency_keys WHERE key = 'telegram:bot-a:16') AS replay_count`,
			)
			.first<{
				orders_count: number;
				audits_count: number;
				replay_count: number;
			}>();
		expect(after).toEqual({
			orders_count: (before?.orders_count ?? 0) + 1,
			audits_count: (before?.audits_count ?? 0) + 1,
			replay_count: 1,
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("persists sanitized Telegram delivery failures for operations", async () => {
		await expect(
			persistTelegramDeliveryFailures(db, "order.paid", [
				{ targetId: "target-b", errorCode: "telegram_transport_error" },
			]),
		).resolves.toBe(1);
		const audit = await db
			.prepare(
				"SELECT target_id, after FROM audit_logs WHERE action = 'telegram.delivery_failed' ORDER BY created_at DESC LIMIT 1",
			)
			.first<{ target_id: string; after: string }>();
		expect(audit?.target_id).toBe("target-b");
		expect(JSON.parse(audit?.after ?? "{}")).toEqual({
			eventType: "order.paid",
			errorCode: "telegram_transport_error",
		});
		await expect(
			persistTelegramDeliveryFailures(db, "order.paid", []),
		).resolves.toBe(0);
	});

	it("re-sends an unparsable command template as plain text", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json(
					{
						ok: false,
						error_code: 400,
						description:
							"Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 1",
					},
					{ status: 400 },
				),
			)
			.mockResolvedValue(Response.json({ ok: true, result: {} }));
		vi.stubGlobal("fetch", fetchMock);

		await processTelegramUpdate({
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 40,
				message: {
					chat: { id: 60003, type: "private" },
					from: { id: 60003, language_code: "zh-cn" },
					text: "/help",
				},
			},
		});

		const bodies = fetchMock.mock.calls.map(([, init]) =>
			JSON.parse(String((init as RequestInit).body)),
		);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toMatchObject({ chat_id: 60003, parse_mode: "Markdown" });
		expect(bodies[1]).not.toHaveProperty("parse_mode");
		expect(bodies[1].text).toBe(bodies[0].text);
		expect(bodies[1].text).toContain("可用指令");
	});

	it("disables the private subscription once when the user has blocked the bot", async () => {
		const fetchMock = vi.fn().mockImplementation(() =>
			Promise.resolve(
				Response.json(
					{
						ok: false,
						error_code: 403,
						description: "Forbidden: bot was blocked by the user",
					},
					{ status: 403 },
				),
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const statusUpdate = (updateId: number) => ({
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: updateId,
				message: {
					chat: { id: 12345, type: "private" as const },
					from: { id: 12345 },
					text: "/status nothing-here",
				},
			},
		});
		try {
			await expect(
				processTelegramUpdate(statusUpdate(41)),
			).rejects.toMatchObject({
				code: "api_rejected",
				status: 403,
				rejection: "blocked_by_user",
			});
			await expect(
				processTelegramUpdate(statusUpdate(42)),
			).rejects.toMatchObject({ status: 403 });
			const binding = await db
				.prepare(
					"SELECT enabled FROM telegram_notification_bindings WHERE bot_id = 'bot-a' AND target_id = '12345'",
				)
				.first();
			expect(binding).toEqual({ enabled: 0 });
			const audits = await db
				.prepare(
					"SELECT after FROM audit_logs WHERE action = 'telegram_target.auto_disabled' AND target_id = '11111111-1111-4111-8111-111111111112'",
				)
				.all<{ after: string }>();
			expect(audits.results.map((audit) => JSON.parse(audit.after))).toEqual([
				{ targetType: "private", reason: "blocked_by_user" },
			]);
		} finally {
			await db
				.prepare(
					"UPDATE telegram_notification_bindings SET enabled = 1 WHERE bot_id = 'bot-a' AND target_id = '12345'",
				)
				.run();
		}
	});

	it("disables a private subscription when my_chat_member reports the user blocked the bot", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const membership = (updateId: number, status: string) => ({
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: updateId,
				my_chat_member: {
					chat: { id: 12345, type: "private" as const },
					from: { id: 12345 },
					date: 1,
					old_chat_member: {
						status: status === "kicked" ? "member" : "kicked",
					},
					new_chat_member: { status },
				},
			},
		});
		try {
			await processTelegramUpdate(membership(43, "kicked"));
			await processTelegramUpdate(membership(44, "member"));
			const binding = await db
				.prepare(
					"SELECT enabled FROM telegram_notification_bindings WHERE bot_id = 'bot-a' AND target_id = '12345'",
				)
				.first();
			expect(binding).toEqual({ enabled: 0 });
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			await db
				.prepare(
					"UPDATE telegram_notification_bindings SET enabled = 1 WHERE bot_id = 'bot-a' AND target_id = '12345'",
				)
				.run();
		}
	});

	it("queues an immediate provider check from a localized bound callback", async () => {
		const order = await db
			.prepare("SELECT id FROM orders ORDER BY created_at ASC LIMIT 1")
			.first<{ id: string }>();
		expect(order).toBeTruthy();
		await db
			.prepare(
				`INSERT OR IGNORE INTO order_payment_snapshots
				 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
				  asset_id, asset_code, decimals, target_value, connection_id, adapter,
				  required_confirmations, expected_amount_units, created_at)
				 VALUES (?, '11111111-1111-4111-8111-111111111111', 'TRON USDT', 'tron', 'chain',
				  'asset-a', 'USDT', 6, 'TAddress', 'connection-a', 'tron', 1, '18250000', ?)`,
			)
			.bind(order?.id, Date.now())
			.run();
		const send = vi.fn().mockResolvedValue(undefined);
		const fetchMock = vi
			.fn()
			.mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
		vi.stubGlobal("fetch", fetchMock);
		const input = {
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			paymentQueue: { send } as unknown as Queue,
			update: {
				update_id: 13,
				callback_query: {
					id: "callback-check",
					from: { id: 12345, language_code: "zh-CN" },
					data: `check:${order?.id}`,
					message: { chat: { id: 12345, type: "private" } },
				},
			},
		} as const;
		await Promise.all([
			processTelegramUpdate(input),
			processTelegramUpdate(input),
		]);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				orderId: order?.id,
				receivingMethodId: "11111111-1111-4111-8111-111111111111",
			}),
		);
		const calls = fetchMock.mock.calls.map(([, init]) =>
			JSON.parse(String((init as RequestInit).body)),
		);
		expect(
			calls.some((body) => String(body.text).includes("付款校验已加入队列")),
		).toBe(true);
		const audit = await db
			.prepare(
				"SELECT action, after FROM audit_logs WHERE action = 'telegram.payment_check_requested' ORDER BY created_at DESC LIMIT 1",
			)
			.first<{ action: string; after: string }>();
		expect(audit?.action).toBe("telegram.payment_check_requested");
		expect(JSON.parse(audit?.after ?? "{}")).toEqual({
			botId: "bot-a",
			telegramUserId: 12345,
		});
	});

	it("does not queue a payment check for an unbound Telegram user", async () => {
		const order = await db
			.prepare("SELECT id FROM orders ORDER BY created_at ASC LIMIT 1")
			.first<{ id: string }>();
		const send = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ ok: true })),
		);
		await processTelegramUpdate({
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			paymentQueue: { send } as unknown as Queue,
			update: {
				update_id: 14,
				callback_query: {
					id: "callback-unbound",
					from: { id: 99999 },
					data: `check:${order?.id}`,
				},
			},
		});
		expect(send).not.toHaveBeenCalled();
	});

	it("creates the selected asset/network only after an amount-only result is chosen", async () => {
		const before = await db
			.prepare("SELECT COUNT(*) AS count FROM orders")
			.first<{ count: number }>();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementation(() => Promise.resolve(Response.json({ ok: true }))),
		);
		await processTelegramUpdate({
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 17,
				chosen_inline_result: {
					result_id: "create-payment:11111111-1111-4111-8111-111111111111",
					from: { id: 12345 },
					query: "17 USD",
				},
			},
		});
		const created = await db
			.prepare(
				"SELECT o.amount_minor, o.currency, o.currency_decimals, a.code, a.rail_code FROM orders o JOIN payment_assets a ON a.id = o.payment_asset_id ORDER BY o.created_at DESC LIMIT 1",
			)
			.first<Record<string, string>>();
		expect(created).toEqual({
			amount_minor: "1700",
			currency: "USD",
			currency_decimals: 2,
			code: "USDT",
			rail_code: "tron",
		});
		const after = await db
			.prepare("SELECT COUNT(*) AS count FROM orders")
			.first<{ count: number }>();
		expect(after?.count).toBe((before?.count ?? 0) + 1);
	});

	it("does not authorize a different Telegram user through the same bot", async () => {
		const before = await db
			.prepare("SELECT COUNT(*) AS count FROM orders")
			.first<{ count: number }>();
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		await processTelegramUpdate({
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 12,
				chosen_inline_result: {
					result_id: "create-payment",
					from: { id: 99999 },
					query: "new 1 USD USDT tron Unauthorized",
				},
			},
		});
		const after = await db
			.prepare("SELECT COUNT(*) AS count FROM orders")
			.first<{ count: number }>();
		expect(after?.count).toBe(before?.count);
		expect(fetchMock).toHaveBeenCalledOnce();
		const body = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
		);
		expect(body.text).toContain("not bound");
		const replay = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = 'telegram:bot-a:12'",
			)
			.first<{ count: number }>();
		expect(replay?.count).toBe(0);
	});

	it("executes all four public commands from the shared localized catalog", async () => {
		const fetchMock = vi.fn().mockImplementation(() =>
			Promise.resolve(
				Response.json({
					ok: true,
					result: {
						message_id: 1,
						date: 0,
						chat: { id: 60001, type: "private" },
						text: "sent",
					},
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		for (const [index, command] of ["start", "help", "new", "status"].entries())
			await processTelegramUpdate({
				db,
				botId: "bot-a",
				token: "bot-token",
				baseUrl: "https://pay.example",
				update: {
					update_id: 60 + index,
					message: {
						chat: { id: 60001, type: "private" },
						from: { id: 60001, language_code: "zh-cn" },
						text: `/${command}`,
					},
				},
			});
		const bodies = fetchMock.mock.calls.map(([, init]) =>
			JSON.parse(String((init as RequestInit).body)),
		);
		expect(bodies).toHaveLength(4);
		expect(bodies.every((body) => body.parse_mode === "Markdown")).toBe(true);
		expect(bodies.map((body) => body.text)).toEqual([
			expect.stringContaining("欢迎使用 GMPay Edge"),
			expect.stringContaining("可用指令"),
			expect.stringContaining("创建订单"),
			expect.stringContaining("查询订单"),
		]);
	});

	it("does not register /start when the public command is disabled", async () => {
		await db
			.prepare(
				"UPDATE telegram_bot_commands SET enabled = 0 WHERE command = 'start' AND scope = 'default'",
			)
			.run();
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const counters = createDatastoreCounters();
		try {
			await processTelegramUpdate({
				db: instrumentD1(db, counters),
				botId: "bot-a",
				token: "bot-token",
				baseUrl: "https://pay.example",
				update: {
					update_id: 70,
					message: {
						chat: { id: 60002, type: "private" },
						from: { id: 60002 },
						text: "/start",
					},
				},
			});
			const target = await db
				.prepare(
					"SELECT id FROM telegram_notification_bindings WHERE bot_id = 'bot-a' AND target_id = '60002'",
				)
				.first();
			expect(target).toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
			expect(counters).toMatchObject({
				d1Prepare: 1,
				d1StatementBind: 1,
				d1StatementFirst: 1,
				d1StatementAll: 0,
				d1StatementRun: 0,
				d1Batch: 0,
			});
		} finally {
			await db
				.prepare(
					"UPDATE telegram_bot_commands SET enabled = 1 WHERE command = 'start' AND scope = 'default'",
				)
				.run();
		}
	});

	it("creates a pending private target on /start and requires admin enablement", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve(Response.json({ ok: true, result: {} })),
				),
		);
		const input = {
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 80,
				message: {
					chat: { id: 54321, type: "private" as const },
					from: {
						id: 54321,
						language_code: "zh-cn",
						username: "payer",
					},
					text: "/start",
				},
			},
		};
		await Promise.all([
			processTelegramUpdate(input),
			processTelegramUpdate({
				...input,
				update: { ...input.update, update_id: 81 },
			}),
		]);
		const target = await db
			.prepare(
				"SELECT name, target_username, template_translations, target_type, locale, events, enabled, COUNT(*) AS count FROM telegram_notification_bindings WHERE bot_id = 'bot-a' AND target_id = '54321'",
			)
			.first<{
				name: string;
				target_username: string;
				template_translations: string;
				target_type: string;
				locale: string;
				events: string;
				enabled: number;
				count: number;
			}>();
		expect(target).toMatchObject({
			name: "@payer",
			target_username: "payer",
			target_type: "private",
			locale: "zh-CN",
			enabled: 0,
			count: 1,
		});
		expect(JSON.parse(target?.template_translations ?? "{}")).toEqual(
			defaultTelegramNotificationTranslations,
		);
		expect(JSON.parse(target?.events ?? "[]")).toEqual(["*"]);
		const before = await db
			.prepare("SELECT COUNT(*) AS count FROM orders")
			.first<{ count: number }>();
		await processTelegramUpdate({
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 82,
				chosen_inline_result: {
					result_id: "create-payment",
					from: { id: 54321 },
					query: "new 1 USD USDT tron Pending",
				},
			},
		});
		const after = await db
			.prepare("SELECT COUNT(*) AS count FROM orders")
			.first<{ count: number }>();
		expect(after?.count).toBe(before?.count);
	});

	it("discovers group targets and disables them when the bot leaves", async () => {
		const memberUpdate = {
			db,
			botId: "bot-a",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 90,
				my_chat_member: {
					chat: {
						id: -100123,
						type: "supergroup" as const,
						title: "Operations",
						username: "ops_group",
					},
					from: { id: 54321 },
					date: 1,
					old_chat_member: { status: "left" },
					new_chat_member: { status: "member" },
				},
			},
		};
		await processTelegramUpdate(memberUpdate);
		const discovered = await db
			.prepare(
				"SELECT name, target_username, target_type, enabled FROM telegram_notification_bindings WHERE bot_id = 'bot-a' AND target_id = '-100123'",
			)
			.first();
		expect(discovered).toEqual({
			name: "Operations",
			target_username: "ops_group",
			target_type: "group",
			enabled: 0,
		});
		await db
			.prepare(
				"UPDATE telegram_notification_bindings SET enabled = 1 WHERE bot_id = 'bot-a' AND target_id = '-100123'",
			)
			.run();
		await processTelegramUpdate({
			...memberUpdate,
			update: {
				...memberUpdate.update,
				update_id: 91,
				my_chat_member: {
					...memberUpdate.update.my_chat_member,
					old_chat_member: { status: "member" },
					new_chat_member: { status: "left" },
				},
			},
		});
		const removed = await db
			.prepare(
				"SELECT enabled FROM telegram_notification_bindings WHERE bot_id = 'bot-a' AND target_id = '-100123'",
			)
			.first();
		expect(removed).toEqual({ enabled: 0 });
	});
});

async function seed(db: D1Database) {
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
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, priority, enabled, health_status, created_at, updated_at) VALUES ('connection-a', 'tron', 'TRON', 'rpc', 'https://api.trongrid.io', 10, 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, contract_address, created_at, updated_at) VALUES ('asset-a', 'tron', 'USDT', 'USDT', 'token', 6, 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 1, created_at = ?, updated_at = ? WHERE id = 'asset-a'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 'TRON USDT', 'tron', 'address', 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', 1, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO telegram_bots (id, name, token_encrypted, webhook_secret_encrypted, enabled, created_at, updated_at) VALUES ('bot-a', 'Bot', 'token', 'secret', 1, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO telegram_notification_bindings (id, bot_id, template_translations, name, target_type, target_id, locale, events, enabled, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111112', 'bot-a', ?, 'Payer', 'private', '12345', 'en-US', '[]', 1, ?, ?)",
			)
			.bind(JSON.stringify(defaultTelegramNotificationTranslations), now, now),
	]);
}
