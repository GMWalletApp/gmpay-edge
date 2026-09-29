import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseTelegramCreateQuery,
	parseTelegramDraftQuery,
	processTelegramUpdate,
	telegramLocale,
} from "#/features/telegram/server/inline";

describe("Telegram inline integration", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("answers personal inline order searches with checkout actions", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const db = database([
			{
				id: "11111111-1111-4111-8111-111111111111",
				external_order_id: "merchant-1001",
				status: "pending",
				amount_minor: "1250",
				currency: "USD",
				currency_decimals: 2,
				expected_amount_units: "12500000",
				decimals: 6,
				asset_code: "USDT",
				network: "tron",
				expires_at: 1_900_000_000_000,
			},
		]);

		await processTelegramUpdate({
			db,
			botId: "22222222-2222-4222-8222-222222222222",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 1,
				inline_query: { id: "inline-1", from: { id: 12345 }, query: "1001" },
			},
		});

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toMatch(/\/answerInlineQuery$/);
		const body = JSON.parse(String(init.body));
		expect(body).toMatchObject({
			inline_query_id: "inline-1",
			cache_time: 0,
			is_personal: true,
		});
		expect(body.results[0].reply_markup.inline_keyboard[0][0].url).toBe(
			"https://pay.example/checkout/11111111-1111-4111-8111-111111111111",
		);
		expect(db.bindings).toEqual([
			"22222222-2222-4222-8222-222222222222",
			"12345",
			"1001",
			"%1001%",
			10,
		]);
	});

	it("maps Telegram language codes to every supported application locale", () => {
		expect(telegramLocale({ id: 1, language_code: "en" })).toBe("en-US");
		expect(telegramLocale({ id: 1, language_code: "ja" })).toBe("ja-JP");
		expect(telegramLocale({ id: 1, language_code: "ko-KR" })).toBe("ko-KR");
		expect(telegramLocale({ id: 1, language_code: "ru" })).toBe("ru-RU");
		expect(telegramLocale({ id: 1, language_code: "zh-hant" })).toBe("zh-TW");
		expect(telegramLocale({ id: 1, language_code: "zh-hans" })).toBe("zh-CN");
	});

	it("returns no order details for an unbound user", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const db = database([]);

		await processTelegramUpdate({
			db,
			botId: "22222222-2222-4222-8222-222222222222",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 2,
				message: {
					chat: { id: 999, type: "private" },
					from: { id: 999 },
					text: "/status merchant-1001",
				},
			},
		});

		const body = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
		);
		expect(body.text).toContain("No matching order");
	});

	it("parses and normalizes inline payment creation commands", () => {
		expect(
			parseTelegramCreateQuery("new 12.50 usd usdt TRON Invoice 42"),
		).toMatchObject({
			amount: "12.50",
			currency: "USD",
			paymentAsset: "USDT",
			paymentNetwork: "tron",
			description: "Invoice 42",
		});
		expect(parseTelegramCreateQuery("new -1 USD USDT tron")).toBeNull();
		expect(
			parseTelegramCreateQuery("new 1.000000000 USD USDT tron"),
		).toBeNull();
	});

	it("parses HashPay-style amount-only drafts without selecting a channel", () => {
		expect(parseTelegramDraftQuery("20")).toEqual({
			amount: "20",
			currency: "USD",
		});
		expect(parseTelegramDraftQuery("20 cny")).toEqual({
			amount: "20",
			currency: "CNY",
		});
		expect(parseTelegramDraftQuery("merchant-20")).toBeNull();
	});

	it("returns one quoted inline result per available asset and network", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const rows = [
			{
				receiving_method_id: "11111111-1111-4111-8111-111111111111",
				code: "USDC",
				decimals: 6,
				network: "base",
			},
			{
				receiving_method_id: "22222222-2222-4222-8222-222222222222",
				code: "USDT",
				decimals: 6,
				network: "tron",
			},
		];
		const db = {
			prepare: vi.fn((sql: string) =>
				sql.includes("FROM receiving_methods")
					? { all: async () => ({ results: rows }) }
					: sql.includes("FROM exchange_rates")
						? { bind: () => ({ first: async () => null }) }
						: sql.includes("FROM telegram_bot_commands")
							? { bind: () => ({ first: async () => null }) }
							: sql.includes("FROM telegram_notification_bindings")
								? bindingGate
								: { bind: () => ({ first: async () => null }) },
			),
		} as unknown as D1Database;
		await processTelegramUpdate({
			db,
			botId: "22222222-2222-4222-8222-222222222222",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 31,
				inline_query: {
					id: "amount-options",
					from: { id: 12345 },
					query: "20 USD",
				},
			},
		});
		const body = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
		);
		expect(body.results.map((result: { id: string }) => result.id)).toEqual([
			"create-payment:11111111-1111-4111-8111-111111111111",
			"create-payment:22222222-2222-4222-8222-222222222222",
		]);
		expect(body.results[0].description).toBe("20 USDC · BASE");
	});

	it("quotes each asset pair once across receiving methods", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const rows = [
			{
				receiving_method_id: "11111111-1111-4111-8111-111111111111",
				code: "TRX",
				decimals: 6,
				network: "tron",
			},
			{
				receiving_method_id: "22222222-2222-4222-8222-222222222222",
				code: "TRX",
				decimals: 6,
				network: "tron",
			},
			{
				receiving_method_id: "33333333-3333-4333-8333-333333333333",
				code: "USDT",
				decimals: 6,
				network: "tron",
			},
		];
		const prepare = vi.fn((sql: string) =>
			sql.includes("FROM receiving_methods")
				? { all: async () => ({ results: rows }) }
				: sql.includes("FROM exchange_rates")
					? {
							bind: () => ({
								all: async () => ({
									results: [
										{
											base: "TRX",
											quote: "USDT",
											raw_rate: "0.25",
											rate: "0.25",
											source: "manual",
											adjustment_bps: 0,
											observed_at: 1,
										},
									],
								}),
							}),
						}
					: bindingGate,
		);
		await processTelegramUpdate({
			db: { prepare } as unknown as D1Database,
			botId: "22222222-2222-4222-8222-222222222222",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 33,
				inline_query: { id: "dedupe", from: { id: 12345 }, query: "20 USD" },
			},
		});
		const body = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
		);
		expect(
			body.results.map((result: { description: string }) => result.description),
		).toEqual(["80 TRX · TRON", "80 TRX · TRON", "20 USDT · TRON"]);
		expect(
			prepare.mock.calls.filter(([sql]) => sql.includes("FROM exchange_rates")),
		).toHaveLength(1);
	});

	it("answers unbound users with the binding hint instead of quotes", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const db = database([], false);

		await processTelegramUpdate({
			db,
			botId: "22222222-2222-4222-8222-222222222222",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 34,
				inline_query: { id: "unbound", from: { id: 99999 }, query: "20 USD" },
			},
		});

		const body = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
		);
		expect(body.results).toHaveLength(1);
		expect(body.results[0]).toMatchObject({
			id: "account-unbound",
			input_message_content: {
				message_text: expect.stringContaining("not bound"),
			},
		});
		expect(db.prepare).toHaveBeenCalledTimes(1);
		expect(db.bindings).toEqual([
			"22222222-2222-4222-8222-222222222222",
			"99999",
		]);
	});

	it("returns an explanatory result when no funded payment option exists", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const db = {
			prepare: vi.fn((sql: string) =>
				sql.includes("FROM telegram_notification_bindings")
					? bindingGate
					: { all: async () => ({ results: [] }) },
			),
		} as unknown as D1Database;
		await processTelegramUpdate({
			db,
			botId: "22222222-2222-4222-8222-222222222222",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 32,
				inline_query: { id: "no-options", from: { id: 12345 }, query: "7 USD" },
			},
		});
		const body = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
		);
		expect(body.results).toHaveLength(1);
		expect(body.results[0].id).toBe("payment-options-unavailable");
	});

	it("returns a draft result without creating an order while typing", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const db = database([]);

		await processTelegramUpdate({
			db,
			botId: "22222222-2222-4222-8222-222222222222",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 3,
				inline_query: {
					id: "inline-create",
					from: { id: 12345 },
					query: "new 10 USD USDT tron",
				},
			},
		});

		const body = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
		);
		expect(body.results).toHaveLength(1);
		expect(body.results[0]).toMatchObject({
			id: "create-payment",
			type: "article",
			reply_markup: {
				inline_keyboard: [
					[
						{
							callback_data: "inline:pending",
						},
					],
				],
			},
		});
		// Only the binding gate touches D1; no receiving method or order query.
		expect(db.prepare).toHaveBeenCalledTimes(1);
		expect(vi.mocked(db.prepare).mock.calls[0]?.[0]).toContain(
			"FROM telegram_notification_bindings",
		);
	});

	it("acknowledges the temporary inline keyboard while order creation is pending", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const db = database([]);

		await processTelegramUpdate({
			db,
			botId: "22222222-2222-4222-8222-222222222222",
			token: "bot-token",
			baseUrl: "https://pay.example",
			update: {
				update_id: 4,
				callback_query: {
					id: "inline-pending",
					from: { id: 12345 },
					data: "inline:pending",
				},
			},
		});

		expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
			/\/answerCallbackQuery$/,
		);
		const body = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
		);
		expect(body).toMatchObject({
			callback_query_id: "inline-pending",
			text: expect.any(String),
		});
		expect(db.prepare).not.toHaveBeenCalled();
	});
});

function database(rows: unknown[], bound = true) {
	const state = {
		bindings: [] as unknown[],
		prepare: vi.fn((sql: string) => ({
			bind: (...values: unknown[]) => {
				state.bindings = values;
				return {
					first: async () =>
						sql.includes("FROM telegram_bot_commands")
							? {
									command: "status",
									handler_type: "status",
									template_translations: {},
								}
							: sql.includes("FROM telegram_notification_bindings") && bound
								? { id: "binding" }
								: null,
					all: async () => ({ results: rows }),
				};
			},
		})),
	};
	return state as unknown as D1Database & { bindings: unknown[] };
}

const bindingGate = {
	bind: () => ({
		first: async () => ({ id: "binding" }),
		all: async () => ({ results: [] }),
	}),
};
