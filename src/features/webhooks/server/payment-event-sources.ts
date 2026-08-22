import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import {
	type SystemPermission,
	systemPermission,
} from "#/features/access/system-rbac";
import { paymentEventSourceUpdatePolicy } from "#/features/webhooks/server/payment-event-source-policy";
import { reconcilePaymentEventSource } from "#/features/webhooks/server/payment-event-source-reconciliation";
import {
	loadPaymentProviderEventPage,
	providerEventListSchema,
	retryPaymentProviderEvent,
} from "#/features/webhooks/server/payment-provider-event-admin";
import {
	alchemyEventSourceConfigSchema,
	mergeAlchemyEventSourceConfig,
} from "#/integrations/chains/alchemy-webhook";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { getCloudflareEnv } from "#/server/db.server";
import { loadRequestRuntimeConfig } from "#/server/runtime-config";

const evmNetworkSchema = z.enum(["ethereum", "base", "bsc", "polygon"]);
const alchemyNetworkByRail: Record<z.infer<typeof evmNetworkSchema>, string> = {
	ethereum: "ETH_MAINNET",
	base: "BASE_MAINNET",
	bsc: "BNB_MAINNET",
	polygon: "MATIC_MAINNET",
};
const sourceIdSchema = z.uuid();
const externalSourceIdSchema = z.string().trim().min(4).max(128);
const secretSchema = z.string().trim().min(16).max(512);
const createSourceSchema = z.object({
	id: sourceIdSchema,
	network: evmNetworkSchema,
	externalSourceId: externalSourceIdSchema,
	signingKey: secretSchema,
	authToken: secretSchema,
	enabled: z.boolean().default(false),
});

const updateSourceSchema = z.object({
	id: sourceIdSchema,
	externalSourceId: externalSourceIdSchema,
	signingKey: secretSchema.optional(),
	clearPreviousSigningKey: z.boolean().optional(),
	authToken: secretSchema.optional(),
	mode: z.enum(["shadow", "active"]),
	enabled: z.boolean(),
});

type StoredSource = {
	id: string;
	network: string;
	external_network: string;
	external_source_id: string;
	config_encrypted: string;
	mode: "shadow" | "active";
	enabled: number;
	reconcile_required_at: number | null;
	health_status: string;
	last_error_code: string | null;
};

export const getPaymentEventSourceCallbackOriginFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const context = await sourceAdminContext(
		systemPermission("payment_settings", "read"),
	);
	const runtime = await loadRequestRuntimeConfig(
		context.request,
		context.db,
		new URL(context.request.url).origin,
	);
	return new URL(runtime.betterAuthUrl).origin;
});

export const createPaymentEventSourceFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof createSourceSchema>) =>
		createSourceSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await sourceAdminMutationContext(
			systemPermission("payment_settings", "create"),
		);
		await requireEvmRail(context.db, data.network);
		await requireSourceIdentityAvailable(
			context.db,
			data.id,
			data.network,
			data.externalSourceId,
		);
		const now = Date.now();
		const externalNetwork = alchemyNetworkByRail[data.network];
		const configEncrypted = await encryptSecret(
			JSON.stringify({
				signingKey: data.signingKey,
				authToken: data.authToken,
			}),
			context.runtime.integrationConfigSecret,
		);
		await context.db.batch([
			context.db
				.prepare(
					`INSERT INTO payment_ingresses
					 (id, name, type, transport, provider, network, external_network, external_source_id,
					  config_encrypted, mode, enabled, reconcile_required_at,
					  health_status, created_at, updated_at)
					 VALUES (?, 'Payment event push', 'provider_webhook', 'webhook', 'alchemy', ?, ?, ?, ?, 'shadow', ?, ?, 'unknown', ?, ?)`,
				)
				.bind(
					data.id,
					data.network,
					externalNetwork,
					data.externalSourceId,
					configEncrypted,
					data.enabled,
					data.enabled ? now : null,
					now,
					now,
				),
			auditStatement(context, "payment_event_source.created", data.id, null, {
				provider: "alchemy",
				network: data.network,
				externalNetwork,
				externalSourceId: data.externalSourceId,
				mode: "shadow",
				enabled: data.enabled,
			}),
		]);
		return { id: data.id, mode: "shadow" as const };
	});

