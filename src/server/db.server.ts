import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "#/db/schema";

type CloudflareEnv = {
	DB?: D1Database;
	FILES?: R2Bucket;
	CACHE?: KVNamespace;
	WEBHOOK_QUEUE?: Queue;
	PAYMENT_QUEUE?: Queue;
	AUTH_EMAIL?: SendEmail;
};

export function getCloudflareEnv(_request?: Request) {
	return env as CloudflareEnv;
}

export function getEnv(): Env {
	return env as Env;
}

function createDb(d1: D1Database) {
	return drizzle(d1, { schema });
}

export function getDb(request?: Request) {
	const d1 = getCloudflareEnv(request).DB;
	if (!d1) throw new Error('Cloudflare D1 binding "DB" is unavailable.');
	return createDb(d1);
}

export type AppDb = ReturnType<typeof createDb>;
