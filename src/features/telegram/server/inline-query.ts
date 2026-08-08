import {
	type CreateOrderInput,
	createOrderSchema,
	orderDraftSchema,
} from "#/features/orders/schema";
import { OrderServiceError } from "#/features/orders/server/create";
import { quoteWithExchangeRate } from "#/features/payment-settings/server/rates";

export function parseTelegramCreateQuery(
	query: string,
): Omit<CreateOrderInput, "externalOrderId"> | null {
	const match = query
		.trim()
		.match(/^new\s+(\S+)(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(.+))?$/i);
	if (!match) return null;
	const parsed = createOrderSchema.safeParse({
		externalOrderId: "telegram-draft",
		amount: match[1],
		currency: match[2] ?? "USD",
		paymentAsset: match[3] ?? "USDT",
		paymentNetwork: match[4] ?? "tron",
		description: match[5],
	});
	if (!parsed.success) return null;
	const { externalOrderId: _externalOrderId, ...input } = parsed.data;
	return input;
}

export function parseTelegramDraftQuery(query: string) {
	const match = query
		.trim()
		.match(/^(\d+(?:\.\d{1,8})?)(?:\s+([A-Za-z]{3}))?$/);
	if (!match) return null;
	const parsed = orderDraftSchema.safeParse({
		amount: match[1],
		currency: match[2] ?? "USD",
	});
	return parsed.success ? parsed.data : null;
}

export async function inlinePaymentOptions(
	db: D1Database,
	draft: NonNullable<ReturnType<typeof parseTelegramDraftQuery>>,
) {
	const rows = await db
		.prepare(
			`SELECT rm.id AS receiving_method_id, a.code, a.decimals,
			 a.rail_code AS network
			 FROM receiving_methods rm
			 JOIN receiving_method_assets link ON link.receiving_method_id = rm.id
			 JOIN payment_assets a ON a.id = link.payment_asset_id
			 JOIN payment_rails pr ON pr.code = a.rail_code
			 WHERE rm.enabled = 1 AND rm.target_value != ''
			 AND EXISTS (SELECT 1 FROM payment_ingresses pc WHERE pc.rail_code = a.rail_code
			  AND pc.enabled = 1 AND (pr.kind IN ('exchange', 'wallet')
			   OR pc.health_status IN ('healthy', 'degraded')))
			 ORDER BY rm.sort_order, rm.name LIMIT 50`,
		)
		.all<{
			receiving_method_id: string;
			code: string;
			decimals: number;
			network: string;
		}>();
	const options: Array<{
		receivingMethodId: string;
		asset: string;
		network: string;
		amount: string;
	}> = [];
	for (const row of rows.results) {
		try {
			const quote = await quoteWithExchangeRate(db, {
				amount: draft.amount,
				currency: draft.currency,
				paymentAsset: row.code,
				assetDecimals: row.decimals,
			});
			if (quote)
				options.push({
					receivingMethodId: row.receiving_method_id,
					asset: row.code,
					network: row.network,
					amount: quote.paymentAmount,
				});
		} catch (error) {
			if (!(error instanceof OrderServiceError)) throw error;
		}
	}
	return options;
}

export function inlineOptionId(receivingMethodId: string) {
	return `create-payment:${receivingMethodId}`;
}

export function parseInlineOptionId(value: string) {
	const receivingMethodId = value.match(
		/^create-payment:([0-9a-f-]{36})$/i,
	)?.[1];
	return receivingMethodId ? { receivingMethodId } : null;
}

export function selectedDraftInput(
	query: string,
	selection: NonNullable<ReturnType<typeof parseInlineOptionId>>,
) {
	const draft = parseTelegramDraftQuery(query);
	if (!draft) return null;
	const parsed = createOrderSchema.safeParse({
		externalOrderId: "telegram-selected-draft",
		amount: draft.amount,
		currency: draft.currency,
		receivingMethodId: selection.receivingMethodId,
	});
	if (!parsed.success) return null;
	const { externalOrderId: _externalOrderId, ...input } = parsed.data;
	return input;
}
