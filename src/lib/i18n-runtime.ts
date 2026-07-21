import {
	defineCustomClientStrategy,
	defineCustomServerStrategy,
} from "#/paraglide/runtime";
import { type SupportedLocale, supportedLocales } from "./locales";

const systemDefaultLocales = new WeakMap<Request, SupportedLocale>();

defineCustomServerStrategy("custom-system-default", {
	getLocale: (request) =>
		localeFromCookie(request?.headers.get("cookie")) ??
		(request ? systemDefaultLocales.get(request) : undefined),
});

defineCustomClientStrategy("custom-system-default", {
	getLocale: () =>
		supportedLocale(
			typeof document === "undefined"
				? undefined
				: document.documentElement.lang,
		),
	setLocale: () => undefined,
});

export function localeFromCookie(cookieHeader?: string | null) {
	const value = cookieHeader
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith("PARAGLIDE_LOCALE="))
		?.slice("PARAGLIDE_LOCALE=".length);
	return supportedLocale(value);
}

export function setSystemDefaultLocale(
	request: Request,
	locale: SupportedLocale,
) {
	systemDefaultLocales.set(request, locale);
}

function supportedLocale(value?: string | null): SupportedLocale | undefined {
	return supportedLocales.find((locale) => locale === value);
}
