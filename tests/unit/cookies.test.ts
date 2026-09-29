// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCookie, setCookie } from "#/lib/cookies";

afterEach(() => {
	vi.unstubAllGlobals();
	setCookie("layout", "", 0);
});

describe("cookie helpers", () => {
	it("uses Cookie Store with the shared persistence policy", () => {
		const set = vi.fn(async () => undefined);
		vi.stubGlobal("cookieStore", { set });
		setCookie("layout", "collapsed", 60);
		expect(set).toHaveBeenCalledWith({
			name: "layout",
			value: "collapsed",
			path: "/",
			sameSite: "lax",
			expires: expect.any(Number),
		});
	});

	it("falls back to document.cookie and safely encodes values", () => {
		vi.stubGlobal("cookieStore", undefined);
		setCookie("layout", "side bar", 60);
		expect(document.cookie).toContain("layout=side%20bar");
		expect(parseCookie(document.cookie, "layout")).toBe("side bar");
	});

	it("parses request cookie headers by exact name", () => {
		const header = "sidebar_state=false; layout_variant=inset; broken=%E0%A4%A";
		expect(parseCookie(header, "sidebar_state")).toBe("false");
		expect(parseCookie(header, "layout_variant")).toBe("inset");
		expect(parseCookie(header, "layout")).toBeUndefined();
		expect(parseCookie(header, "broken")).toBe("%E0%A4%A");
		expect(parseCookie("", "sidebar_state")).toBeUndefined();
	});
});
