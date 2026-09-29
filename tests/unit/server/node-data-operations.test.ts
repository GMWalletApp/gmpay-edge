import { execFile } from "node:child_process";
import {
	appendFile,
	cp,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
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

describe("Bun data operations", () => {
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
			await restoredDatabase
				.prepare("PRAGMA integrity_check")
				.first<string>("integrity_check"),
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

	it("refuses tampered, forged, padded, or malformed backups", async () => {
		const root = await temporaryDirectory();
		const data = join(root, "data");
		const backup = join(root, "backup");
		await mkdir(data);
		const database = openNodeDatabase(join(data, "gmpay.sqlite"));
		await applyNodeMigrations(database);
		database.close();
		await runDataCommand(data, "backup", "--output", backup);

		const tampered = join(root, "tampered");
		await cp(backup, tampered, { recursive: true });
		await appendFile(join(tampered, "gmpay.sqlite"), "x");

		const forged = join(root, "forged");
		await cp(backup, forged, { recursive: true });
		const manifest = JSON.parse(
			await readFile(join(forged, "manifest.json"), "utf8"),
		) as { files: Array<{ name: string; bytes: number; sha256: string }> };
		const [first] = manifest.files;
		if (!first) throw new Error("Expected a manifest entry");
		first.sha256 = "0".repeat(64);
		await writeFile(join(forged, "manifest.json"), JSON.stringify(manifest));

		const padded = join(root, "padded");
		await cp(backup, padded, { recursive: true });
		await mkdir(join(padded, "objects"), { recursive: true });
		await writeFile(join(padded, "objects", "planted.bin"), "planted");

		const malformed = join(root, "malformed");
		await cp(backup, malformed, { recursive: true });
		await writeFile(
			join(malformed, "manifest.json"),
			JSON.stringify({ ...manifest, format: 2 }),
		);

		for (const [input, message] of [
			[tampered, "Backup file checksums do not match the manifest"],
			[forged, "Backup file checksums do not match the manifest"],
			[padded, "Backup file checksums do not match the manifest"],
			[malformed, "Unsupported or invalid backup manifest"],
		] as const) {
			const target = join(root, `restored-${input.split("/").at(-1)}`);
			await expect(
				runDataCommand(target, "restore", "--input", input),
			).rejects.toThrow(message);
			expect(await isMissingOrEmpty(target)).toBe(true);
		}
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
		const migrationCount = await database
			.prepare("SELECT count(*) count FROM node_migrations")
			.first<number>("count");
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

async function isMissingOrEmpty(path: string) {
	try {
		return (await readdir(path)).length === 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
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
