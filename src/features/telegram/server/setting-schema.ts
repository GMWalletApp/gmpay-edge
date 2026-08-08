import type { z } from "zod";

export function parseTelegramSetting<T>(
	value: string | undefined,
	schema: z.ZodType<T>,
	fallback: T,
): T {
	if (!value) return fallback;
	try {
		return schema.parse(JSON.parse(value));
	} catch {
		return fallback;
	}
}
