import { describe, expect, it } from "vitest";
import { parseTelegramUpdate } from "#/features/telegram/server/update-schema";

describe("Telegram update boundary", () => {
	it("accepts the supported grammY update shapes", () => {
		const user = { id: 100, language_code: "zh-hans" };
		for (const update of [
			{
				update_id: 1,
				message: {
					chat: { id: 100, type: "private" },
					from: user,
					text: "/start",
				},
			},
			{
				update_id: 2,
				inline_query: { id: "inline", from: user, query: "10 USD" },
			},
			{
				update_id: 3,
				chosen_inline_result: {
					result_id: "create-payment",
					from: user,
					query: "new 10 USD USDT tron",
					inline_message_id: "inline-message-1",
				},
			},
			{
				update_id: 4,
				callback_query: { id: "callback", from: user, data: "check:order" },
			},
			{
				update_id: 5,
				my_chat_member: {
					chat: { id: -1001, type: "supergroup", title: "Operations" },
					from: user,
					date: 1,
					old_chat_member: { status: "left" },
					new_chat_member: { status: "member" },
				},
			},
		])
			expect(parseTelegramUpdate(update).success).toBe(true);
	});

	it.each([
		{},
		{
			update_id: -1,
			message: { chat: { id: 1, type: "private" }, text: "/start" },
		},
		{ update_id: 1 },
		{ update_id: 1, message: { chat: {}, text: "/start" } },
		{ update_id: 1, inline_query: { id: "inline", from: {}, query: "" } },
	])(
		"rejects malformed or unsupported updates without unsafe casts",
		(update) => {
			expect(parseTelegramUpdate(update).success).toBe(false);
		},
	);
});
