import { drizzle } from "drizzle-orm/d1";
import * as schema from "#/db/schema";
import { currentRuntimeEnv } from "#/server/runtime/context";

export type AppBindings = {
	DB?: D1Database;
	FILES?: R2Bucket;
	CACHE?: KVNamespace;
	WEBHOOK_QUEUE?: Queue;
	PAYMENT_QUEUE?: Queue;
	EMAIL?: SendEmail;
};

export function getCloudflareEnv(_request?: Request) {
	return currentRuntimeEnv() as AppBindings;
}

export function getRuntimeEnv(_request?: Request) {
	return currentRuntimeEnv();
}

export function getEnv(): Env {
	return currentRuntimeEnv() as unknown as Env;
}

function createDb(d1: D1Database) {
	return drizzle(d1, { schema });
}

export function getDb(request?: Request) {
	const d1 = getRuntimeEnv(request).DB;
	if (!d1) throw new Error('Runtime database binding "DB" is unavailable.');
	return createDb(d1 as D1Database);
}

export type AppDb = ReturnType<typeof createDb>;
