import { createStart } from "@tanstack/react-start";
import {
	createStartHandler,
	defaultStreamHandler,
} from "@tanstack/react-start/server";
import { handleLivenessRequest } from "#/features/status/server/health";
import { applySecurityHeaders } from "#/server/http-security";
import { requestMiddleware } from "#/server/middleware";
import { validateRequestAuthority } from "#/server/middleware/authority";
import { handleI18nRequest } from "#/server/middleware/i18n";
import { handleQueue } from "#/server/queue";
import { handleScheduled } from "#/server/scheduled";
import { serverFunctionErrorMiddleware } from "#/server/server-function-errors";
import { appendServerTiming, takeRequestTiming } from "#/server/server-timing";

export const startInstance = createStart(() => ({
	requestMiddleware,
	functionMiddleware: [serverFunctionErrorMiddleware],
}));

const appFetch = createStartHandler(defaultStreamHandler);

export default {
	async fetch(request: Request, env: Env) {
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
	},
	queue: handleQueue,
	scheduled: handleScheduled,
};
