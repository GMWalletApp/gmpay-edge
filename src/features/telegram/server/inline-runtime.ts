import { z } from "zod";
import { orderIdPattern } from "#/features/orders/order-id";
import { createOrder } from "#/features/orders/server/create";
import type { PaymentScanMessage } from "#/features/payments/types";
import { defaultTelegramNotificationTranslations } from "#/features/telegram/defaults";
import {
	createTelegramApi,
	TelegramApiRequestError,
} from "#/features/telegram/server/client";
import {
	renderTelegramTemplate,
	telegramTemplateParseMode,
} from "#/features/telegram/template";
import { parseTelegramTemplateTranslations } from "#/features/telegram/template-translations";
import type { SupportedLocale } from "#/lib/locales";
import { unitsToDecimal } from "#/lib/money";
import { minorToDecimal } from "#/lib/units";
import { m } from "#/paraglide/messages";
import {
	parseStoredInlineOrder,
	type StoredInlineOrder,
} from "./inline-order-schema";
import {
	inlineOptionId,
	inlinePaymentOptions,
	parseInlineOptionId,
	parseTelegramCreateQuery,
	parseTelegramDraftQuery,
	selectedDraftInput,
} from "./inline-query";
import { parseTelegramSetting } from "./setting-schema";
import type { TelegramUpdateInput } from "./update-schema";

type TelegramLocale = SupportedLocale;
type TelegramUpdate = TelegramUpdateInput;
type TelegramMessage = NonNullable<TelegramUpdate["message"]>;
type TelegramInlineQuery = NonNullable<TelegramUpdate["inline_query"]>;
type TelegramChosenInlineResult = NonNullable<
	TelegramUpdate["chosen_inline_result"]
>;
type TelegramCallbackQuery = NonNullable<TelegramUpdate["callback_query"]>;
type TelegramChatMemberUpdated = NonNullable<TelegramUpdate["my_chat_member"]>;
type TelegramUser = TelegramInlineQuery["from"];
type TelegramChat = TelegramMessage["chat"];
type TelegramChatMember = TelegramChatMemberUpdated["new_chat_member"];

type OrderRow = {
	id: string;
	external_order_id: string;
	status: string;
	amount: string;
	currency: string;
	paymentAmount: string;
	asset_code: string;
	network: string;
	expires_at: number;
};

export type TelegramUpdateContext = {
	db: D1Database;
	botId: string;
	token: string;
	baseUrl: string;
	paymentQueue?: Queue<PaymentScanMessage>;
	update: TelegramUpdate;
};

export async function answerInlineQuery(
	context: TelegramUpdateContext,
	query: TelegramInlineQuery,
) {
	const createInput = parseTelegramCreateQuery(query.query);
	const draftInput = createInput ? null : parseTelegramDraftQuery(query.query);
	const locale = telegramLocale(query.from);
	if (createInput) {
		await telegramCall(context.token, "answerInlineQuery", {
			inline_query_id: query.id,
			cache_time: 0,
			is_personal: true,
			results: [
				{
					type: "article",
					id: "create-payment",
					title: m.telegram_inline_create_title(
						{ amount: createInput.amount, currency: createInput.currency },
						{ locale },
					),
					description: `${createInput.paymentAsset} · ${createInput.paymentNetwork}`,
					input_message_content: {
						message_text: m.telegram_inline_creating({}, { locale }),
					},
					reply_markup: inlinePendingKeyboard(locale),
				},
			],
		});
		return;
	}
	if (draftInput) {
		const matchingOrders = await findOrders(
			context.db,
			context.botId,
			String(query.from.id),
			query.query,
			10,
		);
		if (matchingOrders.length) {
			await answerOrderResults(context, query, locale, matchingOrders);
			return;
		}
		const options = await inlinePaymentOptions(context.db, draftInput);
		await telegramCall(context.token, "answerInlineQuery", {
			inline_query_id: query.id,
			cache_time: 0,
			is_personal: true,
			results: options.length
				? options.map((option) => ({
						type: "article",
						id: inlineOptionId(option.receivingMethodId),
						title: m.telegram_inline_create_title(
							{ amount: draftInput.amount, currency: draftInput.currency },
							{ locale },
						),
						description: `${option.amount} ${option.asset} · ${option.network.toUpperCase()}`,
						input_message_content: {
							message_text: m.telegram_inline_creating({}, { locale }),
						},
						reply_markup: inlinePendingKeyboard(locale),
					}))
				: [
						{
							type: "article",
							id: "payment-options-unavailable",
							title: m.telegram_no_payment_options({}, { locale }),
							description: m.telegram_no_payment_options_hint({}, { locale }),
							input_message_content: {
								message_text: m.telegram_no_payment_options({}, { locale }),
							},
						},
					],
		});
		return;
	}
	const orders = await findOrders(
		context.db,
		context.botId,
		String(query.from.id),
		query.query,
		10,
	);
	await answerOrderResults(context, query, locale, orders);
}

