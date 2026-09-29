import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getInstallStatus = vi.hoisted(() => vi.fn());

vi.mock("#/features/installation/server/functions", () => ({
	getInstallStatus,
}));
vi.mock("#/features/installation/pages/install", () => ({
	InstallPage: () => null,
}));

import { Route } from "#/routes/install";

describe("public installation status", () => {
	beforeEach(() => getInstallStatus.mockReset());

	it("redirects an installed instance away from the installer", async () => {
		getInstallStatus.mockResolvedValue({ installed: true });
		await expect(runLoader()).rejects.toMatchObject({
			options: { to: "/admin" },
		});
		expect(getInstallStatus).toHaveBeenCalledTimes(1);
	});

	it("keeps the installer reachable while no enabled root user exists", async () => {
		getInstallStatus.mockResolvedValue({ installed: false });
		await expect(runLoader()).resolves.toBeUndefined();
	});

	it("exposes only the boolean install state from the public read", () => {
		const source = readFileSync(
			resolve("src/features/installation/server/functions.ts"),
			"utf8",
		);
		const handler = source.slice(
			source.indexOf("export const getInstallStatus"),
			source.indexOf("export const installSystemFn"),
		);
		expect(handler).toContain("return { installed: await isInstalled(db) };");
		expect(handler).not.toMatch(/INSERT|UPDATE|DELETE|runtime/);
	});
});

function runLoader() {
	const loader = Route.options.loader;
	if (!loader) throw new Error("Install route loader is missing");
	return (loader as (input: unknown) => Promise<unknown>)({});
}
