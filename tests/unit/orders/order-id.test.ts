import { describe, expect, it } from "vitest";
import { generateOrderId, isOrderId } from "#/features/orders/order-id";

describe("order IDs", () => {
	it("generates compact numeric IDs using the full random identifier", () => {
		const generated = Array.from({ length: 64 }, () => generateOrderId());
		expect(new Set(generated)).toHaveLength(generated.length);
		for (const orderId of generated) {
			expect(orderId).toMatch(/^\d{20}$/);
			expect(isOrderId(orderId)).toBe(true);
		}
	});

	it("rejects UUID and malformed public IDs", () => {
		expect(isOrderId("11111111-1111-4111-8111-111111111111")).toBe(false);
		expect(isOrderId("gm_123456789012345678")).toBe(false);
	});
});
