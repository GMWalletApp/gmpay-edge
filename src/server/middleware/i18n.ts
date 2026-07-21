import { loadSiteBrandOrDefault } from "#/features/settings/server/site-brand";
import { localeFromCookie, setSystemDefaultLocale } from "#/lib/i18n-runtime";
import { paraglideMiddleware } from "#/paraglide/server";

export async function handleI18nRequest(
	request: Request,
	db: D1Database | undefined,
	cache: KVNamespace | undefined,
	resolve: (request: Request) => Response | Promise<Response>,
) {
	if (!localeFromCookie(request.headers.get("cookie"))) {
		const { defaultLocale } = await loadSiteBrandOrDefault(db, cache);
		setSystemDefaultLocale(request, defaultLocale);
	}
	const response = await paraglideMiddleware(request, () => resolve(request));
	const responseHeaders = new Headers(response.headers);
	responseHeaders.append("vary", "Cookie");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders,
	});
}
