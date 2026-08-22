import { z } from "zod";
import type { ProviderPaymentTrigger } from "#/features/payments/types";
import { constantTimeEqual, hmacSha256Hex } from "#/lib/crypto";

const hexHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const hexQuantitySchema = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
const hexEventIndexSchema = hexQuantitySchema
	.transform((value) => Number.parseInt(value, 16))
	.refine(Number.isSafeInteger);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const managementDeadlineMs = 25_000;
const maximumActivitiesPerDelivery = 2_000;

export const alchemyEventSourceConfigSchema = z.object({
	signingKey: z.string().min(16).max(512),
	previousSigningKey: z.string().min(16).max(512).optional(),
	authToken: z.string().min(16).max(512).optional(),
});

type AlchemyEventSourceConfig = z.infer<typeof alchemyEventSourceConfigSchema>;

export function mergeAlchemyEventSourceConfig(
	current: AlchemyEventSourceConfig,
	update: {
		signingKey?: string;
		previousSigningKey?: string | null;
		authToken?: string;
	},
): AlchemyEventSourceConfig {
	const signingKey = update.signingKey ?? current.signingKey;
	const previousSigningKey =
		update.previousSigningKey === null
			? undefined
			: (update.previousSigningKey ??
				(update.signingKey ? current.signingKey : current.previousSigningKey));
	const authToken = update.authToken ?? current.authToken;
	return {
		signingKey,
		...(previousSigningKey ? { previousSigningKey } : {}),
		...(authToken ? { authToken } : {}),
	};
}

const activitySchema = z.object({
	blockNum: hexQuantitySchema,
	hash: hexHashSchema,
	fromAddress: addressSchema,
	toAddress: addressSchema,
	asset: z.string().trim().min(1).max(32).nullish(),
	category: z.enum([
		"external",
		"internal",
		"erc20",
		"erc721",
		"erc1155",
		"token",
	]),
	erc721TokenId: z.unknown().nullish(),
	erc1155Metadata: z.unknown().nullish(),
	rawContract: z
		.object({
			address: addressSchema.nullish(),
		})
		.nullish(),
	log: z
		.object({
			logIndex: hexEventIndexSchema,
			removed: z.boolean().optional(),
		})
		.nullish(),
});

const addressActivitySchema = z.object({
	webhookId: z.string().min(1).max(128),
	id: z.string().min(1).max(128),
	createdAt: z
		.string()
		.min(1)
		.max(64)
		.refine((value) => !Number.isNaN(Date.parse(value))),
	type: z.literal("ADDRESS_ACTIVITY"),
	event: z.union([
		z.object({
			network: z.string().min(1).max(64).optional(),
			error: z.string().min(1).max(1_000),
		}),
		z.object({
			network: z.string().min(1).max(64),
			activity: z.array(z.unknown()).max(maximumActivitiesPerDelivery),
		}),
	]),
});

export type AlchemyAddressActivity = {
	providerEventId: string;
	externalSourceId: string;
	externalNetwork: string | null;
	createdAt: string;
	invalidActivityCount: number;
	providerErrorCode?: "provider_error";
	activities: Array<{
		activityIndex: number;
		trigger: ProviderPaymentTrigger;
	}>;
};

export async function verifyAlchemyWebhookSignature(
	rawBody: string,
	suppliedSignature: string,
	config: z.infer<typeof alchemyEventSourceConfigSchema>,
) {
	const keys = [config.signingKey, config.previousSigningKey].filter(
		(value): value is string => Boolean(value),
	);
	const expected = await Promise.all(
		keys.map((key) => hmacSha256Hex(key, rawBody)),
	);
	return expected.some((signature) =>
		constantTimeEqual(suppliedSignature.toLowerCase(), signature),
	);
}

