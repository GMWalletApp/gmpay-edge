import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const adminRoutes = tsxFiles(resolve(root, "src/routes/admin"));

describe("UI surface routing contracts", () => {
	it("keeps every product surface mounted on a semantic route", () => {
		for (const file of [
			"src/routes/(public)/index.tsx",
			"src/routes/(public)/assets.tsx",
			"src/routes/(public)/docs.tsx",
			"src/routes/(public)/status.tsx",
			"src/routes/(auth)/sign-in.tsx",
			"src/routes/install.tsx",
			"src/routes/checkout/$orderId.tsx",
			"src/routes/admin/index.tsx",
			"src/routes/admin/orders.tsx",
			"src/routes/admin/payments.tsx",
			"src/routes/admin/payment-reviews.tsx",
			"src/routes/admin/receiving-methods/index.tsx",
			"src/routes/admin/payment-settings/index.tsx",
			"src/routes/admin/payment-settings/ingresses.tsx",
			"src/routes/admin/payment-settings/rates/index.tsx",
			"src/routes/admin/payment-settings/rates/fiat.tsx",
			"src/routes/admin/api-keys.tsx",
			"src/routes/admin/email.tsx",
			"src/routes/admin/webhooks/index.tsx",
			"src/routes/admin/webhooks/inbound-records.tsx",
			"src/routes/admin/webhooks/records.tsx",
			"src/routes/admin/telegram/index.tsx",
			"src/routes/admin/operations/scheduled.tsx",
			"src/routes/admin/operations/queues.tsx",
			"src/routes/admin/operations/audit-logs.tsx",
			"src/routes/admin/settings/index.tsx",
		]) {
			expect(existsSync(resolve(root, file)), file).toBe(true);
		}
	});

	it("keeps public and auth routes thin while their features own page behavior", () => {
		for (const [route, page] of [
			["src/routes/(auth)/two-factor.tsx", "#/features/auth/pages/two-factor"],
			["src/routes/(public)/assets.tsx", "#/features/status/pages/assets"],
			["src/routes/(public)/status.tsx", "#/features/status/pages/status"],
		] as const) {
			const source = read(route);
			expect(source, route).toContain(`from "${page}"`);
			expect(source, route).not.toContain("useState");
			expect(source, route).not.toContain("<section");
			expect(source, route).not.toContain("<form");
		}
	});

	it("uses the shared module navigation for every multi-page admin domain", () => {
		for (const moduleId of [
			"access",
			"operations",
			"payment-settings",
			"settings",
			"telegram",
			"webhooks",
		]) {
			const source = read(`src/routes/admin/${moduleId}/route.tsx`);
			expect(source, moduleId).toContain("<ModuleNavigation");
			expect(source, moduleId).toContain(`moduleId="${moduleId}"`);
			expect(source, moduleId).toMatch(/description=\{m\.[A-Za-z0-9_]+\(\)\}/);
		}
	});

	it("gives every module child the same remaining viewport height owner", () => {
		const layout = read("src/layouts/settings/index.tsx");
		expect(layout).toContain(
			'"flex min-h-0 flex-1 flex-col space-y-2 overflow-hidden',
		);
		expect(layout).toContain(
			'className="flex min-h-0 w-full flex-1 overflow-y-hidden p-1"',
		);
		for (const page of [
			"src/features/access/pages/admin.tsx",
			"src/features/operations/pages/audit-logs.tsx",
			"src/features/operations/pages/jobs.tsx",
			"src/features/users/pages/admin-list.tsx",
		]) {
			const source = read(page);
			expect(source, page).toContain(
				'<div className="flex min-h-0 w-full flex-1 flex-col gap-4">',
			);
			expect(source, page).not.toContain("<Main fixed");
		}
		const proTable = read("src/components/pro/table/index.tsx");
		expect(proTable).not.toContain('isFullLayout && "min-h-0 flex-1"');
		expect(proTable).toContain(
			'<div className="min-h-0 flex-1" aria-hidden="true" />',
		);
	});

	it("gives every URL-backed ProTable page a validating route owner", () => {
		const urlBackedPages = tsxFiles(resolve(root, "src/features")).filter(
			(file) =>
				readFileSync(file, "utf8").includes("useCurrentProTableUrlState"),
		);
		for (const page of urlBackedPages) {
			const specifier = `#/${relative(resolve(root, "src"), page)
				.replaceAll("\\", "/")
				.replace(/\.tsx$/, "")}`;
			const owners = adminRoutes.filter((route) =>
				readFileSync(route, "utf8").includes(`from "${specifier}"`),
			);
			expect(owners.length, specifier).toBeGreaterThan(0);
			for (const owner of owners) {
				expect(readFileSync(owner, "utf8"), projectPath(owner)).toContain(
					"validateSearch: validateProTableSearch",
				);
			}
		}
	});

	it("keeps queue search in the route-owned ProTable state", () => {
		const queuePage = read("src/features/operations/pages/queues.tsx");
		expect(queuePage).toContain(
			'useCurrentProTableUrlState({ searchColumnId: "name" })',
		);
		expect(queuePage).toContain("initialState={tableUrlState.initialState}");
		expect(queuePage).toContain("onChange={tableUrlState.onChange}");
		expect(queuePage).toContain("pagination={false}");
	});

	it("shares brand and landmarks across public, auth, install, admin, and checkout", () => {
		expect(read("src/routes/__root.tsx")).toContain("<SiteBrandProvider");
		const appTitle = read("src/layouts/components/app-title.tsx");
		expect(appTitle).toContain("height={36}");
		expect(appTitle).toContain("width={36}");
		expect(read("src/layouts/public/index.tsx")).toContain("<PublicHeader />");
		expect(read("src/layouts/auth/index.tsx")).toContain(
			"<AppTitle description />",
		);
		expect(read("src/layouts/install/index.tsx")).toContain("<main");
		expect(read("src/layouts/install/index.tsx")).toContain(
			"<AppTitle description />",
		);
		expect(read("src/layouts/dashboard/index.tsx")).toContain("<SkipToMain />");
		const checkoutRoute = read("src/routes/checkout/$orderId.tsx");
		expect(checkoutRoute).toContain(
			'import { CheckoutPage } from "#/features/checkout/pages/checkout"',
		);
		expect(checkoutRoute).not.toContain("useState");
		const checkout = read("src/features/checkout/pages/checkout.tsx");
		expect(checkout).toContain("const brand = useSiteBrand()");
		expect(checkout).toContain("src={brand.logoUrl}");
		expect(checkout).toContain("{brand.name}");
	});
});

