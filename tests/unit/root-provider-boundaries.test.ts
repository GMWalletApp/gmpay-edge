import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("root provider boundaries", () => {
	it("renders theme consumers inside ThemeProvider", () => {
		const source = readFileSync(
			resolve(import.meta.dirname, "../../src/routes/__root.tsx"),
			"utf8",
		);
		const providerStart = source.indexOf("<ThemeProvider>");
		const toaster = source.indexOf("<Toaster");
		const providerEnd = source.indexOf("</ThemeProvider>");

		expect(providerStart).toBeGreaterThan(-1);
		expect(toaster).toBeGreaterThan(providerStart);
		expect(providerEnd).toBeGreaterThan(toaster);
	});

	it("renders both scheme-specific theme colors outside the deduplicating route head", () => {
		const source = readFileSync(
			resolve(import.meta.dirname, "../../src/routes/__root.tsx"),
			"utf8",
		);
		// Route head() keeps one meta per name, so a light and a dark
		// theme-color can only coexist as shell markup.
		expect(source).not.toMatch(/name:\s*"theme-color"/);
		const shell = source.slice(
			source.indexOf("<head>"),
			source.indexOf("</head>"),
		);
		expect(shell).toMatch(
			/<meta\s+content="#ffffff"\s+media="\(prefers-color-scheme: light\)"\s+name="theme-color"\s*\/>/,
		);
		expect(shell).toMatch(
			/<meta\s+content="#09090b"\s+media="\(prefers-color-scheme: dark\)"\s+name="theme-color"\s*\/>/,
		);
		const provider = readFileSync(
			resolve(import.meta.dirname, "../../src/context/theme-provider.tsx"),
			"utf8",
		);
		expect(provider).toContain('meta[name="theme-color"]');
	});

	it("hydrates browser preferences after the SSR-compatible first frame", () => {
		const store = readFileSync(
			resolve(import.meta.dirname, "../../src/stores/preferences-store.ts"),
			"utf8",
		);
		const provider = readFileSync(
			resolve(import.meta.dirname, "../../src/context/theme-provider.tsx"),
			"utf8",
		);
		expect(store).toContain("theme: defaultTheme");
		expect(store).not.toContain("initialPreferences()");
		expect(provider).toContain(
			"useEffect(() => preferencesStore.actions.hydrate(), []);",
		);
	});
});
