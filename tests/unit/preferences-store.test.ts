// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
	defaultDirection,
	defaultFont,
	defaultTheme,
	preferencesStore,
} from "#/stores/preferences-store";

describe("UI preferences store", () => {
	beforeEach(() => {
		localStorage.clear();
		preferencesStore.actions.resetTheme();
		preferencesStore.actions.resetFont();
		preferencesStore.actions.resetDirection();
	});

	it("shares and persists theme, font and direction changes", () => {
		preferencesStore.actions.setTheme("dark");
		preferencesStore.actions.setFont("inter");
		preferencesStore.actions.setDirection("rtl");

		expect(preferencesStore.state).toMatchObject({
			theme: "dark",
			font: "inter",
			direction: "rtl",
		});
		expect(localStorage.getItem("theme")).toBe("dark");
		expect(localStorage.getItem("font")).toBe("inter");
		expect(localStorage.getItem("direction")).toBe("rtl");

		preferencesStore.actions.resetTheme();
		preferencesStore.actions.resetFont();
		preferencesStore.actions.resetDirection();
		expect(preferencesStore.state).toMatchObject({
			theme: defaultTheme,
			font: defaultFont,
			direction: defaultDirection,
		});
	});

	it("hydrates persisted browser preferences only when requested after mount", () => {
		localStorage.setItem("theme", "dark");
		localStorage.setItem("font", "inter");
		localStorage.setItem("direction", "rtl");

		expect(preferencesStore.state).toMatchObject({
			theme: defaultTheme,
			font: defaultFont,
			direction: defaultDirection,
		});
		preferencesStore.actions.hydrate();
		expect(preferencesStore.state).toMatchObject({
			theme: "dark",
			font: "inter",
			direction: "rtl",
		});
	});

	it("leaves layout cookies to the admin route loader", () => {
		expect(preferencesStore.state).not.toHaveProperty("variant");
		expect(preferencesStore.state).not.toHaveProperty("collapsible");
	});
});
