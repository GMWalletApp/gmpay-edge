// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectPaymentOptionPanel } from "#/features/checkout/components/select-payment-option-panel";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Option = Parameters<typeof SelectPaymentOptionPanel>[0]["options"][number];

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
		await renderPanel([option("chain", "BEP20(BNB Chain)")]);

		expect(container?.textContent).toContain("Select a payment method");
		expect(container?.textContent).not.toContain("Select a receiving method");
		expect(container?.textContent).toContain("BEP20(BNB Chain)");
		expect(container?.textContent).not.toContain("BNB Smart Chain");
	});

	it("falls back to the network name when the custom name is blank", async () => {
		await renderPanel([option("chain", "   ")]);

		expect(container?.textContent).toContain("BNB Smart Chain");
	});

	it("derives the effective selection from the offered options", async () => {
		const onConfirm = vi.fn();
		const chain = option("chain", "BEP20(BNB Chain)");
		const exchange = option("exchange", "Binance Pay");
		await renderPanel([chain, exchange], onConfirm);

		await click("Confirm");
		expect(onConfirm).toHaveBeenLastCalledWith(chain);

		await click("Exchanges");
		await click("Confirm");
		expect(onConfirm).toHaveBeenLastCalledWith(exchange);

		// The chosen kind disappears from the offer: the first remaining one
		// takes over without an extra effect commit.
		await renderPanel([chain], onConfirm);
		await click("Confirm");
		expect(onConfirm).toHaveBeenLastCalledWith(chain);
	});

	async function click(label: string) {
		const button = [...(container?.querySelectorAll("button") ?? [])].find(
			(candidate) => candidate.textContent === label,
		);
		if (!button) throw new Error(`button ${label} not rendered`);
		await act(async () => button.click());
	}

	async function renderPanel(options: Option[], onConfirm = vi.fn()) {
		if (!container) {
			container = document.createElement("div");
			document.body.appendChild(container);
			root = createRoot(container);
		}
		await act(async () => {
			root?.render(
				<SelectPaymentOptionPanel
					busy={false}
					onConfirm={onConfirm}
					options={options}
				/>,
			);
		});
	}
});

function option(
	railKind: Option["railKind"],
	receivingMethodName: string,
): Option {
	return {
		receivingMethodId: `method-${railKind}`,
		receivingMethodName,
		paymentMethodId: `asset-usdt-${railKind}`,
		asset: "USDT",
		network: railKind === "chain" ? "bsc" : "binance",
		networkName: railKind === "chain" ? "BNB Smart Chain" : "Binance",
		railKind,
		amount: "12.5",
		current: false,
	};
}
