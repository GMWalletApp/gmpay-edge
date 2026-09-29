import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const sourceFiles = collectSourceFiles(resolve(root, "src"));

describe("SSR render data boundaries", () => {
	it("coordinates critical and high-probability data through route loaders", () => {
		expect(ownersOf("useSuspenseQuery(")).toEqual([
			"src/features/dashboard/pages/admin.tsx",
		]);
		expect(ownersOf("queryClient.prefetchQuery(")).toEqual([
			"src/routes/admin/index.tsx",
			"src/routes/admin/payment-settings/index.tsx",
			"src/routes/admin/payment-settings/ingresses.tsx",
			"src/routes/admin/payment-settings/rates/fiat.tsx",
			"src/routes/admin/payment-settings/rates/index.tsx",
		]);
		const dashboardRoute = read("src/routes/admin/index.tsx");
		expect(dashboardRoute).toContain(
			"void context.queryClient.prefetchQuery(dashboardQuery)",
		);
		expect(dashboardRoute).not.toContain(
			"await context.queryClient.prefetchQuery(dashboardQuery)",
		);
	});

	it("resolves identity, authorization, brand, and checkout snapshot before render", () => {
		const rootRoute = read("src/routes/__root.tsx");
		const adminRoute = read("src/routes/admin/route.tsx");
		const checkoutRoute = read("src/routes/checkout/$orderId.tsx");

		expect(rootRoute).toContain("loader: () => getSiteBrandFn()");
		expect(adminRoute).toContain("loader: async ({ location }) =>");
		expect(adminRoute).toContain("bootstrap = await getAdminBootstrapFn()");
		expect(adminRoute).not.toContain("beforeLoad:");
		expect(adminRoute).toContain(
			"return { systemAccess, user, layout: readLayoutPreferences() }",
		);
		expect(checkoutRoute).toContain(
			"getCheckoutOrderFn({ data: { orderId: params.orderId } })",
		);
	});

	it("keeps localized timestamps stable across the first server and client render", () => {
		for (const file of [
			"src/features/dashboard/pages/admin.tsx",
			"src/features/status/pages/status.tsx",
		]) {
			const source = read(file);
			expect(source).toContain('mounted ? undefined : "UTC"');
			expect(source).not.toContain(".toLocaleString(");
		}
	});
});

function ownersOf(token: string) {
	return sourceFiles
		.filter((file) => readFileSync(file, "utf8").includes(token))
		.map((file) => relative(root, file).replaceAll("\\", "/"))
		.sort();
}

function read(file: string) {
	return readFileSync(resolve(root, file), "utf8");
}

function collectSourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return collectSourceFiles(path);
		return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
	});
}
