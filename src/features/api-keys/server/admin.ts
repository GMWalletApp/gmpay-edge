import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import { setApiKeyEnabled } from "#/features/api-keys/server/enabled";
import { listApiKeys } from "#/features/api-keys/server/list";
import { revokeApiKeyCredential } from "#/features/api-keys/server/revoke";
import { rotateApiKeyCredential } from "#/features/api-keys/server/rotate";
import { DomainError } from "#/lib/domain-error";
import {
	encryptSecret,
	generateApiPid,
	generateApiSecret,
} from "#/lib/secrets";
import { getCloudflareEnv } from "#/server/db.server";
import { loadRequestRuntimeConfig } from "#/server/runtime-config";

const createKeyInput = z.object({
	name: z.string().trim().min(2).max(100),
	scopes: z
		.array(
			z.enum(["orders:create", "orders:read", "orders:update", "assets:read"]),
		)
		.min(1),
});

const listKeysInput = z.object({
	pageIndex: z.number().int().min(0).default(0),
	pageSize: z.number().int().min(1).max(100).default(10),
	search: z.string().trim().max(100).default(""),
});

export const listApiKeysFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof listKeysInput>) =>
		listKeysInput.parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await adminContext(systemPermission("api_keys", "read"));
		return listApiKeys(db, data);
	});

export const createApiKeyFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof createKeyInput>) =>
		createKeyInput.parse(input),
	)
	.handler(async ({ data }) => {
		const { db, request, runtime, user } = await adminContext(
			systemPermission("api_keys", "create"),
		);
		if (!runtime.apiKeyPepper)
			throw new DomainError(
				"api_key_pepper_not_configured",
				503,
				"API key pepper is not configured",
			);
		const secret = generateApiSecret();
		const pid = generateApiPid();
		const id = crypto.randomUUID();
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"INSERT INTO api_keys (id, name, pid, secret_encrypted, scopes, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
				)
				.bind(
					id,
					data.name,
					pid,
					await encryptSecret(secret, runtime.apiKeyPepper),
					JSON.stringify(data.scopes),
					now,
					now,
				),
			db
				.prepare(
					"INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at) VALUES (?, ?, 'api_key.created', 'api_key', ?, ?, ?, ?, ?)",
				)
				.bind(
					crypto.randomUUID(),
					user.id,
					id,
					request.headers.get("x-request-id"),
					request.headers.get("cf-connecting-ip"),
					JSON.stringify({
						name: data.name,
						pid,
						scopes: data.scopes,
						enabled: true,
					}),
					now,
				),
		]);
		return { id, pid, secret };
	});

export const setApiKeyEnabledFn = createServerFn({ method: "POST" })
	.validator((input: { id: string; enabled: boolean }) =>
		z.object({ id: z.uuid(), enabled: z.boolean() }).parse(input),
	)
	.handler(async ({ data }) => {
		const { db, request, user } = await adminContext(
			systemPermission("api_keys", "update"),
		);
		return setApiKeyEnabled(db, {
			...data,
			actorUserId: user.id,
			requestId: request.headers.get("x-request-id"),
			ipAddress: request.headers.get("cf-connecting-ip"),
		});
	});

export const revokeApiKeyFn = createServerFn({ method: "POST" })
	.validator((input: { id: string }) => z.object({ id: z.uuid() }).parse(input))
	.handler(async ({ data }) => {
		const { db, request, user } = await adminContext(
			systemPermission("api_keys", "delete"),
		);
		return revokeApiKeyCredential(db, {
			id: data.id,
			actorUserId: user.id,
			requestId: request.headers.get("x-request-id"),
			ipAddress: request.headers.get("cf-connecting-ip"),
		});
	});

export const rotateApiKeyFn = createServerFn({ method: "POST" })
	.validator((input: { id: string }) => z.object({ id: z.uuid() }).parse(input))
	.handler(async ({ data }) => {
		const context = await adminContext(systemPermission("api_keys", "update"));
		if (!context.runtime.apiKeyPepper)
			throw new DomainError(
				"api_key_pepper_not_configured",
				503,
				"API key pepper is not configured",
			);
		const rotated = await rotateApiKeyCredential(context.db, {
			id: data.id,
			pepper: context.runtime.apiKeyPepper,
		});
		await context.db
			.prepare(
				"INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at) VALUES (?, ?, 'api_key.rotated', 'api_key', ?, ?, ?, ?, ?)",
			)
			.bind(
				crypto.randomUUID(),
				context.user.id,
				data.id,
				context.request.headers.get("x-request-id"),
				context.request.headers.get("cf-connecting-ip"),
				JSON.stringify({ pid: rotated.pid }),
				rotated.rotatedAt,
			)
			.run();
		return { id: rotated.id, pid: rotated.pid, secret: rotated.secret };
	});

async function adminContext(permission: ReturnType<typeof systemPermission>) {
	const request = getRequest();
	const user = await requireAdmin(request, permission);
	const env = getCloudflareEnv(request);
	if (!env.DB) throw new Error("D1 binding DB is unavailable");
	const runtime = await loadRequestRuntimeConfig(
		request,
		env.DB,
		new URL(request.url).origin,
	);
	return { db: env.DB, env, request, runtime, user };
}
