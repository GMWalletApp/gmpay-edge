// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ProSchemaForm } from "#/components/pro/form";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The rates settings form hides the API-key field with a function of the
// current values (keyless provider selected). This covers the shared
// primitive's boolean and function forms so that change cannot regress other
// schema forms that rely on the boolean.
describe("ProSchemaForm hidden items", () => {
	let container: HTMLDivElement | undefined;

	afterEach(() => {
		container?.remove();
		container = undefined;
	});

	function mount() {
		container = document.createElement("div");
		document.body.appendChild(container);
		return createRoot(container);
	}

	function setSelectValue(select: HTMLSelectElement, value: string) {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLSelectElement.prototype,
			"value",
		)?.set;
		setter?.call(select, value);
		select.dispatchEvent(new Event("change", { bubbles: true }));
	}

	it("honours a boolean hidden flag", async () => {
		const root = mount();
		await act(async () => {
			root.render(
				<ProSchemaForm
					submitter={false}
					schema={[
						{ name: "shown", label: "Shown", valueType: "text" },
						{ name: "gone", label: "Gone", valueType: "text", hidden: true },
						{ name: "kept", label: "Kept", valueType: "text", hidden: false },
					]}
				/>,
			);
		});
		expect(container?.querySelector("#shown")).not.toBeNull();
		expect(container?.querySelector("#kept")).not.toBeNull();
		expect(container?.querySelector("#gone")).toBeNull();
	});

	it("re-evaluates a function hidden flag as values change, exactly like the API-key field", async () => {
		const root = mount();
		await act(async () => {
			root.render(
				<ProSchemaForm
					submitter={false}
					initialValues={{ provider: "exchangerate_host" }}
					schema={[
						{
							name: "provider",
							label: "Source",
							// A plain <select> stands in for the Radix select so the
							// change can be driven from jsdom; the primitive only sees
							// field.onChange either way.
							render: (field) => (
								<select
									id="provider"
									value={String(field.value ?? "")}
									onChange={(event) => field.onChange(event.target.value)}
								>
									<option value="exchangerate_host">exchangerate.host</option>
									<option value="allratestoday">AllRatesToday</option>
								</select>
							),
						},
						{
							name: "apiKey",
							label: "API key",
							valueType: "password",
							hidden: (values) => values.provider === "allratestoday",
						},
					]}
				/>,
			);
		});
		const select = container?.querySelector(
			"#provider",
		) as HTMLSelectElement | null;
		if (!select) throw new Error("provider select did not render");
		expect(container?.querySelector("#apiKey")).not.toBeNull();

		await act(async () => setSelectValue(select, "allratestoday"));
		expect(container?.querySelector("#apiKey")).toBeNull();

		await act(async () => setSelectValue(select, "exchangerate_host"));
		expect(container?.querySelector("#apiKey")).not.toBeNull();
	});
});
