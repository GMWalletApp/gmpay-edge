import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRuntimeEnv } from "#/server/db.server";
import { runWithRuntimeEnv } from "#/server/runtime/context";
import { createNodeApplication } from "#/server/runtime/node/application";
import type { RuntimeEnv } from "#/server/runtime/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Node server runtime", () => {
	it("keeps runtime bindings isolated across concurrent requests", async () => {
		const first = runtimeEnv("first");
		const second = runtimeEnv("second");
		const [firstValue, secondValue] = await Promise.all([
			runWithRuntimeEnv(first, async () => {
				await Promise.resolve();
				return getRuntimeEnv().DB?.prepare("SELECT 1");
			}),
			runWithRuntimeEnv(second, async () => {
				await Promise.resolve();
				return getRuntimeEnv().DB?.prepare("SELECT 1");
			}),
		]);

		expect(firstValue).toBe("first:SELECT 1");
		expect(secondValue).toBe("second:SELECT 1");
		expect(() => getRuntimeEnv()).toThrow(/outside a server request/);
	});

	it("migrates and opens the persistent Node application layout", async () => {
		const directory = await mkdtemp(join(tmpdir(), "gmpay-node-server-"));
		temporaryDirectories.push(directory);
		const application = await createNodeApplication(directory);
		try {
			const database = application.env.DB;
			expect(database).toBeDefined();
			const migration = await database
				?.prepare("SELECT COUNT(*) AS count FROM node_migrations")
				.first<{ count: number }>();
			expect(migration?.count).toBeGreaterThan(0);
			expect(application.dataDirectory).toBe(directory);
			expect(application.env.runtime).toBe("node");
			expect(application.env.MAIL).toBeDefined();
		} finally {
			await application.stop();
		}
	});

	it("refuses to open data while an offline maintenance task holds the lock", async () => {
		const directory = await mkdtemp(join(tmpdir(), "gmpay-node-server-"));
		temporaryDirectories.push(directory);
		await writeFile(join(directory, ".maintenance.lock"), "backup");

		await expect(createNodeApplication(directory)).rejects.toThrow(
			/Data maintenance is active/,
		);
	});
});

function runtimeEnv(name: string): RuntimeEnv {
	return {
		runtime: "node",
		DB: {
			prepare(query) {
				return `${name}:${query}` as never;
			},
			batch: async () => [],
			exec: async () => ({ count: 0, duration: 0 }),
		},
	};
}
