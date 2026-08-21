import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyNodeMigrations,
	NodeObjectStorage,
	openNodeDatabase,
} from "#/server/runtime/node";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			rm(directory, {
				recursive: true,
				force: true,
			}),
		),
	);
});

describe("Node data operations", () => {
	it("backs up and restores a validated database and object store", async () => {
		const root = await temporaryDirectory();
		const data = join(root, "data");
		const backup = join(root, "backup");
		const restored = join(root, "restored");
		await mkdir(data);
		const database = openNodeDatabase(join(data, "gmpay.sqlite"));
		await applyNodeMigrations(database);
		database.close();
		const objects = new NodeObjectStorage(join(data, "objects"));
		await objects.put("uploads/example.txt", "backup me");

		await runDataCommand(data, "backup", "--output", backup);
		await runDataCommand(restored, "restore", "--input", backup);

		const restoredDatabase = openNodeDatabase(join(restored, "gmpay.sqlite"), {
			readonly: true,
		});
		expect(
			restoredDatabase.sqlite.pragma("integrity_check", { simple: true }),
		).toBe("ok");
		restoredDatabase.close();
		const restoredObject = await new NodeObjectStorage(
			join(restored, "objects"),
		).get("uploads/example.txt");
		expect(restoredObject && "text" in restoredObject).toBe(true);
		if (restoredObject && "text" in restoredObject)
			expect(await restoredObject.text()).toBe("backup me");
	});

	it("refuses to overwrite a non-empty restore target", async () => {
		const root = await temporaryDirectory();
		const backup = join(root, "backup");
		const target = join(root, "target");
		await Promise.all([mkdir(backup), mkdir(target)]);
		await writeFile(join(target, "keep.txt"), "keep");

		await expect(
			runDataCommand(target, "restore", "--input", backup),
		).rejects.toThrow("Refusing to overwrite non-empty destination");
		expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("keep");
	});

	it("restores into an existing empty target", async () => {
		const root = await temporaryDirectory();
		const data = join(root, "data");
		const backup = join(root, "backup");
		const target = join(root, "target");
		await Promise.all([mkdir(data), mkdir(target)]);
		const database = openNodeDatabase(join(data, "gmpay.sqlite"));
		await applyNodeMigrations(database);
		database.close();

		await runDataCommand(data, "backup", "--output", backup);
		await runDataCommand(target, "restore", "--input", backup);

		expect(
			(await readFile(join(target, "gmpay.sqlite"))).byteLength,
		).toBeGreaterThan(0);
	});

	it("imports a D1 SQL export and an R2 key directory", async () => {
		const root = await temporaryDirectory();
		const exportFile = join(root, "d1.sql");
		const r2 = join(root, "r2");
		const r2Manifest = join(root, "r2-metadata.json");
		const target = join(root, "node-data");
		await mkdir(join(r2, "evidence"), { recursive: true });
		await writeFile(join(r2, "evidence", "receipt.txt"), "receipt");
		await writeFile(
			r2Manifest,
			JSON.stringify({
				"evidence/receipt.txt": {
					httpMetadata: { contentType: "text/plain; charset=utf-8" },
					customMetadata: { orderId: "order-123" },
				},
			}),
		);
		await writeFile(exportFile, await createD1ExportSql());

		await runDataCommand(
			target,
			"import-cloudflare",
			"--d1-sql",
			exportFile,
			"--r2-dir",
			r2,
			"--r2-manifest",
			r2Manifest,
		);

		const database = openNodeDatabase(join(target, "gmpay.sqlite"), {
			readonly: true,
		});
		const migrationCount = database.sqlite
			.prepare("SELECT count(*) count FROM node_migrations")
			.pluck()
			.get();
		expect(migrationCount).toBeGreaterThan(0);
		database.close();
		const object = await new NodeObjectStorage(join(target, "objects")).get(
			"evidence/receipt.txt",
		);
		if (!object || !("text" in object))
			throw new Error("Imported object missing");
		expect(await object.text()).toBe("receipt");
		expect(object.httpMetadata?.contentType).toBe("text/plain; charset=utf-8");
		expect(object.customMetadata).toEqual({ orderId: "order-123" });
	});
});

async function runDataCommand(dataDirectory: string, ...args: string[]) {
	return execFileAsync("bun", ["run", "data", "--", ...args], {
		cwd: process.cwd(),
		env: { ...process.env, GMPAY_DATA_DIR: dataDirectory },
	});
}

async function temporaryDirectory() {
	const directory = join(
		tmpdir(),
		`gmpay-node-data-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	await mkdir(directory);
	temporaryDirectories.push(directory);
	return directory;
}

async function createD1ExportSql() {
	const drizzle = join(process.cwd(), "drizzle");
	const migrations = (await readdir(drizzle))
		.filter((name) => /^\d+_.+\.sql$/.test(name))
		.sort();
	const statements = await Promise.all(
		migrations.map((name) => readFile(join(drizzle, name), "utf8")),
	);
	return `
		CREATE TABLE d1_migrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT UNIQUE,
			applied_at TEXT NOT NULL
		);
		${migrations
			.map(
				(name, index) =>
					`INSERT INTO d1_migrations (id, name, applied_at) VALUES (${index + 1}, '${name}', CURRENT_TIMESTAMP);`,
			)
			.join("\n")}
		${statements.join("\n")}
	`;
}