export function parseAlchemyAddressActivity(
	input: unknown,
): AlchemyAddressActivity {
	const payload = addressActivitySchema.parse(input);
	if ("error" in payload.event)
		return {
			providerEventId: payload.id,
			externalSourceId: payload.webhookId,
			externalNetwork: payload.event.network ?? null,
			createdAt: payload.createdAt,
			invalidActivityCount: 0,
			providerErrorCode: "provider_error",
			activities: [],
		};
	const activities: AlchemyAddressActivity["activities"] = [];
	let invalidActivityCount = 0;
	for (const [
		activityIndex,
		inputActivity,
	] of payload.event.activity.entries()) {
		const parsedActivity = activitySchema.safeParse(inputActivity);
		if (!parsedActivity.success) {
			invalidActivityCount += 1;
			continue;
		}
		const activity = parsedActivity.data;
		if (
			activity.category === "internal" ||
			activity.category === "erc721" ||
			activity.category === "erc1155" ||
			activity.erc721TokenId != null ||
			activity.erc1155Metadata != null ||
			!activity.asset
		)
			continue;
		const tokenTransfer = activity.category !== "external";
		if (tokenTransfer && (!activity.log || !activity.rawContract?.address))
			continue;
		activities.push({
			activityIndex,
			trigger: {
				transactionHash: activity.hash.toLowerCase(),
				eventIndex: tokenTransfer ? (activity.log?.logIndex ?? 0) : 0,
				fromAddress: activity.fromAddress.toLowerCase(),
				toAddress: activity.toAddress.toLowerCase(),
				assetCode: activity.asset.toUpperCase(),
				contractAddress: activity.rawContract?.address?.toLowerCase() ?? null,
				blockNumber: activity.blockNum,
				removed: activity.log?.removed ?? false,
			},
		});
	}
	return {
		providerEventId: payload.id,
		externalSourceId: payload.webhookId,
		externalNetwork: payload.event.network,
		createdAt: payload.createdAt,
		invalidActivityCount,
		activities,
	};
}

const addressPageSchema = z.object({
	data: z.array(addressSchema).max(100),
	pagination: z.object({
		cursors: z.object({ after: z.string().max(512).nullish() }),
	}),
});

const teamWebhooksSchema = z.object({
	data: z.array(
		z.object({
			id: z.string().min(1).max(128),
			network: z.string().min(1).max(64),
			webhook_type: z.string().min(1).max(64),
			webhook_url: z.url().max(2_048),
			is_active: z.boolean(),
		}),
	),
});

export class AlchemyWebhookManagementError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "AlchemyWebhookManagementError";
	}
}

export async function reconcileAlchemyWebhookAddresses(
	input: {
		authToken: string;
		externalSourceId: string;
		externalNetwork: string;
		webhookUrl: string;
		requireActive: boolean;
		desiredAddresses: readonly string[];
	},
	fetchFn: typeof fetch = fetch,
) {
	const signal = AbortSignal.timeout(managementDeadlineMs);
	await validateAlchemyWebhook(input, fetchFn, signal);
	let remoteAddresses: string[];
	try {
		remoteAddresses = await loadAlchemyWebhookAddresses(input, fetchFn, signal);
	} catch (error) {
		if (
			error instanceof AlchemyWebhookManagementError &&
			error.code === "address_limit"
		)
			return replaceAlchemyWebhookAddresses(input, fetchFn, signal);
		throw error;
	}
	const remote = new Set(
		remoteAddresses.map((address) => address.toLowerCase()),
	);
	const desired = new Set(
		input.desiredAddresses.map((address) => address.toLowerCase()),
	);
	const additions = [...desired].filter((address) => !remote.has(address));
	const removals = [...remote].filter((address) => !desired.has(address));
	for (
		let offset = 0;
		offset < Math.max(additions.length, removals.length);
		offset += 500
	) {
		const response = await fetchFn(
			"https://dashboard.alchemy.com/api/update-webhook-addresses",
			{
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					"x-alchemy-token": input.authToken,
				},
				body: JSON.stringify({
					webhook_id: input.externalSourceId,
					addresses_to_add: additions.slice(offset, offset + 500),
					addresses_to_remove: removals.slice(offset, offset + 500),
				}),
				signal,
			},
		);
		if (!response.ok)
			throw new AlchemyWebhookManagementError(
				managementErrorCode(response.status),
			);
	}
	return {
		remoteCount: remote.size,
		desiredCount: desired.size,
		added: additions.length,
		removed: removals.length,
		replaced: false,
	};
}

