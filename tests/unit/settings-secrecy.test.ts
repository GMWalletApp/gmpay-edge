import { describe, expect, it } from "vitest";
import {
	isRuntimeSecret,
	presentSettingValue,
	shouldPreserveRuntimeSecret,
} from "#/features/settings/secrecy";

const secretKeys = [
	"runtime.better_auth_secret",
	"runtime.api_key_pepper",
	"runtime.integration_config_secret",
] as const;

describe("runtime setting secrecy", () => {
	it("reports whether a secret is configured without returning its value", () => {
		const secret = "a-real-runtime-secret-that-must-not-leave-d1";
		for (const key of secretKeys) {
			expect(isRuntimeSecret(key)).toBe(true);
			expect(presentSettingValue(key, secret)).toEqual({
				value: "",
				configured: true,
			});
			expect(presentSettingValue(key, "")).toEqual({
				value: "",
				configured: false,
			});
		}
	});

	it("keeps the canonical URL visible because it is not a secret", () => {
		expect(isRuntimeSecret("runtime.better_auth_url")).toBe(false);
		expect(
			presentSettingValue("runtime.better_auth_url", "https://pay.example"),
		).toEqual({ value: "https://pay.example", configured: undefined });
	});

	it("treats a blank secret input as preserve, not overwrite", () => {
		expect(shouldPreserveRuntimeSecret("runtime.better_auth_secret", "")).toBe(
			true,
		);
		expect(
			shouldPreserveRuntimeSecret("runtime.better_auth_secret", "replacement"),
		).toBe(false);
		expect(shouldPreserveRuntimeSecret("runtime.better_auth_url", "")).toBe(
			false,
		);
	});
});
