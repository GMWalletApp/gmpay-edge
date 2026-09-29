import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { paymentSettingsPermission } from "#/features/access/system-rbac";
import { paymentSettingsError } from "#/features/payment-settings/errors";
import { adminContext } from "#/features/payment-settings/server/admin-context";
import {
	loadRateSyncConfiguration,
	loadRatesPageData,
	refreshExchangeRates,
	saveRateSyncConfiguration,
} from "#/features/payment-settings/server/exchange-rates";
import { requestId } from "#/server/http";

const rateSyncCategoryInput = z.object({
	category: z.enum(["crypto", "fiat"]),
});

export const getRatesPageFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof rateSyncCategoryInput>) =>
		rateSyncCategoryInput.parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await adminContext(paymentSettingsPermission("read"));
		return loadRatesPageData(db, data.category);
	});

const updateManualRatesInput = z.object({
	rates: z
		.array(
			z.object({
				id: z.string().trim().min(1).max(128),
				category: z.enum(["crypto", "fiat"]),
				rate: z
					.string()
					.trim()
					.regex(/^\d+(?:\.\d+)?$/),
			}),
		)
		.min(1)
		.max(500),
});

// A manual correction is an operator-attested observation; it stays quotable
// until a synchronization replaces it, matching the catalog seed validity.
const MANUAL_RATE_VALIDITY_MS = 10 * 365 * 86_400_000;

export const updateManualRatesFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof updateManualRatesInput>) =>
		updateManualRatesInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(paymentSettingsPermission("update"));
		const now = Date.now();
		const results = await context.db.batch(
			data.rates.map((rate) =>
				context.db
					.prepare(
						`UPDATE exchange_rates SET rate = ?, observed_at = ?, expires_at = ?,
						 updated_at = ? WHERE id = ? AND category = ?`,
					)
					.bind(
						rate.rate,
						now,
						now + MANUAL_RATE_VALIDITY_MS,
						now,
						rate.id,
						rate.category,
					),
			),
		);
		if (results.some((result) => result.meta.changes !== 1))
			throw paymentSettingsError("exchange_rate_not_found");
		return { updated: data.rates.length };
	});

const saveRateSyncSettingsInput = z.discriminatedUnion("category", [
	z.object({
		category: z.literal("crypto"),
		enabled: z.boolean(),
		provider: z.enum(["binance", "okx"]),
		intervalMs: z.number().int().min(60_000).max(604_800_000),
		adjustmentBps: z.number().int().min(-9_999).max(100_000),
		runNow: z.boolean().optional(),
	}),
	z.object({
		category: z.literal("fiat"),
		enabled: z.boolean(),
		provider: z.literal("exchangerate_host"),
		intervalMs: z.number().int().min(300_000).max(2_592_000_000),
		adjustmentBps: z.number().int().min(-9_999).max(100_000),
		apiKey: z.string().trim().max(512).optional(),
		runNow: z.boolean().optional(),
	}),
]);

export const saveRateSyncSettingsFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof saveRateSyncSettingsInput>) =>
		saveRateSyncSettingsInput.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await adminContext(paymentSettingsPermission("update"));
		const now = Date.now();
		if (data.category === "crypto") {
			const current = await loadRateSyncConfiguration(context.db, "crypto");
			const configuration = {
				...current,
				enabled: data.enabled,
				provider: data.provider,
				intervalMs: data.intervalMs,
				adjustmentBps: data.adjustmentBps,
			};
			await saveRateSyncConfiguration(
				context.db,
				"crypto",
				configuration,
				context.user.id,
				now,
			);
			await auditRateSyncSettings(
				context,
				data.category,
				{
					enabled: data.enabled,
					provider: data.provider,
					intervalMs: data.intervalMs,
					adjustmentBps: data.adjustmentBps,
					credentialsChanged: false,
				},
				now,
			);
			if (data.runNow)
				return refreshExchangeRates(context.db, fetch, now, {
					category: "crypto",
					provider: configuration.provider,
					configuration,
					...rateSyncAuditContext(context),
				});
			return { saved: true, hasCredentials: false };
		}
		const current = await loadRateSyncConfiguration(context.db, "fiat");
		const apiKey = data.apiKey?.trim() || current.credentials.apiKey;
		if (!apiKey) throw paymentSettingsError("fiat_rate_credentials_required");
		const configuration = {
			...current,
			enabled: data.enabled,
			provider: data.provider,
			intervalMs: data.intervalMs,
			adjustmentBps: data.adjustmentBps,
			credentials: { apiKey },
		};
		await saveRateSyncConfiguration(
			context.db,
			"fiat",
			configuration,
			context.user.id,
			now,
		);
		await auditRateSyncSettings(
			context,
			data.category,
			{
				enabled: data.enabled,
				provider: data.provider,
				intervalMs: data.intervalMs,
				adjustmentBps: data.adjustmentBps,
				credentialsChanged: Boolean(data.apiKey?.trim()),
			},
			now,
		);
		if (data.runNow)
			return refreshExchangeRates(context.db, fetch, now, {
				category: "fiat",
				apiKey,
				configuration,
				...rateSyncAuditContext(context),
			});
		return { saved: true, hasCredentials: true };
	});

async function auditRateSyncSettings(
	context: Awaited<ReturnType<typeof adminContext>>,
	category: "crypto" | "fiat",
	details: {
		enabled: boolean;
		provider: string;
		intervalMs: number;
		adjustmentBps?: number;
		credentialsChanged: boolean;
	},
	now: number,
) {
	await context.db
		.prepare(
			`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, request_id,
			  ip_address, after, created_at)
			 VALUES (?, ?, 'rate_sync.settings_updated', 'rate_sync', ?, ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			context.user.id,
			category,
			requestId(context.request),
			context.request.headers.get("cf-connecting-ip"),
			JSON.stringify(details),
			now,
		)
		.run();
}

function rateSyncAuditContext(
	context: Awaited<ReturnType<typeof adminContext>>,
) {
	return {
		actorUserId: context.user.id,
		requestId: requestId(context.request),
		ipAddress: context.request.headers.get("cf-connecting-ip"),
	};
}
