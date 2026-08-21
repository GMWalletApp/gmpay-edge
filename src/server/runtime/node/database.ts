import Database from "better-sqlite3";
import type {
	RuntimeDatabase,
	RuntimeDatabaseResult,
	RuntimePreparedStatement,
} from "#/server/runtime/types";

type SqliteValue = null | number | string | bigint | Uint8Array;

export type NodeDatabaseOptions = {
	readonly?: boolean;
	busyTimeoutMs?: number;
};

/**
 * Opens the authoritative Node database with the durability and consistency
 * settings expected by the payment domain.
 */
export function openNodeDatabase(
	filename: string,
	options: NodeDatabaseOptions = {},
) {
	const sqlite = new Database(
		filename,
		options.readonly ? { readonly: true, fileMustExist: true } : {},
	);
	sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
	sqlite.pragma("foreign_keys = ON");
	if (!options.readonly) {
		sqlite.pragma("journal_mode = WAL");
		sqlite.pragma("synchronous = FULL");
	}
	return new NodeDatabase(sqlite);
}

export class NodeDatabase implements RuntimeDatabase {
	constructor(readonly sqlite: Database.Database) {}

	prepare(query: string) {
		return new NodePreparedStatement(this.sqlite, query, []);
	}

	async batch<T = unknown>(statements: RuntimePreparedStatement[]) {
		return this.sqlite.transaction(() =>
			statements.map((statement) => {
				if (
					!(statement instanceof NodePreparedStatement) ||
					!statement.belongsTo(this.sqlite)
				)
					throw new TypeError("Cannot batch a statement from another database");
				return statement.execute<T>();
			}),
		)();
	}

	async exec(query: string) {
		const startedAt = performance.now();
		this.sqlite.exec(query);
		return {
			count: countSqlStatements(query),
			duration: performance.now() - startedAt,
		};
	}

	close() {
		if (this.sqlite.open) this.sqlite.close();
	}
}

export class NodePreparedStatement implements RuntimePreparedStatement {
	constructor(
		private readonly sqlite: Database.Database,
		readonly query: string,
		private readonly values: readonly unknown[],
	) {}

	bind(...values: unknown[]) {
		return new NodePreparedStatement(this.sqlite, this.query, values);
	}

	belongsTo(sqlite: Database.Database) {
		return this.sqlite === sqlite;
	}

	first<T = unknown>(columnName: string): Promise<T | null>;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	async first<T = Record<string, unknown>>(columnName?: string) {
		const statement = this.sqlite.prepare(this.query);
		const row = statement.get(...normalizeBindings(this.values)) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		if (columnName !== undefined) return (row[columnName] ?? null) as T | null;
		return row as T;
	}

	async run<T = Record<string, unknown>>() {
		return this.execute<T>();
	}

	async all<T = Record<string, unknown>>() {
		const statement = this.sqlite.prepare(this.query);
		const startedAt = performance.now();
		const rows = statement.all(...normalizeBindings(this.values)) as T[];
		return result(rows, performance.now() - startedAt);
	}

	raw<T = unknown[]>(options: {
		columnNames: true;
	}): Promise<[string[], ...T[]]>;
	raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
	async raw<T = unknown[]>(options?: { columnNames?: boolean }) {
		const statement = this.sqlite.prepare(this.query);
		statement.raw(true);
		const rows = statement.all(...normalizeBindings(this.values)) as T[];
		if (!options?.columnNames) return rows;
		return [statement.columns().map((column) => column.name), ...rows] as [
			string[],
			...T[],
		];
	}

	execute<T = unknown>(): RuntimeDatabaseResult<T> {
		const statement = this.sqlite.prepare(this.query);
		const startedAt = performance.now();
		if (statement.reader) {
			const rows = statement.all(...normalizeBindings(this.values)) as T[];
			return result(rows, performance.now() - startedAt);
		}
		const info = statement.run(...normalizeBindings(this.values));
		return result<T>([], performance.now() - startedAt, {
			changes: info.changes,
			lastRowId: info.lastInsertRowid,
		});
	}
}

function normalizeBindings(values: readonly unknown[]): SqliteValue[] {
	return values.map((value) => {
		if (value === undefined) return null;
		if (typeof value === "boolean") return value ? 1 : 0;
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "bigint" ||
			value instanceof Uint8Array
		)
			return value;
		if (value instanceof ArrayBuffer) return new Uint8Array(value);
		if (ArrayBuffer.isView(value))
			return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		throw new TypeError(`Unsupported SQLite binding: ${typeof value}`);
	});
}

function result<T>(
	rows: T[],
	durationMs: number,
	write: { changes: number; lastRowId: number | bigint } = {
		changes: 0,
		lastRowId: 0,
	},
) {
	return {
		results: rows,
		success: true as const,
		meta: {
			duration: durationMs,
			size_after: 0,
			rows_read: rows.length,
			rows_written: write.changes,
			last_row_id: Number(write.lastRowId),
			changed_db: write.changes > 0,
			changes: write.changes,
		},
	};
}

function countSqlStatements(query: string) {
	return query
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean).length;
}
