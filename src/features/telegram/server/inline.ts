import {
	answerCallback,
	answerInlineQuery,
	answerMessage,
	createChosenInlineOrder,
	type TelegramUpdateContext,
	updateTelegramTargetMembership,
} from "./inline-runtime";

export {
	parseTelegramCreateQuery,
	parseTelegramDraftQuery,
} from "./inline-query";
export { telegramLocale } from "./inline-runtime";

export async function processTelegramUpdate(input: TelegramUpdateContext) {
	if (input.update.my_chat_member)
		return updateTelegramTargetMembership(input, input.update.my_chat_member);
	if (input.update.chosen_inline_result)
		return createChosenInlineOrder(input, input.update.chosen_inline_result);
	if (input.update.inline_query)
		return answerInlineQuery(input, input.update.inline_query);
	if (input.update.callback_query)
		return answerCallback(input, input.update.callback_query);
	if (input.update.message) return answerMessage(input, input.update.message);
}
