import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsRoot = "src/features/settings";

describe("settings page ownership", () => {
	it("mounts the Brand page directly on the settings index route", () => {
		const route = read("src/routes/admin/settings/index.tsx");
		expect(route).toContain('from "#/features/settings/pages/brand"');
		expect(route).toContain("component: BrandSettingsPage");
		expect(route).not.toContain("SystemSettingsSection");
	});

	it("keeps Brand assets out of the data-driven settings page", () => {
		const ordinaryPage = read(`${settingsRoot}/pages/admin.tsx`);
		const brandPage = read(`${settingsRoot}/pages/brand.tsx`);
		const assetField = read(`${settingsRoot}/components/site-asset-field.tsx`);
		const queries = read(`${settingsRoot}/queries.ts`);

		expect(ordinaryPage).not.toMatch(
			/SiteLogoField|SiteBackgroundField|uploadSiteLogoFn|group === "brand"/,
		);
		expect(brandPage).toContain("<SiteLogoField");
		expect(brandPage).toContain("<SiteBackgroundField");
		for (const page of [ordinaryPage, brandPage]) {
			expect(page).toContain("useQuery(systemSettingsQueryOptions)");
			expect(page).toContain("queryKey: systemSettingsQueryKey");
		}
		expect(queries).toContain(
			'export const systemSettingsQueryKey = ["admin", "system-settings"]',
		);
		expect(queries).toContain("staleTime: 5 * 60_000");
		expect(brandPage).toContain("await router.invalidate({");
		expect(brandPage).toContain(
			'filter: (match) => match.routeId === "__root__"',
		);
		expect(assetField).toContain("validateSquareImage");
		expect(assetField).toContain("fileDataUrl(file)");
		expect(assetField).toContain("file.size > maxBytes");
		expect(assetField).toContain("<img");
		expect(assetField).toContain("await remove()");
		expect(assetField.match(/await onChanged\(\)/g)).toHaveLength(2);
	});

	it("keeps all eight ordinary groups on one data-driven form contract", () => {
		const groups = {
			access: "access",
			auth: "auth",
			orders: "orders",
			payment: "payment",
			retention: "retention",
			scanning: "scanning",
			secrets: "secrets",
			webhooks: "webhook",
		} as const;
		for (const [routeName, group] of Object.entries(groups)) {
			const route = read(`src/routes/admin/settings/${routeName}.tsx`);
			expect(route, routeName).toContain(
				'from "#/features/settings/pages/admin"',
			);
			expect(route, routeName).toContain(
				`<SystemSettingsSection group="${group}" />`,
			);
		}
	});

	it("mounts email delivery as an independent top-level admin page", () => {
		const route = read("src/routes/admin/email.tsx");
		const sidebar = read("src/layouts/components/data/sidebar-data.ts");
		expect(route).toContain('from "#/features/settings/pages/email"');
		expect(route).toContain('createFileRoute("/admin/email")');
		expect(route).toContain("validateSearch: validateProTableSearch");
		expect(sidebar).toContain('id: "email"');
		expect(sidebar).toContain('"/admin/email"');
		expect(sidebar.indexOf('id: "email"')).toBeLessThan(
			sidebar.indexOf('id: "payment-settings"'),
		);
	});
});

function read(path: string) {
	return readFileSync(resolve(path), "utf8");
}