async function validateAlchemyWebhook(
	input: Pick<
		Parameters<typeof reconcileAlchemyWebhookAddresses>[0],
		| "authToken"
		| "externalSourceId"
		| "externalNetwork"
		| "webhookUrl"
		| "requireActive"
	>,
	fetchFn: typeof fetch,
	signal: AbortSignal,
) {
	const response = await fetchFn(
		"https://dashboard.alchemy.com/api/team-webhooks",
		{
			headers: { "x-alchemy-token": input.authToken },
			signal,
		},
	);
	if (!response.ok)
		throw new AlchemyWebhookManagementError(
			managementErrorCode(response.status),
		);
	let parsed: z.infer<typeof teamWebhooksSchema>;
	try {
		parsed = teamWebhooksSchema.parse(await response.json());
	} catch {
		throw new AlchemyWebhookManagementError("invalid_response");
	}
	const webhook = parsed.data.find(
		(entry) => entry.id === input.externalSourceId,
	);
	if (!webhook) throw new AlchemyWebhookManagementError("webhook_not_found");
	if (webhook.webhook_type !== "ADDRESS_ACTIVITY")
		throw new AlchemyWebhookManagementError("webhook_type_mismatch");
	if (webhook.network !== input.externalNetwork)
		throw new AlchemyWebhookManagementError("webhook_network_mismatch");
	if (normalizedUrl(webhook.webhook_url) !== normalizedUrl(input.webhookUrl))
		throw new AlchemyWebhookManagementError("webhook_url_mismatch");
	if (input.requireActive && !webhook.is_active)
		throw new AlchemyWebhookManagementError("webhook_inactive");
}

async function replaceAlchemyWebhookAddresses(
	input: Pick<
		Parameters<typeof reconcileAlchemyWebhookAddresses>[0],
		"authToken" | "externalSourceId" | "desiredAddresses"
	>,
	fetchFn: typeof fetch,
	signal: AbortSignal,
) {
	const response = await fetchFn(
		"https://dashboard.alchemy.com/api/update-webhook-addresses",
		{
			method: "PUT",
			headers: {
				"content-type": "application/json",
				"x-alchemy-token": input.authToken,
			},
			body: JSON.stringify({
				webhook_id: input.externalSourceId,
				addresses: input.desiredAddresses,
			}),
			signal,
		},
	);
	if (!response.ok)
		throw new AlchemyWebhookManagementError(
			managementErrorCode(response.status),
		);
	return {
		remoteCount: null,
		desiredCount: input.desiredAddresses.length,
		added: 0,
		removed: 0,
		replaced: true,
	};
}

async function loadAlchemyWebhookAddresses(
	input: Pick<
		Parameters<typeof reconcileAlchemyWebhookAddresses>[0],
		"authToken" | "externalSourceId"
	>,
	fetchFn: typeof fetch,
	signal: AbortSignal,
) {
	const addresses: string[] = [];
	let after: string | undefined;
	for (let page = 0; page < 20; page += 1) {
		const url = new URL("https://dashboard.alchemy.com/api/webhook-addresses");
		url.searchParams.set("webhook_id", input.externalSourceId);
		url.searchParams.set("limit", "100");
		if (after) url.searchParams.set("after", after);
		const response = await fetchFn(url, {
			headers: { "x-alchemy-token": input.authToken },
			signal,
		});
		if (!response.ok)
			throw new AlchemyWebhookManagementError(
				managementErrorCode(response.status),
			);
		let parsed: z.infer<typeof addressPageSchema>;
		try {
			parsed = addressPageSchema.parse(await response.json());
		} catch {
			throw new AlchemyWebhookManagementError("invalid_response");
		}
		addresses.push(...parsed.data);
		after = parsed.pagination.cursors.after ?? undefined;
		if (!after) return addresses;
	}
	throw new AlchemyWebhookManagementError("address_limit");
}

function managementErrorCode(status: number) {
	if (status === 401 || status === 403) return "authentication";
	if (status === 429) return "rate_limit";
	if (status >= 500) return "network";
	return "configuration";
}

function normalizedUrl(input: string) {
	const url = new URL(input);
	url.hash = "";
	return url.href;
}
