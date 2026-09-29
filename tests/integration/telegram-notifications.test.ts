import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { dispatchPaymentNotifications } from "#/features/payments/server/payment-events";
import { notifyTelegram } from "#/features/telegram/server/telegram";
import { encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const paidPayload = {
	externalOrderId: "merchant-1001",
	status: "paid",
	amount: "12.50",
	currency: "USD",
	payment: { amount: "12.50", asset: "USDT" },
};

const telegramOk = () => Response.json({ ok: true, result: {} });
const telegramRejection = (
	status: number,
	description: string,
	parameters?: { retry_after: number },
) =>
	Response.json(
		{
			ok: false,
			error_code: status,
			description,
			...(parameters ? { parameters } : {}),
		},
		{ status },
	);

describe("Telegram notification delivery", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-telegram-notifications" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	beforeEach(async () => {
		vi.unstubAllGlobals();
		await db.batch([
			db.prepare("DELETE FROM audit_logs"),
			db.prepare("UPDATE telegram_notification_bindings SET enabled = 1"),
		]);
	});

	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => miniflare.dispose());

	it("renders the template selected by each notification binding", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(() => Promise.resolve(telegramOk()));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			notifyTelegram(db, "order.paid", paidPayload),
		).resolves.toEqual({ delivered: 3, failed: 0 });

		const requests = fetchMock.mock.calls.map(([, init]) =>
			JSON.parse(String((init as RequestInit).body)),
		);
		expect(requests).toEqual(
			expect.arrayContaining([
				{
					chat_id: "1001",
					parse_mode: "Markdown",
					text: "已付款 merchant-1001 · 12.50 USDT",
				},
				{
					chat_id: "1002",
					parse_mode: "Markdown",
					text: "預設 paid · merchant-1001",
				},
			]),
		);
	});

	it("falls back to localized built-in labels when a binding has no template", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(() => Promise.resolve(telegramOk()));
		vi.stubGlobal("fetch", fetchMock);

		await notifyTelegram(db, "order.paid", paidPayload);

		const fallback = fetchMock.mock.calls
			.map(([, init]) => JSON.parse(String((init as RequestInit).body)))
			.find((body) => body.chat_id === "2001");
		expect(fallback).toEqual({
			chat_id: "2001",
			text: [
				"GMPay Edge · order.paid",
				"Заказ: merchant-1001",
				"Статус: paid",
				"Сумма: 12.50 USD",
				"Платёж: 12.50 USDT",
			].join("\n"),
		});
	});

	it("decrypts each Bot token once per fan-out", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(() => Promise.resolve(telegramOk())),
		);
		const decrypt = vi.spyOn(crypto.subtle, "decrypt");

		await expect(
			notifyTelegram(db, "order.paid", paidPayload),
		).resolves.toEqual({ delivered: 3, failed: 0 });
		expect(decrypt).toHaveBeenCalledTimes(2);
	});

	it("records the stable error code when Telegram cannot be reached", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementation(() =>
					Promise.resolve(new Response("bot token leaked", { status: 500 })),
				),
		);
		await expect(
			notifyTelegram(db, "order.paid", {
				externalOrderId: "merchant-secret-order",
				status: "paid",
			}),
		).resolves.toEqual({ delivered: 0, failed: 3 });

		const audits = await db
			.prepare("SELECT action, after FROM audit_logs ORDER BY target_id")
			.all<{ action: string; after: string }>();
		expect(audits.results).toHaveLength(3);
		for (const audit of audits.results) {
			expect(audit.action).toBe("telegram.delivery_failed");
			expect(JSON.parse(audit.after)).toEqual({
				eventType: "order.paid",
				errorCode: "telegram_transport_error",
			});
			expect(audit.after).not.toContain("merchant-secret-order");
			expect(audit.after).not.toContain("bot-token");
		}
	});

	it("honors flood control once and delivers after retry_after", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				telegramRejection(429, "Too Many Requests: retry after 2", {
					retry_after: 2,
				}),
			)
			.mockImplementation(() => Promise.resolve(telegramOk()));
		vi.stubGlobal("fetch", fetchMock);
		const delay = vi.fn().mockResolvedValue(undefined);

		await expect(
			notifyTelegram(db, "order.paid", paidPayload, { delay }),
		).resolves.toEqual({ delivered: 3, failed: 0 });
		expect(delay).toHaveBeenCalledTimes(1);
		expect(delay).toHaveBeenCalledWith(2_000);
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("gives up flood-control retries that cannot finish inside the delivery budget", async () => {
		const fetchMock = vi.fn().mockImplementation(() =>
			Promise.resolve(
				telegramRejection(429, "Too Many Requests: retry after 30", {
					retry_after: 30,
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const delay = vi.fn().mockResolvedValue(undefined);

		await expect(
			notifyTelegram(db, "order.paid", paidPayload, {
				delay,
				deadlineAt: Date.now() + 5_000,
			}),
		).resolves.toEqual({ delivered: 0, failed: 3 });
		expect(delay).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const audits = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action = 'telegram.delivery_failed'",
			)
			.all<{ after: string }>();
		expect(audits.results.map((audit) => JSON.parse(audit.after))).toEqual([
			{ eventType: "order.paid", errorCode: "telegram_api_rejected_429" },
			{ eventType: "order.paid", errorCode: "telegram_api_rejected_429" },
			{ eventType: "order.paid", errorCode: "telegram_api_rejected_429" },
		]);
	});

	it("re-sends an unparsable Markdown template as plain text", async () => {
		const fetchMock = vi.fn().mockImplementation((_url, init) => {
			const body = JSON.parse(String((init as RequestInit).body));
			return Promise.resolve(
				body.chat_id === "1001" && body.parse_mode
					? telegramRejection(
							400,
							"Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 3",
						)
					: telegramOk(),
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			notifyTelegram(db, "order.paid", paidPayload),
		).resolves.toEqual({ delivered: 3, failed: 0 });
		const bodies = fetchMock.mock.calls.map(([, init]) =>
			JSON.parse(String((init as RequestInit).body)),
		);
		expect(bodies).toHaveLength(4);
		expect(bodies.filter((body) => body.chat_id === "1001")).toEqual([
			{
				chat_id: "1001",
				parse_mode: "Markdown",
				text: "已付款 merchant-1001 · 12.50 USDT",
			},
			{ chat_id: "1001", text: "已付款 merchant-1001 · 12.50 USDT" },
		]);
	});

	it("disables a private binding that blocked the bot and audits it once", async () => {
		const fetchMock = vi.fn().mockImplementation((_url, init) => {
			const body = JSON.parse(String((init as RequestInit).body));
			return Promise.resolve(
				body.chat_id === "1001"
					? telegramRejection(403, "Forbidden: bot was blocked by the user")
					: telegramOk(),
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			notifyTelegram(db, "order.paid", paidPayload),
		).resolves.toEqual({ delivered: 2, failed: 1 });
		await expect(
			db
				.prepare(
					"SELECT enabled FROM telegram_notification_bindings WHERE id = 'target-cn'",
				)
				.first(),
		).resolves.toEqual({ enabled: 0 });
		const audits = await db
			.prepare(
				"SELECT action, target_id, after FROM audit_logs ORDER BY action",
			)
			.all<{ action: string; target_id: string; after: string }>();
		expect(
			audits.results.map((audit) => ({
				...audit,
				after: JSON.parse(audit.after),
			})),
		).toEqual([
			{
				action: "telegram.delivery_failed",
				target_id: "target-cn",
				after: {
					eventType: "order.paid",
					errorCode: "telegram_api_rejected_403",
				},
			},
			{
				action: "telegram_target.auto_disabled",
				target_id: "target-cn",
				after: { targetType: "private", reason: "blocked_by_user" },
			},
		]);

		await expect(
			notifyTelegram(db, "order.paid", paidPayload),
		).resolves.toEqual({ delivered: 2, failed: 0 });
		await expect(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'telegram_target.auto_disabled'",
				)
				.first<{ count: number }>(),
		).resolves.toEqual({ count: 1 });
	});

	it("dispatches Telegram through waitUntil without holding the caller", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchMock = vi.fn().mockImplementation(async () => {
			await gate;
			return telegramOk();
		});
		vi.stubGlobal("fetch", fetchMock);
		const background: Promise<unknown>[] = [];
		const send = vi.fn().mockResolvedValue(undefined);

		await dispatchPaymentNotifications(
			{
				DB: db,
				WEBHOOK_QUEUE: { send } as unknown as Queue,
				waitUntil: (promise) => {
					background.push(promise);
				},
			},
			"event-1",
			paidPayload,
			[
				{
					id: "delivery-1",
					endpoint: {
						id: "order-1",
						api_key_id: "key-1",
						url: "https://merchant.example/notify",
						secret_encrypted: "unused",
					},
				},
			],
			"order.paid",
		);

		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ deliveryId: "delivery-1", eventId: "event-1" }),
		);
		expect(background).toHaveLength(1);
		release();
		await Promise.all(background);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("awaits the Telegram fan-out inline when no waitUntil is available", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(() => Promise.resolve(telegramOk()));
		vi.stubGlobal("fetch", fetchMock);

		await dispatchPaymentNotifications(
			{ DB: db, WEBHOOK_QUEUE: { send: vi.fn() } as unknown as Queue },
			"event-2",
			paidPayload,
			[],
			"order.paid",
		);

		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});

async function seed(db: D1Database) {
	const now = Date.now();
	const pepper = "telegram-notification-test-pepper";
	const token = await encryptSecret(
		"100:test-bot-token-with-enough-length",
		pepper,
	);
	const secondToken = await encryptSecret(
		"200:second-bot-token-with-enough-length",
		pepper,
	);
	await db.batch([
		db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.integration_config_secret', ?, 1, ?, ?)",
			)
			.bind(JSON.stringify(pepper), now, now),
		db
			.prepare(
				"INSERT INTO telegram_bots (id, name, token_encrypted, webhook_secret_encrypted, enabled, created_at, updated_at) VALUES ('bot', 'Payments', ?, 'unused', 1, ?, ?)",
			)
			.bind(token, now, now),
		db
			.prepare(
				"INSERT INTO telegram_bots (id, name, token_encrypted, webhook_secret_encrypted, enabled, created_at, updated_at) VALUES ('bot-2', 'Alerts', ?, 'unused', 1, ?, ?)",
			)
			.bind(secondToken, now, now),
		db
			.prepare(
				"INSERT INTO telegram_notification_bindings (id, bot_id, template_translations, name, target_type, target_id, locale, events, enabled, created_at, updated_at) VALUES ('target-cn', 'bot', ?, 'CN operations', 'private', '1001', 'zh-CN', '[\"order.paid\"]', 1, ?, ?)",
			)
			.bind(
				JSON.stringify({
					"zh-CN":
						"已付款 {{externalOrderId}} · {{payment.amount}} {{payment.asset}}",
				}),
				now,
				now,
			),
		db
			.prepare(
				"INSERT INTO telegram_notification_bindings (id, bot_id, template_translations, name, target_type, target_id, locale, events, enabled, created_at, updated_at) VALUES ('target-tw', 'bot', ?, 'TW operations', 'group', '1002', 'zh-TW', '[\"order.paid\"]', 1, ?, ?)",
			)
			.bind(
				JSON.stringify({
					"zh-TW": "預設 {{status}} · {{externalOrderId}}",
				}),
				now,
				now,
			),
		db
			.prepare(
				"INSERT INTO telegram_notification_bindings (id, bot_id, template_translations, name, target_type, target_id, locale, events, enabled, created_at, updated_at) VALUES ('target-ru', 'bot-2', '{}', 'RU alerts', 'private', '2001', 'ru-RU', '[\"*\"]', 1, ?, ?)",
			)
			.bind(now, now),
	]);
}
