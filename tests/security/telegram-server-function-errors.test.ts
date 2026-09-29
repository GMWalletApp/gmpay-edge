import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { telegramOperationErrorMessage } from "#/features/telegram/error-message";
import {
	requireTelegramResource,
	requireTelegramResourceAvailable,
} from "#/features/telegram/server/resource-errors";
import { m } from "#/paraglide/messages";
import { ServerFunctionError } from "#/server/server-function-errors";

describe("Telegram Server Function error presentation", () => {
	it.each([
		["telegram_config_unavailable", m.telegram_error_config_unavailable()],
		["telegram_bot_not_found", m.telegram_error_bot_not_found()],
		["telegram_bot_enabled", m.telegram_error_disable_bot_before_delete()],
		["telegram_command_not_found", m.telegram_error_command_not_found()],
		[
			"telegram_notification_not_found",
			m.telegram_error_notification_not_found(),
		],
		["telegram_notification_exists", m.telegram_error_notification_exists()],
		["telegram_command_exists", m.telegram_error_command_exists()],
		["telegram_bot_exists", m.telegram_error_bot_exists()],
		["telegram_token_invalid", m.telegram_error_token_invalid()],
		["telegram_api_rejected", m.telegram_error_api_rejected()],
		["telegram_unreachable", m.telegram_error_unreachable()],
	] as const)("maps reviewed code %s to localized copy", (code, message) => {
		expect(
			telegramOperationErrorMessage(new ServerFunctionError(code, 409, code)),
		).toBe(message);
	});

	it.each([
		["bot", "telegram_bot_not_found"],
		["command", "telegram_command_not_found"],
		["notification", "telegram_notification_not_found"],
	] as const)("uses a stable code for a missing %s", (kind, code) => {
		let error: unknown;
		try {
			requireTelegramResource(null, kind);
		} catch (caught) {
			error = caught;
		}

		expect(error).toMatchObject({ code, status: 404 });
	});

	it.each([
		["notification", "telegram_notification_exists"],
		["command", "telegram_command_exists"],
	] as const)("uses a stable code for a duplicate %s", (kind, code) => {
		let error: unknown;
		try {
			requireTelegramResourceAvailable({ id: "existing" }, kind);
		} catch (caught) {
			error = caught;
		}

		expect(error).toMatchObject({ code, status: 409 });
	});

	it("does not show Telegram API, token, or persistence details", () => {
		expect(
			telegramOperationErrorMessage(
				new Error(
					"GrammyError: token=secret-bot-token; SELECT token_encrypted",
				),
			),
		).toBe(m.telegram_operation_failed());
	});

	it("uses a stable code when runtime configuration is unavailable", async () => {
		const source = await readFile(
			new URL(
				"../../src/features/telegram/server/admin-context.ts",
				import.meta.url,
			),
			"utf8",
		);

		expect(source).toContain('"telegram_config_unavailable"');
		expect(source).not.toContain(
			'throw new Error("INTEGRATION_CONFIG_SECRET is not configured")',
		);
	});
});