describe("UI accessibility and localization contracts", () => {
	it("names module navigation, upload, tables, and skip links", () => {
		expect(read("src/layouts/settings/index.tsx")).toContain(
			"aria-label={m.common_settings_sections({ title })}",
		);
		expect(read("src/components/pro/base/fields/upload/index.tsx")).toContain(
			"aria-label={m.pro_field_uploadFiles()}",
		);
		expect(read("src/features/status/pages/assets.tsx")).toContain(
			'<caption className="sr-only">',
		);
		expect(read("src/layouts/components/skip-to-main.tsx")).toContain(
			"{m.layout_skip_to_main()}",
		);
	});

	it("keeps install and auth metadata in Paraglide", () => {
		for (const file of [
			"src/layouts/install/index.tsx",
			"src/routes/install.tsx",
			"src/routes/(auth)/sign-in.tsx",
		]) {
			const source = read(file);
			expect(source, file).not.toMatch(
				/Secure setup|Initialize your payment gateway|Sign in to the GMPay Edge control plane|Migration ready|Bindings configured|Create below/,
			);
		}
	});
});

function read(file: string) {
	return readFileSync(resolve(root, file), "utf8");
}

function projectPath(file: string) {
	return relative(root, file).replaceAll("\\", "/");
}

function tsxFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return tsxFiles(path);
		return entry.name.endsWith(".tsx") ? [path] : [];
	});
}
