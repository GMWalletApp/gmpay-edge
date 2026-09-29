import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getAdminBootstrapFn: vi.fn() }));
const request = vi.hoisted(() => ({ cookie: "" }));

vi.mock("#/features/auth/server/session", () => auth);
vi.mock("@tanstack/react-start/server", () => ({
	getRequestHeader: (name: string) =>
		name === "cookie" ? request.cookie : undefined,
}));
vi.mock("#/layouts/components/data/sidebar-data", () => ({
	canAccessAdminPath: () => true,
	systemSidebarData: () => ({ navGroups: [] }),
}));
vi.mock("#/layouts/dashboard", () => ({ DashboardLayout: () => null }));

// Loaded once here so transforming the route's module graph (layout
// provider, sidebar UI) is not charged to a single test's timeout.
const { Route } = await import("#/routes/admin/route");
const loader = Route.options.loader as (input: {
	location: { href: string; pathname: string };
}) => Promise<unknown>;

const access = {
	id: "root-user",
	name: "Root",
	email: "root@example.com",
	enabled: true,
	updatedAt: new Date(0),
	roles: ["root"],
	root: true,
	permissions: [],
};

describe("admin route navigation", () => {
	it("loads bootstrap on entry and keeps the parent match stable", async () => {
		auth.getAdminBootstrapFn.mockResolvedValue({ installed: true, access });

		await expect(
			loader({
				location: { href: "/admin/orders", pathname: "/admin/orders" },
			}),
		).resolves.toEqual({
			systemAccess: access,
			user: access,
			layout: { collapsible: "icon", variant: "floating", sidebarOpen: true },
		});
		expect(auth.getAdminBootstrapFn).toHaveBeenCalledOnce();
		expect(Route.options.gcTime).toBe(0);
	});

	it("reads persisted layout cookies from the request so SSR matches the client", async () => {
		auth.getAdminBootstrapFn.mockResolvedValue({ installed: true, access });
		request.cookie =
			"sidebar_state=false; layout_variant=inset; layout_collapsible=offcanvas";

		await expect(
			loader({ location: { href: "/admin", pathname: "/admin" } }),
		).resolves.toMatchObject({
			layout: {
				collapsible: "offcanvas",
				variant: "inset",
				sidebarOpen: false,
			},
		});
		request.cookie = "";
	});

	it("keeps application routes free of beforeLoad lifecycle work", async () => {
		const files = [
			"../../src/routes/__root.tsx",
			"../../src/routes/admin/route.tsx",
			"../../src/routes/(auth)/sign-in.tsx",
			"../../src/routes/install.tsx",
		];

		for (const file of files) {
			const source = await readFile(new URL(file, import.meta.url), "utf8");
			expect(source).not.toContain("beforeLoad:");
		}
	});
});
