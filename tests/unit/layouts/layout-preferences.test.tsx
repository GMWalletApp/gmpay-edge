import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Sidebar, SidebarProvider } from "#/components/ui/sidebar";
import {
	LayoutProvider,
	readLayoutPreferences,
	useLayout,
} from "#/context/layout-provider";

const request = vi.hoisted(() => ({ cookie: "" }));

vi.mock("@tanstack/react-start/server", () => ({
	getRequestHeader: (name: string) =>
		name === "cookie" ? request.cookie : undefined,
}));

describe("layout preferences", () => {
	it("reads validated layout cookies from the request and falls back to defaults", () => {
		request.cookie =
			"layout_variant=inset; layout_collapsible=offcanvas; sidebar_state=false";
		expect(readLayoutPreferences()).toEqual({
			variant: "inset",
			collapsible: "offcanvas",
			sidebarOpen: false,
		});

		request.cookie = "layout_variant=fancy; layout_collapsible=; other=1";
		expect(readLayoutPreferences()).toEqual({
			variant: "floating",
			collapsible: "icon",
			sidebarOpen: true,
		});
	});

	it("renders the loader-provided layout on the first pass without reading the browser", () => {
		const html = renderToString(
			<LayoutProvider
				initial={{
					variant: "inset",
					collapsible: "offcanvas",
					sidebarOpen: false,
				}}
			>
				<SidebarProvider defaultOpen={false}>
					<Sidebar collapsible="offcanvas" variant="inset">
						<LayoutValue />
					</Sidebar>
				</SidebarProvider>
			</LayoutProvider>,
		);
		expect(html).toContain("inset:offcanvas");
		expect(html).toContain('data-state="collapsed"');
		expect(html).toContain('data-collapsible="offcanvas"');
		expect(html).toContain('data-variant="inset"');
	});

	it("fails clearly when the hook is used outside its owner", () => {
		expect(() => renderToString(<LayoutValue />)).toThrow(
			"useLayout must be used within a LayoutProvider",
		);
	});
});

function LayoutValue() {
	const { variant, collapsible } = useLayout();
	return <output>{`${variant}:${collapsible}`}</output>;
}
