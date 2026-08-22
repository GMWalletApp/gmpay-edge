/// <reference types="bun-types-no-globals/lib/index.d.ts" />
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
	cp,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	rmdir,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { NodeDataLayout } from "#/server/runtime/node/data-layout";
import { resolveNodeDataLayout } from "#/server/runtime/node/data-layout";
import type { NodeMigration } from "#/server/runtime/node/migrations";
import { loadNodeMigrations } from "#/server/runtime/node/migrations";
import type { StoredObjectMetadata } from "#/server/runtime/node/object-storage";
import {
	NodeObjectStorage,
	parseStoredObjectMetadata,
	resolveNodeObjectPaths,
} from "#/server/runtime/node/object-storage";
import type {
	RuntimeObjectHttpMetadata,
	RuntimeObjectPutOptions,
} from "#/server/runtime/types";

const MANIFEST_FILENAME = "manifest.json";
const BACKUP_FORMAT = 1;

type Environment = Record<string, string | undefined>;
type CommandOptions = Record<string, string | boolean | undefined>;
type ImportCloudflareOptions = {
	dataDirectory: string;
	d1Sql: string;
	r2Directory?: string;
	r2Manifest?: string;
};
type BackupFile = { name: string; bytes: number; sha256: string };
type BackupManifest = {
	format: number;
	createdAt: string;
	files: BackupFile[];
};

