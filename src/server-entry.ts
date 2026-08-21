import {
	createStartHandler,
	defaultStreamHandler,
} from "@tanstack/react-start/server";
import { handleLivenessRequest } from "#/features/status/server/health";
import { applySecurityHeaders } from "#/server/http-security";
import { validateRequestAuthority } from "#/server/middleware/authority";
import { handleI18nRequest } from "#/server/middleware/i18n";
import { handleQueue } from "#/server/queue";
import { adaptCloudflareEnv } from "#/server/runtime/cloudflare";
import { runWithRuntimeEnv } from "#/server/runtime/context";
import type { RuntimeEnv } from "#/server/runtime/types";
import { handleScheduled } from "#/server/scheduled";
import { appendServerTiming, takeRequestTiming } from "#/server/server-timing";

const appFetch = createStartHandler(defaultStreamHandler);

export async function handleAppRequest(request: Request, env: RuntimeEnv) {
	const startedAt = performance.now();
	const liveness = handleLivenessRequest(request);
	if (liveness)
		return applySecurityHeaders(
			request,
			appendServerTiming(liveness, [
				{ name: "total", durationMs: performance.now() - startedAt },
			]),
		);
	const authorityStartedAt = performance.now();
	const rejected = await validateRequestAuthority(request, env.DB);
	const authorityDurationMs = performance.now() - authorityStartedAt;
	if (rejected)
		return applySecurityHeaders(
			request,
			appendServerTiming(rejected, [
				{ name: "authority", durationMs: authorityDurationMs },
				{ name: "total", durationMs: performance.now() - startedAt },
			]),
		);
	const appStartedAt = performance.now();
	const response = await handleI18nRequest(
		request,
		env.DB,
		env.CACHE,
		appFetch,
	);
	return applySecurityHeaders(
		request,
		appendServerTiming(response, [
			{ name: "authority", durationMs: authorityDurationMs },
			...takeRequestTiming(request),
			{ name: "app", durationMs: performance.now() - appStartedAt },
			{ name: "total", durationMs: performance.now() - startedAt },
		]),
	);
}

export default {
	async fetch(request: Request, env: Env, context: ExecutionContext) {
		const runtimeEnv = adaptCloudflareEnv(env, context.waitUntil.bind(context));
		return runWithRuntimeEnv(runtimeEnv, () =>
			handleAppRequest(request, runtimeEnv),
		);
	},
	queue: handleQueue,
	scheduled: handleScheduled,
};
