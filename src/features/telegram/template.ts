import { isRecord } from "#/lib/is-record";

export const telegramTemplateVariables = new Set([
	"orderId",
	"externalOrderId",
	"status",
	"amount",
	"currency",
	"payment.amount",
	"payment.asset",
	"payment.network",
]);

export const telegramTemplateParseMode = "Markdown" as const;

export function hasOnlySafeTelegramTemplateVariables(content: string) {
	return [...content.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].every((match) =>
		telegramTemplateVariables.has(match[1]?.trim() ?? ""),
	);
}

export function renderTelegramTemplate(
	template: string,
	payload: Record<string, unknown>,
) {
	const payment = isRecord(payload.payment) ? payload.payment : {};
	const values: Record<string, unknown> = {
		orderId: payload.orderId,
		externalOrderId: payload.externalOrderId,
		status: payload.status,
		amount: payload.amount,
		currency: payload.currency,
		"payment.amount": payment.amount,
		"payment.asset": payment.asset,
		"payment.network": payment.network,
	};
	return template.replace(
		/\{\{\s*([a-zA-Z.]+)\s*\}\}/g,
		(_match, key: string) =>
			telegramTemplateVariables.has(key)
				? escapeTelegramMarkdownValue(String(values[key] ?? "—"))
				: "",
	);
}

export function escapeTelegramMarkdownValue(value: string) {
	return value.replace(/([\\_*`[\]])/g, "\\$1");
}
