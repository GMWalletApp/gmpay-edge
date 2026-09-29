// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchProvider } from "#/context/search-provider";
import { systemPermission } from "#/features/access/system-rbac";
import { CommandMenu } from "#/layouts/components/command-menu";
import { systemSidebarData } from "#/layouts/components/data/sidebar-data";
import { NavigationProvider } from "#/layouts/components/navigation-context";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

describe("command menu", () => {
	let root: ReturnType<typeof createRoot> | undefined;

	afterEach(async () => {
		if (root) await act(async () => root?.unmount());
		root = undefined;
		document.body.innerHTML = "";
	});

	it("lists only the destinations the current permissions allow", async () => {
		expect(await openedItems([systemPermission("users", "read")])).toEqual([
			"Users & access",
		]);
		expect(document.body.textContent).not.toContain("Role management");
		expect(document.body.textContent).not.toContain("Orders");
	});

	it("expands a module into its permitted children only", async () => {
		const items = await openedItems([
			systemPermission("users", "read"),
			systemPermission("roles", "read"),
		]);
		expect(items).toHaveLength(4);
		for (const item of items) expect(item).toContain("Users & access · ");
		expect(items).toContain("Users & access · User management");
		expect(items).toContain("Users & access · Role management");
		expect(document.body.textContent).not.toContain("Dashboard");
	});

	async function openedItems(
		permissions: ReturnType<typeof systemPermission>[],
	) {
		const container = document.body.appendChild(document.createElement("div"));
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<NavigationProvider
					navigation={systemSidebarData(permissions)}
					permissions={permissions}
				>
					<SearchProvider>
						<CommandMenu />
					</SearchProvider>
				</NavigationProvider>,
			);
		});
		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "k", metaKey: true }),
			);
		});
		return [...document.querySelectorAll("[cmdk-item]")].map(
			(item) => item.textContent,
		);
	}
});
