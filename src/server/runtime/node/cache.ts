import type { RuntimeCache } from "#/server/runtime/types";

type CacheValue = {
	value: Uint8Array;
	expiresAt: number | null;
};

export type NodeMemoryCacheOptions = {
	maxEntries?: number;
	now?: () => number;
};

export class NodeMemoryCache implements RuntimeCache {
	private readonly entries = new Map<string, CacheValue>();
	private readonly maxEntries: number;
	private readonly now: () => number;

	constructor(options: NodeMemoryCacheOptions = {}) {
		this.maxEntries = Math.max(1, options.maxEntries ?? 10_000);
		this.now = options.now ?? Date.now;
	}

	get(key: string): Promise<string | null>;
	get<T = unknown>(key: string, type: "json"): Promise<T | null>;
	get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
	get(key: string, type: "stream"): Promise<ReadableStream | null>;
	async get<T = unknown>(
		key: string,
		typeOrOptions?:
			| "text"
			| "json"
			| "arrayBuffer"
			| "stream"
			| { type?: "text" | "json" | "arrayBuffer" | "stream" },
	) {
		const entry = this.entries.get(key);
		if (!entry) return null;
		if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			return null;
		}
		this.entries.delete(key);
		this.entries.set(key, entry);
		const type =
			typeof typeOrOptions === "string"
				? typeOrOptions
				: (typeOrOptions?.type ?? "text");
		if (type === "arrayBuffer") return entry.value.slice().buffer;
		if (type === "stream")
			return new Blob([entry.value.slice()]).stream() as ReadableStream;
		const text = new TextDecoder().decode(entry.value);
		if (type === "json") return JSON.parse(text) as T;
		return text;
	}

	async put(
		key: string,
		value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
		options: { expiration?: number; expirationTtl?: number } = {},
	) {
		const bytes = await toBytes(value);
		const now = this.now();
		const expiresAt = options.expiration
			? options.expiration * 1_000
			: options.expirationTtl
				? now + options.expirationTtl * 1_000
				: null;
		this.entries.delete(key);
		this.entries.set(key, { value: bytes, expiresAt });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	async delete(key: string) {
		this.entries.delete(key);
	}

	clear() {
		this.entries.clear();
	}
}

async function toBytes(
	value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
) {
	if (typeof value === "string") return new TextEncoder().encode(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value))
		return new Uint8Array(
			value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
		);
	return new Uint8Array(await new Response(value).arrayBuffer());
}
