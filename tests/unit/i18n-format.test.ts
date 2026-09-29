import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDateTime, formatDecimalAmount } from "#/lib/format";

describe("locale-aware presentation formatting", () => {
	it("formats the same instant with the selected application locale", () => {
		const instant = "2026-07-12T08:30:45.000Z";
		expect(formatDateTime(instant, "en-US")).toBe(
			new Intl.DateTimeFormat("en-US", {
				dateStyle: "medium",
				timeStyle: "medium",
			}).format(new Date(instant)),
		);
		expect(formatDateTime(instant, "zh-CN")).not.toBe(
			formatDateTime(instant, "en-US"),
		);
		expect(formatDateTime(instant, "en-US", "UTC")).toBe(
			new Intl.DateTimeFormat("en-US", {
				dateStyle: "medium",
				timeStyle: "medium",
				timeZone: "UTC",
			}).format(new Date(instant)),
		);
		expect(formatDateTime("invalid", "zh-TW")).toBe("—");
	});

	it("localizes exact decimal amount strings without float precision loss", () => {
		const large = "123456789012345678901234567890.123456";
		expect(formatDecimalAmount(large, 6, "en-US")).toBe(
			"123,456,789,012,345,678,901,234,567,890.123456",
		);
		expect(plainSpaces(formatDecimalAmount(large, 6, "ru-RU"))).toBe(
			"123 456 789 012 345 678 901 234 567 890,123456",
		);
		expect(formatDecimalAmount("1234.5", 2, "en-US")).toBe("1,234.5");
		expect(plainSpaces(formatDecimalAmount("1234.5", 2, "ru-RU"))).toBe(
			"1 234,5",
		);
		expect(formatDecimalAmount("0.000000000000000001", 18, "en-US")).toBe(
			"0.000000000000000001",
		);
		expect(formatDecimalAmount("12", 2, "ja-JP")).toBe("12");
		expect(formatDecimalAmount("0", undefined, "en-US")).toBe("0");
		expect(formatDecimalAmount("0.99987654", undefined, "en-US")).toBe(
			"0.99987654",
		);
	});

	it("does not fall back to the browser locale in application pages", async () => {
		const sourceRoot = new URL("../../src", import.meta.url).pathname;
		const files = await sourceFiles(sourceRoot);
		const violations: string[] = [];
		for (const file of files) {
			const source = await readFile(file, "utf8");
			if (/\.toLocale(?:Date|Time)?String\(\s*\)/.test(source))
				violations.push(file.replace(`${sourceRoot}/`, ""));
		}
		expect(violations).toEqual([]);
	});
});

function plainSpaces(value: string) {
	return value.replace(/[\u00a0\u202f]/g, " ");
}

async function sourceFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "paraglide") return [];
				return sourceFiles(path);
			}
			return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
		}),
	);
	return files.flat();
}
