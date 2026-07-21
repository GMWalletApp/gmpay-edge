import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createDefaultSeoHead,
	createHomeSeoHead,
	siteNameFromMatches,
} from "#/lib/seo";

describe("locale-preserving UI navigation", () => {
	it("keeps checkout exits inside the localized router", () => {
		const source = readFileSync(
			resolve("src/features/checkout/pages/checkout.tsx"),
			"utf8",
		);
		expect(source).toContain('useNavigate } from "@tanstack/react-router"');
		expect(source).toContain('navigate({ to: "/" })');
		expect(source).not.toContain('window.location.assign("/")');
	});

	it("renders configured site names instead of hard-coded surface brands", () => {
		for (const path of [
			"src/layouts/public/footer.tsx",
			"src/features/auth/pages/sign-in.tsx",
			"src/features/checkout/pages/checkout.tsx",
			"src/features/home/index.tsx",
		]) {
			const source = readFileSync(resolve(path), "utf8");
			expect(source, path).toContain("brand.name");
		}
	});

	it("uses the root brand in route metadata", () => {
		const siteName = siteNameFromMatches([
			{ loaderData: undefined },
			{ loaderData: { name: "My Gateway" } },
		]);
		const head = createDefaultSeoHead({ siteName });
		expect(siteName).toBe("My Gateway");
		expect(head.meta).toContainEqual({
			property: "og:site_name",
			content: "My Gateway",
		});
		expect(head.meta).toContainEqual({
			name: "twitter:site",
			content: "My Gateway",
		});
	});

	it("publishes one canonical URL without locale-prefixed alternates", () => {
		const head = createHomeSeoHead([]);

		expect(head.links).toHaveLength(1);
		expect(head.links[0]).toMatchObject({ rel: "canonical" });
		expect(head.links[0]).not.toHaveProperty("hrefLang");
	});
});
