import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("checkout polling", () => {
	it("keeps the loader snapshot and serializes visible order refreshes", async () => {
		const [page, route] = await Promise.all([
			readFile(
				new URL(
					"../../src/features/checkout/pages/checkout.tsx",
					import.meta.url,
				),
				"utf8",
			),
			readFile(
				new URL("../../src/routes/checkout/$orderId.tsx", import.meta.url),
				"utf8",
			),
		]);

		expect(route).toContain(
			"order: await getCheckoutOrderFn({ data: { orderId: params.orderId } })",
		);
		expect(page).toContain(
			"const [order, setOrder] = useState<CheckoutOrder | null>(initialOrder)",
		);
		expect(page).toContain(
			"const pollingEnabled = Boolean(order && !isTerminal(statusDetail))",
		);
		expect(page).toContain("useVisiblePolling(");
		expect(page).toContain("pollAfterCurrent()");
		expect(page).not.toContain("window.setInterval");
	});

	it("loads payment options only when the selection UI needs them", async () => {
		const page = await readFile(
			new URL(
				"../../src/features/checkout/pages/checkout.tsx",
				import.meta.url,
			),
			"utf8",
		);

		expect(page).toContain("(!order.token || optionDialogOpen)");
		expect(page).toContain("enabled: shouldLoadPaymentOptions");
		expect(page).toContain(
			'queryKey: ["checkout", "payment-options", orderId]',
		);
		expect(page).not.toContain(".then(setPaymentOptions)");
	});
});
