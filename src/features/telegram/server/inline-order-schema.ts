import { z } from "zod";
import { orderStatuses } from "#/features/orders/schema";
import type { ApiOrder } from "#/features/orders/server/query";

const storedInlineOrderSchema = z.object({
	orderId: z.string(),
	externalOrderId: z.string(),
	status: z.enum(orderStatuses),
	amount: z.string(),
	currency: z.string(),
	paymentAmount: z.string().optional(),
	paymentAsset: z.string().optional(),
	paymentNetwork: z.string().optional(),
	checkoutUrl: z.url(),
	expiresAt: z.iso.datetime(),
	receivingMethodId: z.string().optional(),
	receiveAddress: z.string().optional(),
	notifyUrl: z.url().optional(),
	description: z.string().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
});

export type StoredInlineOrder = ApiOrder;

export function parseStoredInlineOrder(
	value: string,
): StoredInlineOrder | null {
	try {
		return storedInlineOrderSchema.parse(JSON.parse(value));
	} catch {
		return null;
	}
}
