// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectPaymentOptionPanel } from "#/features/checkout/components/select-payment-option-panel";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("checkout payment option panel", () => {
	let container: HTMLDivElement | undefined;
	let root: ReturnType<typeof createRoot> | undefined;

	afterEach(async () => {
		if (root) await act(async () => root?.unmount());
		container?.remove();
		container = undefined;
		root = undefined;
	});

	it("renders the operator-defined receiving method name", async () => {
		await renderPanel("BEP20(BNB Chain)");

		expect(container?.textContent).toContain("Select a payment method");
		expect(container?.textContent).not.toContain("Select a receiving method");
		expect(container?.textContent).toContain("BEP20(BNB Chain)");
		expect(container?.textContent).not.toContain("BNB Smart Chain");
	});

	it("falls back to the network name when the custom name is blank", async () => {
		await renderPanel("   ");

		expect(container?.textContent).toContain("BNB Smart Chain");
	});

	async function renderPanel(receivingMethodName: string) {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(
				<SelectPaymentOptionPanel
					busy={false}
					onConfirm={vi.fn()}
					options={[
						{
							receivingMethodId: "method-primary",
							receivingMethodName,
							paymentMethodId: "asset-usdt-bsc",
							asset: "USDT",
							network: "bsc",
							networkName: "BNB Smart Chain",
							railKind: "chain",
							amount: "12.5",
							current: false,
						},
					]}
				/>,
			);
		});
	}
});
