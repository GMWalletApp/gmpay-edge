type PresentableSettingValue = string | number | boolean | string[];

export function isRuntimeSecret(key: string) {
	return key.startsWith("runtime.") && key !== "runtime.better_auth_url";
}

// Runtime secrets are write-only: list APIs expose whether one is configured,
// never its value, and a blank submission preserves the stored secret.
export function presentSettingValue(
	key: string,
	value: PresentableSettingValue,
) {
	if (!isRuntimeSecret(key)) return { value, configured: undefined };
	return {
		value: "",
		configured: typeof value === "string" && value.length > 0,
	};
}

export function shouldPreserveRuntimeSecret(key: string, value: unknown) {
	return isRuntimeSecret(key) && value === "";
}
