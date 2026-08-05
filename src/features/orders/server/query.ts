import type { OrderStatus } from "#/features/orders/schema";
import { unitsToDecimal } from "#/lib/money";
import { minorToDecimal } from "#/lib/units";

export interface ApiOrder {
	orderId: string;
	externalOrderId: string;
	status: OrderStatus;
	amount: string;
	currency: string;
	paymentAmount?: string;
	paymentAsset?: string;
	paymentNetwork?: string;
	checkoutUrl: string;
	expiresAt: string;
	receivingMethodId?: string;
	receiveAddress?: string;
	notifyUrl?: string;
	description?: string;
	metadata?: Record<string, string>;
}

export type OrderSelector =
	| { id: string; externalOrderId?: never; apiKeyId?: string }
	| { id?: never; externalOrderId: string; apiKeyId: string };

export async function getOrder(
	db: D1Database,
	selector: OrderSelector,
	requestUrl: string,
): Promise<ApiOrder | null> {
	const field = selector.id ? "o.id" : "o.external_order_id";
	const value = selector.id ?? selector.externalOrderId;
	const row = await db
		.prepare(
			`SELECT o.id, o.external_order_id, o.status, o.amount_minor, o.currency,
			 o.currency_decimals, o.notify_url, o.description, o.metadata, o.expires_at,
			 ops.expected_amount_units, ops.decimals,
			 COALESCE(ops.asset_code, a.code) AS code,
			 COALESCE(ops.rail_code, a.rail_code) AS network,
			 ops.receiving_method_id, ops.target_value
			 FROM orders o LEFT JOIN payment_assets a ON a.id = o.payment_asset_id
			 LEFT JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 WHERE ${field} = ?
			 AND (? IS NULL OR o.api_key_id = ?) LIMIT 1`,
		)
		.bind(value, selector.apiKeyId ?? null, selector.apiKeyId ?? null)
		.first<{
			id: string;
			external_order_id: string;
			status: OrderStatus;
			amount_minor: string;
			currency: string;
			currency_decimals: number;
			expected_amount_units: string | null;
			decimals: number | null;
			expires_at: number;
			code: string | null;
			network: string | null;
			receiving_method_id: string | null;
			target_value: string | null;
			notify_url: string | null;
			description: string | null;
			metadata: string | null;
		}>();
	if (!row) return null;
	const metadata = parseMetadata(row.metadata);
	return {
		orderId: row.id,
		externalOrderId: row.external_order_id,
		status: row.status,
		amount: minorToDecimal(row.amount_minor, row.currency_decimals),
		currency: row.currency,
		...(row.expected_amount_units !== null && row.decimals !== null
			? {
					paymentAmount: unitsToDecimal(
						BigInt(row.expected_amount_units),
						row.decimals,
					),
				}
			: {}),
		...(row.code ? { paymentAsset: row.code } : {}),
		...(row.network ? { paymentNetwork: row.network } : {}),
		...(row.receiving_method_id
			? { receivingMethodId: row.receiving_method_id }
			: {}),
		...(row.target_value ? { receiveAddress: row.target_value } : {}),
		checkoutUrl: `${new URL(requestUrl).origin}/checkout/${row.id}`,
		expiresAt: new Date(row.expires_at).toISOString(),
		...(row.notify_url ? { notifyUrl: row.notify_url } : {}),
		...(row.description ? { description: row.description } : {}),
		...(metadata ? { metadata } : {}),
	};
}

function parseMetadata(value: string | null) {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return undefined;
		const entries = Object.entries(parsed);
		if (
			!entries.every(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			)
		)
			return undefined;
		return Object.fromEntries(entries);
	} catch {
		return undefined;
	}
}