export const updatePaymentEventSourceFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof updateSourceSchema>) =>
		updateSourceSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await sourceAdminMutationContext(
			systemPermission("payment_settings", "update"),
		);
		const current = await loadStoredSource(context.db, data.id);
		const { requiresReconcile } = paymentEventSourceUpdatePolicy(
			{
				externalSourceId: current.external_source_id,
				enabled: Boolean(current.enabled),
				healthStatus: current.health_status,
				reconcileRequiredAt: current.reconcile_required_at,
			},
			{
				externalSourceId: data.externalSourceId,
				mode: data.mode,
				enabled: data.enabled,
				authTokenRotated: Boolean(data.authToken),
			},
		);
		await requireSourceIdentityAvailable(
			context.db,
			data.id,
			current.network,
			data.externalSourceId,
			data.id,
		);
		const currentConfig = alchemyEventSourceConfigSchema.parse(
			JSON.parse(
				await decryptSecret(
					current.config_encrypted,
					context.runtime.integrationConfigSecret,
				),
			),
		);
		const nextConfig = mergeAlchemyEventSourceConfig(currentConfig, {
			...(data.signingKey ? { signingKey: data.signingKey } : {}),
			...(data.authToken ? { authToken: data.authToken } : {}),
			...(data.clearPreviousSigningKey ? { previousSigningKey: null } : {}),
		});
		const configEncrypted = await encryptSecret(
			JSON.stringify(nextConfig),
			context.runtime.integrationConfigSecret,
		);
		const now = Date.now();
		const healthStatus = requiresReconcile ? "unknown" : current.health_status;
		const lastErrorCode = requiresReconcile ? null : current.last_error_code;
		await context.db.batch([
			context.db
				.prepare(
					`UPDATE payment_ingresses SET external_source_id = ?,
					 config_encrypted = ?, mode = ?, enabled = ?,
					 reconcile_required_at = ?, health_status = ?,
					 last_error_code = ?, updated_at = ?
					 WHERE id = ? AND type = 'provider_webhook'`,
				)
				.bind(
					data.externalSourceId,
					configEncrypted,
					data.mode,
					data.enabled,
					requiresReconcile ? now : current.reconcile_required_at,
					healthStatus,
					lastErrorCode,
					now,
					data.id,
				),
			auditStatement(
				context,
				"payment_event_source.updated",
				data.id,
				publicSourceState(current),
				{
					externalNetwork: current.external_network,
					externalSourceId: data.externalSourceId,
					mode: data.mode,
					enabled: data.enabled,
					signingKeyRotated: Boolean(data.signingKey),
					managementTokenRotated: Boolean(data.authToken),
					previousSigningKeyChanged:
						Boolean(data.signingKey) || Boolean(data.clearPreviousSigningKey),
				},
			),
		]);
		return { id: data.id, mode: data.mode, enabled: data.enabled };
	});

export const reconcilePaymentEventSourceFn = createServerFn({ method: "POST" })
	.validator((input: { id: string }) =>
		z.object({ id: sourceIdSchema }).parse(input),
	)
	.handler(async ({ data }) => {
		const context = await sourceAdminMutationContext(
			systemPermission("payment_settings", "update"),
		);
		try {
			const result = await reconcilePaymentEventSource(context.db, data.id, {
				force: true,
				runtime: context.runtime,
			});
			await auditStatement(
				context,
				"payment_event_source.reconciled",
				data.id,
				null,
				result,
			).run();
			return result;
		} catch (error) {
			await auditStatement(
				context,
				"payment_event_source.reconcile_failed",
				data.id,
				null,
				{
					errorCode:
						error instanceof DomainError ? error.code : "internal_error",
				},
			).run();
			throw error;
		}
	});

export const listPaymentProviderEventsFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof providerEventListSchema>) =>
		providerEventListSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await sourceAdminContext(
			systemPermission("webhooks", "read"),
		);
		return loadPaymentProviderEventPage(context.db, data);
	});

