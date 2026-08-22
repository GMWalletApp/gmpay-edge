import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { NodeDatabase } from "./database";

const MIGRATION_PATTERN = /^\d+_.+\.sql$/;

export type NodeMigration = {
	name: string;
	sql: string;
	checksum: string;
};

export async function loadNodeMigrations(
	directory: URL | string = new URL("../../../../drizzle/", import.meta.url),
): Promise<NodeMigration[]> {
	const files = (await readdir(directory))
		.filter((name) => MIGRATION_PATTERN.test(name))
		.sort();
	return Promise.all(
		files.map(async (name) => {
			const sql = await readFile(
				typeof directory === "string"
					? new URL(name, `file://${resolve(directory)}/`)
					: new URL(name, directory),
				"utf8",
			);
			return { name, sql, checksum: sha256(sql) };
		}),
	);
}

export async function applyNodeMigrations(
	database: NodeDatabase,
	directory: URL | string = new URL("../../../../drizzle/", import.meta.url),
) {
	const migrations = await loadNodeMigrations(directory);

	const apply = database.sqlite.transaction(() => {
		database.sqlite.run(`CREATE TABLE IF NOT EXISTS node_migrations (
			name TEXT PRIMARY KEY NOT NULL,
			checksum TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		)`);
		const applied = database.sqlite.prepare(
			"SELECT checksum FROM node_migrations WHERE name = ?",
		);
		const record = database.sqlite.prepare(
			"INSERT INTO node_migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
		);
		let appliedCount = 0;
		for (const migration of migrations) {
			const existing = applied.get(migration.name) as
				| { checksum: string }
				| undefined;
			if (existing) {
				if (existing.checksum !== migration.checksum)
					throw new Error(`Applied migration changed: ${migration.name}`);
				continue;
			}
			for (const statement of splitMigration(migration.sql))
				database.sqlite.run(statement);
			record.run(migration.name, migration.checksum, Date.now());
			appliedCount += 1;
		}
		return appliedCount;
	});

	return { applied: apply(), total: migrations.length };
}

function splitMigration(sql: string) {
	return sql
		.split("--> statement-breakpoint")
		.map((statement) => statement.trim())
		.filter(Boolean);
}

function sha256(value: string) {
	return createHash("sha256").update(value).digest("hex");
}