if (import.meta.main) {
	try {
		await runNodeDataCommand(process.argv.slice(2), process.env);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

export async function runNodeDataCommand(
	argv: string[],
	environment: Environment = process.env,
) {
	const [command, ...values] = argv;
	if (
		command === "--help" ||
		command === "-h" ||
		command === "help" ||
		!command
	) {
		printUsage();
		return;
	}
	const options = parseOptions(values);
	if (options.help) {
		printUsage();
		return;
	}
	const dataDirectory = requiredDataDirectory(options, environment);
	if (command === "backup") {
		await backupNodeData(dataDirectory, requiredPath(options, "output"));
		return;
	}
	if (command === "restore") {
		await restoreNodeData(requiredPath(options, "input"), dataDirectory);
		return;
	}
	if (command === "import-cloudflare") {
		await importCloudflareData({
			dataDirectory,
			d1Sql: requiredPath(options, "d1-sql"),
			r2Directory:
				typeof options["r2-dir"] === "string"
					? resolve(options["r2-dir"])
					: undefined,
			r2Manifest:
				typeof options["r2-manifest"] === "string"
					? resolve(options["r2-manifest"])
					: undefined,
		});
		return;
	}
	throw new Error(`Unknown command: ${command}`);
}

export async function backupNodeData(
	dataDirectory: string,
	outputDirectory: string,
) {
	const layout = resolveNodeDataLayout(dataDirectory);
	await requireFile(layout.database, "Node database");
	await assertOutsideDataDirectory(layout.root, outputDirectory);
	await prepareEmptyDestination(outputDirectory);
	const releaseLock = await acquireMaintenanceLock(layout);
	const staging = stagingPath(outputDirectory);
	try {
		await mkdir(staging, { recursive: true });
		const source = openDataDatabase(layout.database, false);
		try {
			validateDatabase(source, await loadNodeMigrations());
			await writeFile(
				join(staging, basename(layout.database)),
				source.serialize(),
				{ flag: "wx" },
			);
		} finally {
			source.close();
		}
		if (await exists(layout.objects))
			await cp(layout.objects, join(staging, basename(layout.objects)), {
				recursive: true,
				errorOnExist: true,
				force: false,
			});
		await validateObjectStore(join(staging, basename(layout.objects)));
		const files = await checksums(staging);
		await writeFile(
			join(staging, MANIFEST_FILENAME),
			`${JSON.stringify(
				{
					format: BACKUP_FORMAT,
					createdAt: new Date().toISOString(),
					files,
				},
				null,
				2,
			)}\n`,
			{ flag: "wx" },
		);
		await installStagingDirectory(staging, outputDirectory);
		console.log(`Backup written to ${outputDirectory}`);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	} finally {
		await releaseLock();
	}
}

export async function restoreNodeData(
	inputDirectory: string,
	dataDirectory: string,
) {
	await requireDirectory(inputDirectory, "Backup directory");
	await prepareEmptyDestination(dataDirectory);
	await verifyManifest(inputDirectory);
	const staging = stagingPath(dataDirectory);
	const layout = resolveNodeDataLayout(staging);
	try {
		await mkdir(staging, { recursive: true });
		await cp(join(inputDirectory, basename(layout.database)), layout.database, {
			errorOnExist: true,
			force: false,
		});
		if (await exists(join(inputDirectory, basename(layout.objects))))
			await cp(join(inputDirectory, basename(layout.objects)), layout.objects, {
				recursive: true,
				errorOnExist: true,
				force: false,
			});
		await validateDatabaseFile(layout.database);
		await validateObjectStore(layout.objects);
		await installStagingDirectory(staging, dataDirectory);
		console.log(`Backup restored to ${dataDirectory}`);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

export async function importCloudflareData({
	dataDirectory,
	d1Sql,
	r2Directory,
	r2Manifest,
}: ImportCloudflareOptions) {
	await requireFile(d1Sql, "D1 SQL export");
	if (r2Directory) await requireDirectory(r2Directory, "R2 export directory");
	if (r2Manifest) {
		await requireFile(r2Manifest, "R2 metadata manifest");
		if (!r2Directory) throw new Error("--r2-manifest requires --r2-dir");
	}
	await prepareEmptyDestination(dataDirectory);
	const staging = stagingPath(dataDirectory);
	const layout = resolveNodeDataLayout(staging);
	try {
		await mkdir(staging, { recursive: true });
		const database = openDataDatabase(layout.database);
		try {
			database.run(await readFile(d1Sql, "utf8"));
			const migrations = await loadNodeMigrations();
			seedNodeMigrations(database, migrations);
			validateDatabase(database, migrations);
		} finally {
			database.close();
		}
		if (r2Directory)
			await importR2Directory(
				r2Directory,
				layout.objects,
				r2Manifest ? await readR2Manifest(r2Manifest) : new Map(),
			);
		await validateObjectStore(layout.objects);
		await installStagingDirectory(staging, dataDirectory);
		console.log(`Cloudflare export imported to ${dataDirectory}`);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

async function validateDatabaseFile(filename: string) {
	const database = openDataDatabase(filename, false);
	try {
		validateDatabase(database, await loadNodeMigrations());
	} finally {
		database.close();
	}
}

function validateDatabase(database: Database, migrations: NodeMigration[]) {
	const integrity = database.query("PRAGMA integrity_check").get() as
		| { integrity_check: string }
		| undefined;
	if (integrity?.integrity_check !== "ok")
		throw new Error(
			`SQLite integrity check failed: ${integrity?.integrity_check ?? "no result"}`,
		);
	const foreignKeys = database.query("PRAGMA foreign_key_check").all();
	if (foreignKeys.length > 0)
		throw new Error(
			`SQLite foreign-key check failed (${foreignKeys.length} violation(s))`,
		);
	const table = database
		.query(
			"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'node_migrations'",
		)
		.get();
	if (!table) throw new Error("Database is missing the node_migrations table");
	const applied = new Map(
		database
			.query("SELECT name, checksum FROM node_migrations")
			.all()
			.map((row) => {
				const record = row as { name: string; checksum: string };
				return [record.name, record.checksum] as const;
			}),
	);
	for (const migration of migrations) {
		if (applied.get(migration.name) !== migration.checksum)
			throw new Error(`Migration is missing or has changed: ${migration.name}`);
	}
}

function seedNodeMigrations(database: Database, migrations: NodeMigration[]) {
	const d1Table = database
		.query(
			"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
		)
		.get();
	if (!d1Table) throw new Error("D1 export is missing the d1_migrations table");
	const applied = new Set(
		database
			.query("SELECT name FROM d1_migrations")
			.all()
			.map((row) => (row as { name: string }).name),
	);
	const missing = migrations.filter(
		(migration) => !applied.has(migration.name),
	);
	if (missing.length > 0)
		throw new Error(
			`D1 export is missing required migrations: ${missing.map(({ name }) => name).join(", ")}`,
		);
	database.run(`CREATE TABLE node_migrations (
		name TEXT PRIMARY KEY NOT NULL,
		checksum TEXT NOT NULL,
		applied_at INTEGER NOT NULL
	)`);
	const insert = database.query(
		"INSERT INTO node_migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
	);
	const now = Date.now();
	database.transaction(() => {
		for (const migration of migrations)
			insert.run(migration.name, migration.checksum, now);
	})();
}

function openDataDatabase(filename: string, create = true) {
	const database = new Database(filename, {
		create,
		strict: true,
	});
	database.run("PRAGMA busy_timeout = 5000");
	database.run("PRAGMA foreign_keys = ON");
	database.run("PRAGMA journal_mode = WAL");
	database.run("PRAGMA synchronous = FULL");
	return database;
}

async function importR2Directory(
	source: string,
	destination: string,
	manifest: ReadonlyMap<string, RuntimeObjectPutOptions>,
) {
	const objects = new NodeObjectStorage(destination);
	const importedKeys = new Set<string>();
	for (const filename of await listFiles(source)) {
		const key = relative(source, filename).split(sep).join("/");
		const details = await stat(filename);
		if (!details.isFile()) continue;
		await objects.put(key, await readFile(filename), manifest.get(key));
		importedKeys.add(key);
	}
	const missingObjects = [...manifest.keys()].filter(
		(key) => !importedKeys.has(key),
	);
	if (missingObjects.length > 0)
		throw new Error(
			`R2 metadata manifest references missing objects: ${missingObjects.join(", ")}`,
		);
}

async function readR2Manifest(
	filename: string,
): Promise<Map<string, RuntimeObjectPutOptions>> {
	const value: unknown = JSON.parse(await readFile(filename, "utf8"));
	if (!isRecord(value)) throw new Error("Invalid R2 metadata manifest");
	return new Map(
		Object.entries(value).map(([key, metadata]) => [
			key,
			parseR2ManifestEntry(metadata, key),
		]),
	);
}

function parseR2ManifestEntry(
	value: unknown,
	key: string,
): RuntimeObjectPutOptions {
	if (!key || !isRecord(value)) throw new Error("Invalid R2 metadata manifest");
	const allowed = new Set(["httpMetadata", "customMetadata"]);
	if (Object.keys(value).some((name) => !allowed.has(name)))
		throw new Error(`Invalid R2 metadata manifest entry: ${key}`);
	return {
		...(value.httpMetadata === undefined
			? {}
			: { httpMetadata: parseR2HttpMetadata(value.httpMetadata, key) }),
		...(value.customMetadata === undefined
			? {}
			: { customMetadata: parseStringRecord(value.customMetadata, key) }),
	};
}

function parseR2HttpMetadata(
	value: unknown,
	key: string,
): RuntimeObjectHttpMetadata {
	if (!isRecord(value)) throw new Error(`Invalid R2 HTTP metadata: ${key}`);
	const stringFields = [
		"contentType",
		"contentLanguage",
		"contentDisposition",
		"contentEncoding",
		"cacheControl",
	] as const;
	const allowed = new Set([...stringFields, "cacheExpiry"]);
	if (Object.keys(value).some((name) => !allowed.has(name)))
		throw new Error(`Invalid R2 HTTP metadata: ${key}`);
	const metadata: RuntimeObjectHttpMetadata = {};
	for (const field of stringFields) {
		const fieldValue = value[field];
		if (fieldValue === undefined) continue;
		if (typeof fieldValue !== "string")
			throw new Error(`Invalid R2 HTTP metadata: ${key}`);
		metadata[field] = fieldValue;
	}
	if (value.cacheExpiry !== undefined) {
		if (typeof value.cacheExpiry !== "string")
			throw new Error(`Invalid R2 HTTP metadata: ${key}`);
		const cacheExpiry = new Date(value.cacheExpiry);
		if (Number.isNaN(cacheExpiry.getTime()))
			throw new Error(`Invalid R2 HTTP metadata: ${key}`);
		metadata.cacheExpiry = cacheExpiry;
	}
	return metadata;
}

function parseStringRecord(
	value: unknown,
	key: string,
): Record<string, string> {
	if (
		!isRecord(value) ||
		Object.values(value).some((item) => typeof item !== "string")
	)
		throw new Error(`Invalid R2 custom metadata: ${key}`);
	return value as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

async function validateObjectStore(root: string) {
	if (!(await exists(root))) return;
	const metadataRoot = join(root, "metadata");
	if (!(await exists(metadataRoot))) return;
	for (const filename of await listFiles(metadataRoot)) {
		if (!filename.endsWith(".json"))
			throw new Error(
				`Unexpected object metadata file: ${relative(root, filename)}`,
			);
		let metadata: StoredObjectMetadata;
		try {
			metadata = parseStoredObjectMetadata(
				JSON.parse(await readFile(filename, "utf8")),
			);
		} catch {
			throw new Error(`Invalid object metadata: ${relative(root, filename)}`);
		}
		const paths = resolveNodeObjectPaths(root, metadata.key);
		if (resolve(filename) !== resolve(paths.metadata))
			throw new Error(`Invalid object metadata: ${relative(root, filename)}`);
		const dataPath = join(paths.dataDirectory, metadata.dataFile);
		const content = await readFile(dataPath);
		if (
			content.byteLength !== metadata.size ||
			createHash("sha256").update(content).digest("hex") !== metadata.etag
		)
			throw new Error(`Object checksum mismatch: ${metadata.key}`);
	}
}

async function verifyManifest(directory: string) {
	const manifest = parseBackupManifest(
		JSON.parse(await readFile(join(directory, MANIFEST_FILENAME), "utf8")),
	);
	const actual = await checksums(directory, new Set([MANIFEST_FILENAME]));
	if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
		throw new Error("Backup file checksums do not match the manifest");
}

function parseBackupManifest(value: unknown): BackupManifest {
	if (!value || typeof value !== "object")
		throw new Error("Unsupported or invalid backup manifest");
	const manifest = value as Partial<BackupManifest>;
	if (
		manifest.format !== BACKUP_FORMAT ||
		typeof manifest.createdAt !== "string" ||
		!Array.isArray(manifest.files) ||
		!manifest.files.every(
			(file) =>
				typeof file?.name === "string" &&
				typeof file.bytes === "number" &&
				Number.isSafeInteger(file.bytes) &&
				file.bytes >= 0 &&
				typeof file.sha256 === "string" &&
				/^[a-f0-9]{64}$/.test(file.sha256),
		)
	)
		throw new Error("Unsupported or invalid backup manifest");
	return manifest as BackupManifest;
}

async function checksums(
	root: string,
	ignored: ReadonlySet<string> = new Set(),
): Promise<BackupFile[]> {
	const files: BackupFile[] = [];
	for (const filename of await listFiles(root)) {
		const name = relative(root, filename).split(sep).join("/");
		if (ignored.has(name)) continue;
		const content = await readFile(filename);
		files.push({
			name,
			bytes: content.byteLength,
			sha256: createHash("sha256").update(content).digest("hex"),
		});
	}
	return files.sort((left, right) => left.name.localeCompare(right.name));
}

async function listFiles(root: string): Promise<string[]> {
	if (!(await exists(root))) return [];
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isSymbolicLink())
			throw new Error(`Symbolic links are not allowed: ${path}`);
		if (entry.isDirectory()) files.push(...(await listFiles(path)));
		else if (entry.isFile()) files.push(path);
	}
	return files.sort();
}

async function acquireMaintenanceLock(layout: NodeDataLayout) {
	await mkdir(layout.root, { recursive: true });
	try {
		const handle = await open(layout.maintenanceLock, "wx");
		await handle.writeFile(`${process.pid}\n`);
		return async () => {
			await handle.close();
			await rm(layout.maintenanceLock, { force: true });
		};
	} catch (error) {
		if (isErrnoException(error) && error.code === "EEXIST")
			throw new Error(
				`Node data is already in maintenance: ${layout.maintenanceLock}`,
			);
		throw error;
	}
}

async function prepareEmptyDestination(path: string) {
	const resolved = resolve(path);
	if (!(await exists(resolved))) return;
	const details = await stat(resolved);
	if (!details.isDirectory())
		throw new Error(`Destination is not a directory: ${resolved}`);
	if ((await readdir(resolved)).length > 0)
		throw new Error(`Refusing to overwrite non-empty destination: ${resolved}`);
}

async function installStagingDirectory(staging: string, destination: string) {
	if (await exists(destination)) await rmdir(destination);
	await rename(staging, destination);
}

async function assertOutsideDataDirectory(
	dataDirectory: string,
	outputDirectory: string,
) {
	const path = resolve(outputDirectory);
	const nested =
		path === dataDirectory || path.startsWith(`${dataDirectory}${sep}`);
	if (nested) throw new Error("Backup output must be outside GMPAY_DATA_DIR");
}

async function requireFile(path: string, label: string) {
	const details = await stat(path).catch(() => undefined);
	if (!details?.isFile()) throw new Error(`${label} does not exist: ${path}`);
}

async function requireDirectory(path: string, label: string) {
	const details = await stat(path).catch(() => undefined);
	if (!details?.isDirectory())
		throw new Error(`${label} does not exist: ${path}`);
}

async function exists(path: string) {
	return stat(path).then(
		() => true,
		() => false,
	);
}

function stagingPath(destination: string) {
	const path = resolve(destination);
	return join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
}

function parseOptions(values: string[]): CommandOptions {
	const options: CommandOptions = {};
	for (let index = 0; index < values.length; index += 1) {
		const name = values[index];
		if (name === "--help" || name === "-h") {
			options.help = true;
			continue;
		}
		if (!name?.startsWith("--"))
			throw new Error(`Unexpected argument: ${name}`);
		const value = values[index + 1];
		if (!value || value.startsWith("--"))
			throw new Error(`Missing value for ${name}`);
		options[name.slice(2)] = value;
		index += 1;
	}
	return options;
}

function requiredDataDirectory(
	options: CommandOptions,
	environment: Environment,
) {
	const value = options["data-dir"] ?? environment.GMPAY_DATA_DIR;
	if (typeof value !== "string" || !value)
		throw new Error("Set GMPAY_DATA_DIR or pass --data-dir explicitly");
	return resolve(value);
}

function requiredPath(options: CommandOptions, name: string) {
	const value = options[name];
	if (typeof value !== "string" || !value)
		throw new Error(`Missing required --${name}`);
	return resolve(value);
}

function printUsage() {
	console.log(`Usage:
  bun run data -- backup --output <new-directory> [--data-dir <directory>]
  bun run data -- restore --input <backup-directory> [--data-dir <new-or-empty-directory>]
  bun run data -- import-cloudflare --d1-sql <export.sql> [--r2-dir <directory>] [--r2-manifest <metadata.json>] [--data-dir <new-or-empty-directory>]

GMPAY_DATA_DIR supplies --data-dir when the option is omitted.`);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
