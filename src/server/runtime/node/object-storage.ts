import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
	RuntimeObjectBody,
	RuntimeObjectHttpMetadata,
	RuntimeObjectMetadata,
	RuntimeObjectPutOptions,
	RuntimeObjectStorage,
} from "#/server/runtime/types";

export type StoredObjectMetadata = {
	key: string;
	version: string;
	dataFile: string;
	size: number;
	etag: string;
	uploadedAt: number;
	httpMetadata?: RuntimeObjectHttpMetadata;
	customMetadata?: Record<string, string>;
};

export class NodeObjectStorage implements RuntimeObjectStorage {
	constructor(private readonly rootDirectory: string) {}

	async head(key: string) {
		const stored = await this.readMetadata(key);
		return stored ? new NodeObject(stored) : null;
	}

	async get(
		key: string,
		options?: { onlyIf?: Headers },
	): Promise<RuntimeObjectBody | RuntimeObjectMetadata | null> {
		const stored = await this.readMetadata(key);
		if (!stored) return null;
		const metadata = new NodeObject(stored);
		if (options?.onlyIf && !conditionMatches(metadata, options.onlyIf))
			return metadata;
		const path = `${resolveNodeObjectPaths(this.rootDirectory, key).dataDirectory}/${stored.dataFile}`;
		if (!existsSync(path)) return null;
		const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
		return new NodeObjectBody(stored, stream);
	}

	async put(
		key: string,
		value:
			| ReadableStream
			| ArrayBuffer
			| ArrayBufferView
			| string
			| null
			| Blob,
		options: RuntimeObjectPutOptions = {},
	) {
		if (!key) throw new TypeError("Object key must not be empty");
		const paths = resolveNodeObjectPaths(this.rootDirectory, key);
		await Promise.all([
			mkdir(paths.dataDirectory, { recursive: true }),
			mkdir(paths.metadataDirectory, { recursive: true }),
		]);
		const previous = await this.readMetadata(key);
		const version = randomUUID();
		const dataFile = `${paths.hash}.${version}`;
		const finalData = `${paths.dataDirectory}/${dataFile}`;
		const temporaryData = `${finalData}.tmp`;
		const temporaryMetadata = `${paths.metadata}.${randomUUID()}.tmp`;
		const hash = createHash("sha256");
		let metadataCommitted = false;
		const tap = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				hash.update(chunk);
				callback(null, chunk);
			},
		});
		try {
			await pipeline(
				toNodeStream(value),
				tap,
				createWriteStream(temporaryData, { flags: "wx" }),
			);
			const details = await stat(temporaryData);
			const etag = hash.digest("hex");
			const metadata: StoredObjectMetadata = {
				key,
				version,
				dataFile,
				size: details.size,
				etag,
				uploadedAt: Date.now(),
				...(options.httpMetadata ? { httpMetadata: options.httpMetadata } : {}),
				...(options.customMetadata
					? { customMetadata: options.customMetadata }
					: {}),
			};
			await writeFile(temporaryMetadata, JSON.stringify(metadata), {
				flag: "wx",
			});
			await rename(temporaryData, finalData);
			await rename(temporaryMetadata, paths.metadata);
			metadataCommitted = true;
			if (previous)
				await rm(`${paths.dataDirectory}/${previous.dataFile}`, {
					force: true,
				}).catch(() => undefined);
			return new NodeObject(metadata);
		} catch (error) {
			await Promise.all([
				rm(temporaryData, { force: true }),
				rm(temporaryMetadata, { force: true }),
				...(metadataCommitted ? [] : [rm(finalData, { force: true })]),
			]);
			throw error;
		}
	}

	async delete(keys: string | string[]) {
		await Promise.all(
			(typeof keys === "string" ? [keys] : keys).map(async (key) => {
				const paths = resolveNodeObjectPaths(this.rootDirectory, key);
				const metadata = await this.readMetadata(key);
				await rm(paths.metadata, { force: true });
				if (metadata)
					await rm(`${paths.dataDirectory}/${metadata.dataFile}`, {
						force: true,
					});
			}),
		);
	}

	private async readMetadata(key: string) {
		try {
			const value = JSON.parse(
				await readFile(
					resolveNodeObjectPaths(this.rootDirectory, key).metadata,
					"utf8",
				),
			);
			return parseStoredObjectMetadata(value, key);
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	}
}

class NodeObject implements RuntimeObjectMetadata {
	readonly key: string;
	readonly version: string;
	readonly size: number;
	readonly etag: string;
	readonly httpEtag: string;
	readonly uploaded: Date;
	readonly httpMetadata?: RuntimeObjectHttpMetadata;
	readonly customMetadata?: Record<string, string>;

	constructor(metadata: StoredObjectMetadata) {
		this.key = metadata.key;
		this.version = metadata.version;
		this.size = metadata.size;
		this.etag = metadata.etag;
		this.httpEtag = `"${metadata.etag}"`;
		this.uploaded = new Date(metadata.uploadedAt);
		this.httpMetadata = metadata.httpMetadata;
		this.customMetadata = metadata.customMetadata;
	}