async function answerOrderResults(
	context: TelegramUpdateContext,
	query: TelegramInlineQuery,
	locale: TelegramLocale,
	orders: OrderRow[],
) {
	await telegramCall(context.token, "answerInlineQuery", {
		inline_query_id: query.id,
		cache_time: 0,
		is_personal: true,
		results: orders.map((order) => ({
			type: "article",
			id: order.id,
			title: `${order.external_order_id} · ${order.status}`,
			description: `${order.amount} ${order.currency} → ${order.paymentAmount} ${order.asset_code} (${order.network})`,
			input_message_content: {
				message_text: formatOrder(order, context.baseUrl, locale),
			},
			reply_markup: {
				inline_keyboard: [
					[
						{
							text: m.telegram_open_checkout({}, { locale }),
							url: checkoutUrl(context.baseUrl, order.id),
						},
						{
							text: m.telegram_check_payment({}, { locale }),
							callback_data: `check:${order.id}`,
						},
					],
				],
			},
		})),
	});
}

export async function createChosenInlineOrder(
	context: TelegramUpdateContext,
	chosen: TelegramChosenInlineResult,
) {
	const selection = parseInlineOptionId(chosen.result_id);
	if (chosen.result_id !== "create-payment" && !selection) return;
	const input = selection
		? selectedDraftInput(chosen.query, selection)
		: parseTelegramCreateQuery(chosen.query);
	if (!input) return;
	const telegramUserId = String(chosen.from.id);
	const locale = telegramLocale(chosen.from);
	const binding = await context.db
		.prepare(
			"SELECT id FROM telegram_notification_bindings WHERE bot_id = ? AND target_type = 'private' AND target_id = ? AND enabled = 1 LIMIT 1",
		)
		.bind(context.botId, telegramUserId)
		.first<{ id: string }>();
	if (!binding) {
		await deliverInlineMessage(
			context,
			chosen,
			m.telegram_account_unbound({}, { locale }),
		);
		return;
	}
	const replayKey = `telegram:${context.botId}:${context.update.update_id}`;
	const now = Date.now();
	const claim = await context.db
		.prepare(
			`INSERT INTO idempotency_keys
			 (id, key, request_hash, expires_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(key) DO NOTHING
			 RETURNING id`,
		)
		.bind(
			crypto.randomUUID(),
			replayKey,
			chosen.result_id,
			now + 7 * 24 * 60 * 60 * 1000,
			now,
			now,
		)
		.first<{ id: string }>();
	if (!claim) {
		const replay = await context.db
			.prepare(
				"SELECT response_status, response_body FROM idempotency_keys WHERE key = ? LIMIT 1",
			)
			.bind(replayKey)
			.first<{
				response_status: number | null;
				response_body: string | null;
			}>();
		if (replay?.response_status === 200 || !replay?.response_body) return;
		const order = parseStoredInlineOrder(replay.response_body);
		if (!order) return;
		await sendCreatedOrder(context, chosen, order, locale);
		await markInlineNotificationDelivered(context.db, replayKey);
		return;
	}
	try {
		const order = await createOrder(
			context.db,
			{
				...input,
				externalOrderId: `tg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
				metadata: { source: "telegram_inline", telegramUserId },
			},
			context.baseUrl,
		);
		await context.db
			.prepare(
				"UPDATE idempotency_keys SET response_status = 201, response_body = ?, updated_at = ? WHERE key = ?",
			)
			.bind(JSON.stringify(order), Date.now(), replayKey)
			.run();
		await context.db
			.prepare(
				"INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, after, created_at) VALUES (?, NULL, 'telegram.inline_order_created', 'order', ?, ?, ?)",
			)
			.bind(
				crypto.randomUUID(),
				order.orderId,
				JSON.stringify({ botId: context.botId, telegramUserId }),
				now,
			)
			.run();
		await sendCreatedOrder(context, chosen, order, locale);
		await markInlineNotificationDelivered(context.db, replayKey);
	} catch (error) {
		const stored = await context.db
			.prepare(
				"SELECT response_status FROM idempotency_keys WHERE key = ? LIMIT 1",
			)
			.bind(replayKey)
			.first<{ response_status: number | null }>();
		if (stored?.response_status === 201) throw error;
		await context.db
			.prepare("DELETE FROM idempotency_keys WHERE key = ?")
			.bind(replayKey)
			.run();
		await deliverInlineMessage(
			context,
			chosen,
			m.telegram_creation_failed({}, { locale }),
		);
	}
}

async function sendCreatedOrder(
	context: TelegramUpdateContext,
	chosen: TelegramChosenInlineResult,
	order: StoredInlineOrder,
	locale: TelegramLocale,
) {
	const paymentDue =
		order.paymentAmount && order.paymentAsset && order.paymentNetwork
			? m.telegram_payment_due(
					{
						amount: order.paymentAmount,
						asset: order.paymentAsset,
						network: order.paymentNetwork,
					},
					{ locale },
				)
			: null;
	const text = [
		m.telegram_payment_created(
			{ amount: order.amount, currency: order.currency },
			{ locale },
		),
		paymentDue,
		order.checkoutUrl,
	]
		.filter(Boolean)
		.join("\n");
	await deliverInlineMessage(context, chosen, text, {
		inline_keyboard: orderKeyboard(order.orderId, order.checkoutUrl, locale),
	});
}

async function deliverInlineMessage(
	context: TelegramUpdateContext,
	chosen: TelegramChosenInlineResult,
	text: string,
	replyMarkup?: { inline_keyboard: ReturnType<typeof orderKeyboard> },
) {
	await telegramCall(
		context.token,
		chosen.inline_message_id ? "editMessageText" : "sendMessage",
		{
			...(chosen.inline_message_id
				? { inline_message_id: chosen.inline_message_id }
				: { chat_id: chosen.from.id }),
			text,
			...(replyMarkup ? { reply_markup: replyMarkup } : {}),
		},
	);
}

async function markInlineNotificationDelivered(db: D1Database, key: string) {
	await db
		.prepare(
			"UPDATE idempotency_keys SET response_status = 200, updated_at = ? WHERE key = ?",
		)
		.bind(Date.now(), key)
		.run();
}

export async function answerMessage(
	context: TelegramUpdateContext,
	message: TelegramMessage,
) {
	const text = message.text?.trim() ?? "";
	const locale = telegramLocale(message.from);
	const commandMatch = text.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/i);
	if (!commandMatch) return;
	const commandName = commandMatch[1];
	if (!commandName) return;
	const command = await resolveBotCommand(
		context.db,
		commandName.toLowerCase(),
		message.chat.type === "private" ? "private" : "group",
	);
	if (!command) return;
	if (
		command.handler_type === "start" &&
		message.chat.type === "private" &&
		message.from
	)
		await registerTelegramUser(context, message.from);
	const template = findCommandTemplate(command.template_translations, locale);
	async function sendTemplate() {
		if (!template) return false;
		await telegramCall(context.token, "sendMessage", {
			chat_id: message.chat.id,
			parse_mode: telegramTemplateParseMode,
			text: renderTelegramTemplate(template, {}),
		});
		return true;
	}
	if (command.handler_type === "start" || command.handler_type === "help") {
		if (!(await sendTemplate()))
			await telegramCall(context.token, "sendMessage", {
				chat_id: message.chat.id,
				text: m.telegram_help({}, { locale }),
			});
		return;
	}
	if (command.handler_type === "new") {
		if (!(await sendTemplate()))
			await telegramCall(context.token, "sendMessage", {
				chat_id: message.chat.id,
				text: m.telegram_inline_new_hint({}, { locale }),
			});
		return;
	}
	if (command.handler_type === "template") {
		await sendTemplate();
		return;
	}
	if (command.handler_type !== "status") return;
	const search = commandMatch[2]?.trim();
	if (!search) {
		if (!(await sendTemplate()))
			await telegramCall(context.token, "sendMessage", {
				chat_id: message.chat.id,
				text: m.telegram_status_usage({}, { locale }),
			});
		return;
	}
	const orders = await findOrders(
		context.db,
		context.botId,
		String(message.from?.id ?? message.chat.id),
		search,
		5,
	);
	await telegramCall(context.token, "sendMessage", {
		chat_id: message.chat.id,
		text: orders.length
			? orders
					.map((order) => formatOrder(order, context.baseUrl, locale))
					.join("\n\n")
			: m.telegram_no_matching_order({}, { locale }),
	});
}

async function registerTelegramUser(
	context: TelegramUpdateContext,
	user: TelegramUser,
) {
	const now = Date.now();
	const telegramUserId = String(user.id);
	const defaults = await loadTelegramSubscriptionDefaults(context.db);
	await context.db
		.prepare(
			`INSERT INTO telegram_notification_bindings
			 (id, bot_id, template_translations, name, target_username, target_type, target_id, locale, events, enabled, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'private', ?, ?, ?, 0, ?, ?)
			 ON CONFLICT(bot_id, target_id) DO UPDATE SET
			 name = excluded.name, target_username = excluded.target_username,
			 updated_at = excluded.updated_at`,
		)
		.bind(
			crypto.randomUUID(),
			context.botId,
			JSON.stringify(defaults.templateTranslations),
			telegramUserName(user),
			user.username ?? null,
			telegramUserId,
			telegramLocale(user),
			JSON.stringify(defaults.events),
			now,
			now,
		)
		.run();
}

export async function updateTelegramTargetMembership(
	context: TelegramUpdateContext,
	member: TelegramChatMemberUpdated,
) {
	if (member.chat.type === "private") return;
	const targetType =
		member.chat.type === "channel" ? "channel" : ("group" as const);
	const targetId = String(member.chat.id);
	const now = Date.now();
	const current = await context.db
		.prepare(
			"SELECT id, enabled FROM telegram_notification_bindings WHERE bot_id = ? AND target_id = ? LIMIT 1",
		)
		.bind(context.botId, targetId)
		.first<{ id: string; enabled: number }>();
	if (!telegramMembershipIsActive(member.new_chat_member)) {
		if (!current?.enabled) return;
		await context.db.batch([
			context.db
				.prepare(
					"UPDATE telegram_notification_bindings SET enabled = 0, updated_at = ? WHERE id = ?",
				)
				.bind(now, current.id),
			telegramTargetLifecycleAudit(
				context.db,
				"telegram_target.auto_disabled",
				current.id,
				targetType,
				now,
			),
		]);
		return;
	}
	const defaults = await loadTelegramSubscriptionDefaults(context.db);
	await context.db
		.prepare(
			`INSERT INTO telegram_notification_bindings
			 (id, bot_id, template_translations, name, target_username, target_type, target_id, locale, events, enabled, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'en-US', ?, 0, ?, ?)
			 ON CONFLICT(bot_id, target_id) DO UPDATE SET
			 name = excluded.name, target_username = excluded.target_username,
			 target_type = excluded.target_type, updated_at = excluded.updated_at`,
		)
		.bind(
			crypto.randomUUID(),
			context.botId,
			JSON.stringify(defaults.templateTranslations),
			telegramChatName(member.chat),
			member.chat.username ?? null,
			targetType,
			targetId,
			JSON.stringify(defaults.events),
			now,
			now,
		)
		.run();
	if (!current) {
		const created = await context.db
			.prepare(
				"SELECT id FROM telegram_notification_bindings WHERE bot_id = ? AND target_id = ? LIMIT 1",
			)
			.bind(context.botId, targetId)
			.first<{ id: string }>();
		if (created)
			await telegramTargetLifecycleAudit(
				context.db,
				"telegram_target.discovered",
				created.id,
				targetType,
				now,
			).run();
	}
}

function telegramTargetLifecycleAudit(
	db: D1Database,
	action: string,
	targetId: string,
	targetType: "group" | "channel",
	now: number,
) {
	return db
		.prepare(
			"INSERT INTO audit_logs (id, action, target_type, target_id, after, created_at) VALUES (?, ?, 'telegram_notification_target', ?, ?, ?)",
		)
		.bind(
			crypto.randomUUID(),
			action,
			targetId,
			JSON.stringify({ targetType }),
			now,
		);
}

function telegramMembershipIsActive(member: TelegramChatMember) {
	return (
		member.status === "creator" ||
		member.status === "administrator" ||
		member.status === "member" ||
		(member.status === "restricted" && member.is_member === true)
	);
}

function telegramUserName(user: TelegramUser) {
	const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
	return fullName || (user.username ? `@${user.username}` : String(user.id));
}

function telegramChatName(chat: TelegramChat) {
	return chat.title || (chat.username ? `@${chat.username}` : String(chat.id));
}

async function loadTelegramSubscriptionDefaults(db: D1Database) {
	const rows = await db
		.prepare(
			"SELECT key, value FROM system_settings WHERE key IN ('telegram.default_events', 'telegram.default_template_translations')",
		)
		.all<{ key: string; value: string }>();
	const values = new Map(rows.results.map((row) => [row.key, row.value]));
	return {
		events: parseTelegramSetting(
			values.get("telegram.default_events"),
			z.array(z.string()).max(100),
			["*"],
		),
		templateTranslations: parseTelegramTemplateTranslations(
			parseTelegramSetting(
				values.get("telegram.default_template_translations"),
				z.record(z.string(), z.string()),
				defaultTelegramNotificationTranslations,
			),
		),
	};
}

async function resolveBotCommand(
	db: D1Database,
	command: string,
	scope: "private" | "group",
) {
	return db
		.prepare(
			`SELECT command, handler_type, template_translations FROM telegram_bot_commands
			 WHERE command = ? AND enabled = 1
			 AND scope IN (?, 'default')
			 ORDER BY CASE WHEN scope = ? THEN 0 ELSE 1 END LIMIT 1`,
		)
		.bind(command, scope, scope)
		.first<{
			command: string;
			handler_type: "start" | "help" | "new" | "status" | "template";
			template_translations: unknown;
		}>();
}

function findCommandTemplate(value: unknown, locale: TelegramLocale) {
	const translations = parseTelegramTemplateTranslations(value);
	return translations[locale] || translations["en-US"] || undefined;
}

export async function answerCallback(
	context: TelegramUpdateContext,
	callback: TelegramCallbackQuery,
) {
	const locale = telegramLocale(callback.from);
	if (callback.data === "inline:pending") {
		await telegramCall(context.token, "answerCallbackQuery", {
			callback_query_id: callback.id,
			text: m.telegram_inline_creating({}, { locale }),
		});
		return;
	}
	const match = callback.data?.match(
		new RegExp(`^(order|check):(${orderIdPattern.source.slice(1, -1)})$`, "i"),
	);
	if (!match) {
		await telegramCall(context.token, "answerCallbackQuery", {
			callback_query_id: callback.id,
			text: m.telegram_unsupported_action({}, { locale }),
		});
		return;
	}
	const [, action, orderId] = match;
	if (!(action && orderId)) return;
	const chatId = callback.message?.chat.id ?? callback.from.id;
	const [order] = await findOrders(
		context.db,
		context.botId,
		String(callback.from.id),
		orderId,
		1,
	);
	await telegramCall(context.token, "answerCallbackQuery", {
		callback_query_id: callback.id,
		text: order
			? m.telegram_status({ status: order.status }, { locale })
			: m.telegram_order_not_found({}, { locale }),
		show_alert: false,
	});
	if (order && action.toLowerCase() === "check")
		await enqueuePaymentCheck(context, order.id, callback.from.id, locale);
	if (order)
		await telegramCall(context.token, "sendMessage", {
			chat_id: chatId,
			text: formatOrder(order, context.baseUrl, locale),
			reply_markup: {
				inline_keyboard: [
					[
						{
							text: m.telegram_open_checkout({}, { locale }),
							url: checkoutUrl(context.baseUrl, order.id),
						},
						{
							text: m.telegram_check_payment({}, { locale }),
							callback_data: `check:${order.id}`,
						},
					],
				],
			},
		});
}

async function findOrders(
	db: D1Database,
	botId: string,
	telegramUserId: string,
	query: string,
	limit: number,
) {
	const normalized = query.trim();
	if (!normalized) return [];
	const search = `%${normalized.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
	const rows = await db
		.prepare(
			`SELECT o.id, o.external_order_id, o.status, o.amount_minor,
			 o.currency, o.currency_decimals, ops.expected_amount_units,
			 ops.decimals, ops.asset_code, ops.rail_code AS network,
			 o.expires_at
			 FROM telegram_notification_bindings tb
			 CROSS JOIN orders o
			 JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 WHERE tb.bot_id = ? AND tb.target_type = 'private'
			 AND tb.target_id = ? AND tb.enabled = 1
			 AND (o.id = ? OR o.external_order_id LIKE ? ESCAPE '\\')
			 ORDER BY o.created_at DESC LIMIT ?`,
		)
		.bind(botId, telegramUserId, normalized, search, limit)
		.all<
			Omit<OrderRow, "amount" | "paymentAmount"> & {
				amount_minor: string;
				currency_decimals: number;
				expected_amount_units: string;
				decimals: number;
			}
		>();
	return rows.results.map((row) => ({
		...row,
		amount: minorToDecimal(row.amount_minor, row.currency_decimals),
		paymentAmount: unitsToDecimal(
			BigInt(row.expected_amount_units),
			row.decimals,
		),
	}));
}

function formatOrder(order: OrderRow, baseUrl: string, locale: TelegramLocale) {
	return [
		`GMPay Edge · ${order.external_order_id}`,
		m.telegram_status({ status: order.status }, { locale }),
		m.telegram_order_amount(
			{ amount: order.amount, currency: order.currency },
			{ locale },
		),
		m.telegram_payment_due(
			{
				amount: order.paymentAmount,
				asset: order.asset_code,
				network: order.network,
			},
			{ locale },
		),
		m.telegram_expires(
			{ time: new Date(order.expires_at).toLocaleString(locale) },
			{ locale },
		),
		m.telegram_checkout({ url: checkoutUrl(baseUrl, order.id) }, { locale }),
	].join("\n");
}

async function enqueuePaymentCheck(
	context: TelegramUpdateContext,
	orderId: string,
	telegramUserId: number,
	locale: TelegramLocale,
) {
	if (!context.paymentQueue) return;
	const replayKey = `telegram:check:${context.botId}:${context.update.update_id}`;
	const now = Date.now();
	const claim = await context.db
		.prepare(
			`INSERT INTO idempotency_keys
			 (id, key, request_hash, expires_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(key) DO NOTHING
			 RETURNING id`,
		)
		.bind(
			crypto.randomUUID(),
			replayKey,
			orderId,
			now + 24 * 60 * 60 * 1000,
			now,
			now,
		)
		.first<{ id: string }>();
	if (!claim) return;
	const target = await context.db
		.prepare(
			`SELECT ops.receiving_method_id
			 FROM orders o
			 JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 WHERE o.id = ? AND o.status IN ('pending', 'confirming', 'partially_paid')
			 LIMIT 1`,
		)
		.bind(orderId)
		.first<{
			receiving_method_id: string;
		}>();
	if (!target) {
		await context.db
			.prepare("DELETE FROM idempotency_keys WHERE key = ?")
			.bind(replayKey)
			.run();
		return;
	}
	try {
		await context.paymentQueue.send({
			kind: "payment.scan",
			version: 1,
			orderId,
			receivingMethodId: target.receiving_method_id,
		});
		await context.db.batch([
			context.db
				.prepare(
					`INSERT INTO audit_logs
			 (id, action, target_type, target_id, after, created_at)
			 VALUES (?, 'telegram.payment_check_requested', 'order', ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					orderId,
					JSON.stringify({ botId: context.botId, telegramUserId }),
					now,
				),
			context.db
				.prepare(
					"UPDATE idempotency_keys SET response_status = 202, updated_at = ? WHERE key = ?",
				)
				.bind(now, replayKey),
		]);
	} catch (error) {
		await context.db
			.prepare("DELETE FROM idempotency_keys WHERE key = ?")
			.bind(replayKey)
			.run();
		throw error;
	}
	await telegramCall(context.token, "sendMessage", {
		chat_id: telegramUserId,
		text: m.telegram_check_queued({}, { locale }),
	});
}

function orderKeyboard(orderId: string, url: string, locale: TelegramLocale) {
	return [
		[
			{ text: m.telegram_open_checkout({}, { locale }), url },
			{
				text: m.telegram_check_payment({}, { locale }),
				callback_data: `check:${orderId}`,
			},
		],
	];
}

function inlinePendingKeyboard(locale: TelegramLocale) {
	return {
		inline_keyboard: [
			[
				{
					text: m.telegram_inline_creating({}, { locale }),
					callback_data: "inline:pending",
				},
			],
		],
	};
}

export function telegramLocale(user?: TelegramUser): TelegramLocale {
	const value = user?.language_code?.toLowerCase() ?? "";
	if (["zh-cn", "zh-hans", "zh-sg"].includes(value)) return "zh-CN";
	if (["zh-tw", "zh-hant", "zh-hk", "zh-mo"].includes(value)) return "zh-TW";
	if (value.startsWith("ja")) return "ja-JP";
	if (value.startsWith("ko")) return "ko-KR";
	if (value.startsWith("ru")) return "ru-RU";
	return "en-US";
}

function checkoutUrl(baseUrl: string, orderId: string) {
	return new URL(`/checkout/${orderId}`, baseUrl).toString();
}

async function telegramCall(
	token: string,
	method: string,
	body: Record<string, unknown>,
) {
	const raw = createTelegramApi(token).raw[
		method as keyof ReturnType<typeof createTelegramApi>["raw"]
	] as (
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<unknown>;
	try {
		await raw(body, AbortSignal.timeout(8_000));
	} catch (error) {
		throw new TelegramApiRequestError(error);
	}
}
