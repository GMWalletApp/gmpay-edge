export type RuntimeKind = "bun" | "cloudflare";

export type RuntimeDatabaseMeta = {
	changes: number;
	[key: string]: unknown;
};

export type RuntimeDatabaseResult<T = unknown> = {
	success: true;
	results: T[];
	meta: RuntimeDatabaseMeta;
};

export type RuntimeDatabaseExecResult = {
	count: number;
	duration: number;
};

export interface RuntimePreparedStatement {
	bind(...values: unknown[]): RuntimePreparedStatement;
	first<T = unknown>(columnName: string): Promise<T | null>;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	run<T = Record<string, unknown>>(): Promise<RuntimeDatabaseResult<T>>;
	all<T = Record<string, unknown>>(): Promise<RuntimeDatabaseResult<T>>;
	raw<T = unknown[]>(options: {
		columnNames: true;
	}): Promise<[string[], ...T[]]>;
	raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
}

export interface RuntimeDatabase {
	prepare(query: string): RuntimePreparedStatement;
	batch<T = unknown>(
		statements: RuntimePreparedStatement[],
	): Promise<RuntimeDatabaseResult<T>[]>;
	exec(query: string): Promise<RuntimeDatabaseExecResult>;
}

export type RuntimeCachePutOptions = {
	expiration?: number;
	expirationTtl?: number;
	metadata?: unknown;
};

export interface RuntimeCache {
	get(key: string): Promise<string | null>;
	put(
		key: string,
		value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
		options?: RuntimeCachePutOptions,
	): Promise<void>;
	delete(key: string): Promise<void>;
}

export type RuntimeObjectHttpMetadata = {
	contentType?: string;
	contentLanguage?: string;
	contentDisposition?: string;
	contentEncoding?: string;
	cacheControl?: string;
	cacheExpiry?: Date;
};

export type RuntimeObjectPutOptions = {
	httpMetadata?: RuntimeObjectHttpMetadata;
	customMetadata?: Record<string, string>;
	md5?: ArrayBuffer | string;
	sha1?: ArrayBuffer | string;
	sha256?: ArrayBuffer | string;
	sha384?: ArrayBuffer | string;
	sha512?: ArrayBuffer | string;
};

export interface RuntimeObjectMetadata {
	readonly key: string;
	readonly version: string;
	readonly size: number;
	readonly etag: string;
	readonly httpEtag: string;
	readonly uploaded: Date;
	readonly httpMetadata?: RuntimeObjectHttpMetadata;
	readonly customMetadata?: Record<string, string>;
	writeHttpMetadata(headers: Headers): void;
}

export interface RuntimeObjectBody extends RuntimeObjectMetadata {
	readonly body: ReadableStream;
	readonly bodyUsed: boolean;
	arrayBuffer(): Promise<ArrayBuffer>;
	bytes(): Promise<Uint8Array>;
	text(): Promise<string>;
	json<T>(): Promise<T>;
	blob(): Promise<Blob>;
}

export interface RuntimeObjectStorage {
	head(key: string): Promise<RuntimeObjectMetadata | null>;
	get(
		key: string,
		options?: { onlyIf?: Headers },
	): Promise<RuntimeObjectBody | RuntimeObjectMetadata | null>;
	put(
		key: string,
		value:
			| ReadableStream
			| ArrayBuffer
			| ArrayBufferView
			| string
			| null
			| Blob,
		options?: RuntimeObjectPutOptions,
	): Promise<RuntimeObjectMetadata | null>;
	delete(keys: string | string[]): Promise<void>;
}

export type RuntimeQueueSendOptions = {
	contentType?: "text" | "bytes" | "json" | "v8";
	delaySeconds?: number;
};

export type RuntimeQueueMessage<T> = RuntimeQueueSendOptions & { body: T };

export interface RuntimeQueue<T = unknown> {
	send(message: T, options?: RuntimeQueueSendOptions): Promise<unknown>;
	sendBatch(
		messages: Iterable<RuntimeQueueMessage<T>>,
		options?: Pick<RuntimeQueueSendOptions, "delaySeconds">,
	): Promise<unknown>;
}

export type RuntimeEmailAddress = string | { email: string; name: string };

export type RuntimeEmailMessage = {
	from?: RuntimeEmailAddress;
	to: RuntimeEmailAddress | RuntimeEmailAddress[];
	cc?: RuntimeEmailAddress | RuntimeEmailAddress[];
	bcc?: RuntimeEmailAddress | RuntimeEmailAddress[];
	replyTo?: RuntimeEmailAddress;
	subject: string;
	headers?: Record<string, string>;
	text?: string;
	html?: string;
};

export interface RuntimeMailSender {
	send(message: RuntimeEmailMessage): Promise<unknown>;
}

export type RuntimeEnv = {
	runtime: RuntimeKind;
	DB?: RuntimeDatabase;
	FILES?: RuntimeObjectStorage;
	CACHE?: RuntimeCache;
	WEBHOOK_QUEUE?: RuntimeQueue;
	PAYMENT_QUEUE?: RuntimeQueue;
	EMAIL?: RuntimeMailSender;
	MAIL?: RuntimeMailSender;
	waitUntil?: (promise: Promise<unknown>) => void;
};

export function requireRuntimeDatabase(
	env: Pick<RuntimeEnv, "DB">,
): RuntimeDatabase {
	if (!env.DB) throw new Error('Runtime database binding "DB" is unavailable.');
	return env.DB;
}