	writeHttpMetadata(headers: Headers) {
		const metadata = this.httpMetadata;
		if (!metadata) return;
		if (metadata.contentType) headers.set("content-type", metadata.contentType);
		if (metadata.contentLanguage)
			headers.set("content-language", metadata.contentLanguage);
		if (metadata.contentDisposition)
			headers.set("content-disposition", metadata.contentDisposition);
		if (metadata.contentEncoding)
			headers.set("content-encoding", metadata.contentEncoding);
		if (metadata.cacheControl)
			headers.set("cache-control", metadata.cacheControl);
		if (metadata.cacheExpiry)
			headers.set("expires", new Date(metadata.cacheExpiry).toUTCString());
	}
}

class NodeObjectBody extends NodeObject implements RuntimeObjectBody {
	private readonly response: Response;

	constructor(
		metadata: StoredObjectMetadata,
		readonly body: ReadableStream,
	) {
		super(metadata);
		this.response = new Response(body);
	}

	get bodyUsed() {
		return this.response.bodyUsed;
	}

	arrayBuffer() {
		return this.response.arrayBuffer();
	}

	async bytes() {
		return new Uint8Array(await this.arrayBuffer());
	}

	text() {
		return this.response.text();
	}

	async json<T>() {
		return (await this.response.json()) as T;
	}

	blob() {
		return this.response.blob();
	}
}

function conditionMatches(object: NodeObject, conditions: Headers) {
	const ifMatch = conditions.get("if-match");
	if (ifMatch && ifMatch !== "*" && ifMatch !== object.httpEtag) return false;
	const ifNoneMatch = conditions.get("if-none-match");
	if (ifNoneMatch && (ifNoneMatch === "*" || ifNoneMatch === object.httpEtag))
		return false;
	return true;
}

function toNodeStream(
	value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
) {
	if (value === null) return Readable.from([]);
	if (typeof value === "string") return Readable.from([value]);
	if (value instanceof Blob) return Readable.fromWeb(value.stream() as never);
	if (value instanceof ArrayBuffer)
		return Readable.from([new Uint8Array(value)]);
	if (ArrayBuffer.isView(value))
		return Readable.from([
			new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
		]);
	return Readable.fromWeb(value as never);
}

export function resolveNodeObjectPaths(rootDirectory: string, key: string) {
	const hash = createHash("sha256").update(key).digest("hex");
	const prefix = `${hash.slice(0, 2)}/${hash.slice(2, 4)}`;
	const dataDirectory = `${rootDirectory}/data/${prefix}`;
	const metadataDirectory = `${rootDirectory}/metadata/${prefix}`;
	return {
		hash,
		dataDirectory,
		metadataDirectory,
		metadata: `${metadataDirectory}/${hash}.json`,
	};
}

export function parseStoredObjectMetadata(
	value: unknown,
	expectedKey?: string,
): StoredObjectMetadata {
	if (!value || typeof value !== "object")
		throw new Error("Invalid object metadata");
	const metadata = value as Partial<StoredObjectMetadata>;
	if (
		typeof metadata.key !== "string" ||
		(expectedKey !== undefined && metadata.key !== expectedKey) ||
		typeof metadata.version !== "string" ||
		typeof metadata.dataFile !== "string" ||
		!/^[a-f0-9]{64}\.[0-9a-f-]{36}$/.test(metadata.dataFile) ||
		typeof metadata.size !== "number" ||
		typeof metadata.etag !== "string" ||
		typeof metadata.uploadedAt !== "number"
	)
		throw new Error("Invalid object metadata");
	return {
		key: metadata.key,
		version: metadata.version,
		dataFile: metadata.dataFile,
		size: metadata.size,
		etag: metadata.etag,
		uploadedAt: metadata.uploadedAt,
		...(metadata.httpMetadata === undefined
			? {}
			: { httpMetadata: parseStoredHttpMetadata(metadata.httpMetadata) }),
		...(metadata.customMetadata === undefined
			? {}
			: { customMetadata: parseStoredCustomMetadata(metadata.customMetadata) }),
	};
}

function parseStoredHttpMetadata(value: unknown): RuntimeObjectHttpMetadata {
	if (!isRecord(value)) throw new Error("Invalid object metadata");
	const fields = [
		"contentType",
		"contentLanguage",
		"contentDisposition",
		"contentEncoding",
		"cacheControl",
	] as const;
	const allowed = new Set([...fields, "cacheExpiry"]);
	if (Object.keys(value).some((name) => !allowed.has(name)))
		throw new Error("Invalid object metadata");
	const metadata: RuntimeObjectHttpMetadata = {};
	for (const field of fields) {
		const item = value[field];
		if (item === undefined) continue;
		if (typeof item !== "string") throw new Error("Invalid object metadata");
		metadata[field] = item;
	}
	if (value.cacheExpiry !== undefined) {
		if (
			typeof value.cacheExpiry !== "string" &&
			!(value.cacheExpiry instanceof Date)
		)
			throw new Error("Invalid object metadata");
		const cacheExpiry = new Date(value.cacheExpiry);
		if (Number.isNaN(cacheExpiry.getTime()))
			throw new Error("Invalid object metadata");
		metadata.cacheExpiry = cacheExpiry;
	}
	return metadata;
}

function parseStoredCustomMetadata(value: unknown): Record<string, string> {
	if (
		!isRecord(value) ||
		Object.values(value).some((item) => typeof item !== "string")
	)
		throw new Error("Invalid object metadata");
	return value as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(error: unknown) {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}
