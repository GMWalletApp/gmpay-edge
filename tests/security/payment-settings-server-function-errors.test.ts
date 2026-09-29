import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toCrossJSONAsync } from "seroval";
import { describe, expect, it } from "vitest";

import {
	paymentConnectionHealthErrorMessage,
	paymentSettingsOperationErrorMessage,
} from "#/features/payment-settings/error-message";
import {
	type PaymentSettingsErrorCode,
	paymentSettingsError,
} from "#/features/payment-settings/errors";
import { m } from "#/paraglide/messages";
import {
	normalizeServerFunctionError,
	ServerFunctionError,
} from "#/server/server-function-errors";

const request = new Request("https://example.com/_serverFn/payment-settings");

describe("payment settings Server Function error contract", () => {
	it.each([
		["payment_connection_not_found", 404],
		["payment_connection_transport_unsupported", 422],
		["payment_rail_not_found", 404],
		["payment_rail_connection_managed", 409],
		["payment_connection_unhealthy", 409],
		["payment_method_not_found", 404],
		["receiving_method_mixed_rail", 422],
		["receiving_method_not_found", 404],
		["receiving_method_invalid_limits", 422],
		["receiving_method_configuration_required", 422],
		["receiving_method_not_ready", 409],
		["exchange_rate_not_found", 404],
		["fiat_rate_credentials_required", 422],
	] satisfies Array<[PaymentSettingsErrorCode, number]>)(
		"normalizes %s to HTTP %i",
		(code, status) => {
			expect(
				normalizeServerFunctionError(paymentSettingsError(code), request),
			).toMatchObject({ code, status });
		},
	);

	it.each([
		[
			"payment_connection_not_found",
			m.payment_settings_error_connection_not_found(),
		],
		[
			"payment_connection_transport_unsupported",
			m.payment_settings_error_connection_transport_unsupported(),
		],
		["payment_rail_not_found", m.payment_settings_error_rail_not_found()],
		[
			"payment_rail_connection_managed",
			m.payment_settings_error_rail_connection_managed(),
		],
		[
			"payment_connection_unhealthy",
			m.payment_settings_error_connection_unhealthy(),
		],
		["payment_method_not_found", m.payment_settings_error_method_not_found()],
		["receiving_method_mixed_rail", m.payment_settings_error_mixed_rail()],
		[
			"receiving_method_not_found",
			m.payment_settings_error_receiving_method_not_found(),
		],
		[
			"receiving_method_invalid_limits",
			m.payment_settings_error_invalid_limits(),
		],
		[
			"receiving_method_configuration_required",
			m.receiving_configuration_required(),
		],
		[
			"receiving_method_not_ready",
			m.payment_settings_error_receiving_method_not_ready(),
		],
		["exchange_rate_not_found", m.payment_settings_error_rate_not_found()],
		[
			"fiat_rate_credentials_required",
			m.payment_settings_error_rate_credentials_required(),
		],
	] as const)("maps reviewed code %s to localized copy", (code, message) => {
		expect(
			paymentSettingsOperationErrorMessage(
				new ServerFunctionError(code, 409, code),
			),
		).toBe(message);
	});

	it("uses reviewed health codes instead of provider details", () => {
		expect(paymentConnectionHealthErrorMessage("configuration")).toBe(
			m.payment_settings_error_connection_configuration(),
		);
		expect(paymentConnectionHealthErrorMessage("network")).toBe(
			m.infrastructure_rpc_unhealthy(),
		);
	});

	it("hides unknown SQL, provider, and credential details from the UI", () => {
		expect(
			paymentSettingsOperationErrorMessage(
				new Error("D1_ERROR: SELECT api_key; provider token=secret"),
			),
		).toBe(m.payment_settings_operation_failed());
	});

	it("does not serialize a stack or provider detail for reviewed failures", async () => {
		const normalized = normalizeServerFunctionError(
			paymentSettingsError("payment_connection_unhealthy"),
			request,
		);
		const serialized = JSON.stringify(
			await toCrossJSONAsync(normalized, { refs: new Map(), plugins: [] }),
		);

		expect(serialized).toContain("payment_connection_unhealthy");
		expect(serialized).not.toMatch(
			/stack|api_key|token=secret|provider detail/,
		);
	});

	it("keeps raw errors and adapter health details out of the three admin pages", () => {
		const featureRoot = resolve(
			import.meta.dirname,
			"../../src/features/payment-settings",
		);
		const presentationSources = [
			"pages/admin-methods.tsx",
			"pages/admin-ingresses.tsx",
			"pages/admin-rates.tsx",
		].map((file) => readFileSync(resolve(featureRoot, file), "utf8"));
		const healthSource = readFileSync(
			resolve(featureRoot, "server/connection-health.ts"),
			"utf8",
		);

		expect(presentationSources.join("\n")).not.toMatch(
			/error\.message|health\.detail/,
		);
		expect(healthSource).not.toMatch(/error\.message/);
	});
});
