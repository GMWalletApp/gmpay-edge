export type DatastoreCounters = {
	d1Prepare: number;
	d1Batch: number;
	d1Exec: number;
	d1StatementBind: number;
	d1StatementRun: number;
	d1StatementFirst: number;
	d1StatementAll: number;
	d1StatementRaw: number;
	kvGet: number;
	kvPut: number;
	kvDelete: number;
	kvList: number;
	r2Get: number;
};

export function createDatastoreCounters(): DatastoreCounters {
	return {
		d1Prepare: 0,
		d1Batch: 0,
		d1Exec: 0,
		d1StatementBind: 0,
		d1StatementRun: 0,
		d1StatementFirst: 0,
		d1StatementAll: 0,
		d1StatementRaw: 0,
		kvGet: 0,
		kvPut: 0,
		kvDelete: 0,
		kvList: 0,
		r2Get: 0,
	};
}

export function instrumentR2(
	bucket: R2Bucket,
	counters: DatastoreCounters,
): R2Bucket {
	return new Proxy(bucket, {
		get(target, property, receiver) {
			if (property === "get")
				return (...args: Parameters<R2Bucket["get"]>) => {
					counters.r2Get += 1;
					return Reflect.apply(target.get, target, args);
				};
			return Reflect.get(target, property, receiver);
		},
	}) as R2Bucket;
}

export function instrumentD1(
	database: D1Database,
	counters: DatastoreCounters,
): D1Database {
	return new Proxy(database, {
		get(target, property, receiver) {
			if (property === "prepare") {
				return (...args: Parameters<D1Database["prepare"]>) => {
					counters.d1Prepare += 1;
					const statement = Reflect.apply(target.prepare, target, args);
					return instrumentD1Statement(statement, counters);
				};
			}
			if (property === "batch") {
				return (...args: Parameters<D1Database["batch"]>) => {
					counters.d1Batch += 1;
					return Reflect.apply(target.batch, target, args);
				};
			}
			if (property === "exec") {
				return (...args: Parameters<D1Database["exec"]>) => {
					counters.d1Exec += 1;
					return Reflect.apply(target.exec, target, args);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	}) as D1Database;
}

function instrumentD1Statement(
	statement: D1PreparedStatement,
	counters: DatastoreCounters,
): D1PreparedStatement {
	return new Proxy(statement, {
		get(target, property, receiver) {
			if (property === "bind") {
				return (...args: Parameters<D1PreparedStatement["bind"]>) => {
					counters.d1StatementBind += 1;
					const bound = Reflect.apply(target.bind, target, args);
					return instrumentD1Statement(bound, counters);
				};
			}
			const count: Partial<Record<string, keyof DatastoreCounters>> = {
				run: "d1StatementRun",
				first: "d1StatementFirst",
				all: "d1StatementAll",
				raw: "d1StatementRaw",
			};
			const counter = count[String(property)];
			if (counter) {
				return (...args: unknown[]) => {
					counters[counter] += 1;
					return Reflect.apply(
						target[property as keyof D1PreparedStatement] as (
							...args: unknown[]
						) => unknown,
						target,
						args,
					);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	}) as D1PreparedStatement;
}

export function instrumentKv(
	kv: KVNamespace,
	counters: DatastoreCounters,
): KVNamespace {
	return new Proxy(kv, {
		get(target, property, receiver) {
			const counter =
				property === "get"
					? "kvGet"
					: property === "put"
						? "kvPut"
						: property === "delete"
							? "kvDelete"
							: property === "list"
								? "kvList"
								: undefined;
			if (counter) {
				return (...args: unknown[]) => {
					counters[counter] += 1;
					return Reflect.apply(
						target[property as keyof KVNamespace] as (
							...args: unknown[]
						) => unknown,
						target,
						args,
					);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	}) as KVNamespace;
}