export const retryPaymentProviderEventFn = createServerFn({ method: "POST" })
	.validator((input: { id: string }) => z.object({ id: z.uuid() }).parse(input))
	.handler(async ({ data }) => {
		const context = await sourceAdminContext(
			systemPermission("webhooks", "update"),
		);
		if (!context.env.PAYMENT_QUEUE)
			throw new DomainError(
				"payment_event_queue_unavailable",
				503,
				"Payment event queue is unavailable",
			);
		const result = await retryPaymentProviderEvent(
			{ DB: context.db, PAYMENT_QUEUE: context.env.PAYMENT_QUEUE },
			data.id,
			Date.now(),
			{
				actorUserId: context.user.id,
				requestId: context.request.headers.get("x-request-id"),
				ipAddress: context.request.headers.get("cf-connecting-ip"),
			},
		);
		return result;
	});

async function sourceAdminContext(permission: SystemPermission) {
	const request = getRequest();
	const user = await requireAdmin(request, permission);
	const env = getCloudflareEnv(request);
	if (!env.DB)
		throw new DomainError(
			"payment_event_source_unavailable",
			503,
			"Payment event push storage is unavailable",
		);
	return { db: env.DB, env, request, user };
}

async function sourceAdminMutationContext(permission: SystemPermission) {
	const context = await sourceAdminContext(permission);
	const runtime = await loadRequestRuntimeConfig(
		context.request,
		context.db,
		new URL(context.request.url).origin,
	);
	return { ...context, runtime };
}

async function requireEvmRail(db: D1Database, network: string) {
	const rail = await db
		.prepare(
			"SELECT code FROM payment_rails WHERE code = ? AND kind = 'chain' AND adapter = 'evm' LIMIT 1",
		)
		.bind(network)
		.first<{ code: string }>();
	if (!rail)
		throw new DomainError(
			"payment_event_source_network_invalid",
			422,
			"Payment event push network is not available",
		);
}

async function requireSourceIdentityAvailable(
	db: D1Database,
	sourceId: string,
	network: string,
	externalSourceId: string,
	excludeId = "",
) {
	const existing = await db
		.prepare(
			`SELECT id FROM payment_ingresses
			 WHERE type = 'provider_webhook' AND provider = 'alchemy' AND id <> ?
			 AND (id = ? OR network = ? OR external_source_id = ?) LIMIT 1`,
		)
		.bind(excludeId, sourceId, network, externalSourceId)
		.first<{ id: string }>();
	if (existing)
		throw new DomainError(
			"payment_event_source_conflict",
			409,
			"Payment event push already exists",
		);
}

async function loadStoredSource(db: D1Database, id: string) {
	const source = await db
		.prepare(
			`SELECT id, network, external_network, external_source_id, config_encrypted,
			 mode, enabled, reconcile_required_at, health_status, last_error_code
			 FROM payment_ingresses
			 WHERE id = ? AND type = 'provider_webhook'
			 AND provider = 'alchemy' LIMIT 1`,
		)
		.bind(id)
		.first<StoredSource>();
	if (!source)
		throw new DomainError(
			"payment_event_source_not_found",
			404,
			"Payment event push not found",
		);
	return source;
}

function publicSourceState(source: StoredSource) {
	return {
		network: source.network,
		externalNetwork: source.external_network,
		externalSourceId: source.external_source_id,
		mode: source.mode,
		enabled: Boolean(source.enabled),
	};
}

function auditStatement(
	context: Awaited<ReturnType<typeof sourceAdminContext>>,
	action: string,
	targetId: string,
	before: Record<string, unknown> | null,
	after: Record<string, unknown> | null,
) {
	return context.db
		.prepare(
			`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, request_id,
			  ip_address, before, after, created_at)
			 VALUES (?, ?, ?, 'payment_event_source', ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			context.user.id,
			action,
			targetId,
			context.request.headers.get("x-request-id"),
			context.request.headers.get("cf-connecting-ip"),
			before ? JSON.stringify(before) : null,
			after ? JSON.stringify(after) : null,
			Date.now(),
		);
}
