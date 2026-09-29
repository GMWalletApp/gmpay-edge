import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { Clock3, Settings } from "lucide-react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsLayout } from "#/layouts/settings";

describe("module navigation layout", () => {
	it("renders module sections as links with aria-current on the active page", async () => {
		const rootRoute = createRootRoute({
			component: () => (
				<SettingsLayout
					items={[
						{
							value: "brand",
							title: "Branding",
							icon: Settings,
							url: "/admin/settings",
						},
						{
							value: "retention",
							title: "Retention",
							icon: Clock3,
							url: "/admin/settings/retention",
						},
					]}
					onValueChange={() => {}}
					title="Settings"
					value="retention"
				>
					<Outlet />
				</SettingsLayout>
			),
		});
		const routeTree = rootRoute.addChildren([
			createRoute({
				getParentRoute: () => rootRoute,
				path: "/admin/settings",
				component: () => null,
			}),
			createRoute({
				getParentRoute: () => rootRoute,
				path: "/admin/settings/retention",
				component: () => null,
			}),
		]);
		// Table URL state (page, filters) lives in the search params and must
		// not clear the active section.
		const router = createRouter({
			routeTree,
			history: createMemoryHistory({
				initialEntries: ["/admin/settings/retention?page=2"],
			}),
		});
		await router.load();
		const html = renderToString(<RouterProvider router={router} />);

		const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/g)].map(
			(match) => ({
				href: match[1],
				current: match[0].includes('aria-current="page"'),
			}),
		);
		expect(links).toEqual([
			{ href: "/admin/settings", current: false },
			{ href: "/admin/settings/retention", current: true },
		]);
		expect(html).not.toMatch(/<button[^>]*>[^<]*Retention/);
	});
});
