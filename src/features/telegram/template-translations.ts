import { z } from "zod";
import { type SupportedLocale, supportedLocales } from "#/lib/locales";

const telegramTemplateTranslationsSchema = z.partialRecord(
	z.enum(supportedLocales),
	z.string(),
);

export function parseTelegramTemplateTranslations(value: unknown) {
	let candidate = value;
	if (typeof value === "string") {
		try {
			candidate = JSON.parse(value);
		} catch {
			candidate = null;
		}
	}
	const parsed = telegramTemplateTranslationsSchema.safeParse(candidate);
	const source = parsed.success ? parsed.data : {};
	return supportedLocales.reduce<Record<SupportedLocale, string>>(
		(translations, locale) => {
			translations[locale] = source[locale] ?? "";
			return translations;
		},
		{} as Record<SupportedLocale, string>,
	);
}
