import { m } from "#/paraglide/messages";

export function telegramOperationErrorMessage(error: unknown) {
	if (!error || typeof error !== "object" || !("code" in error))
		return m.telegram_operation_failed();
	switch (error.code) {
		case "telegram_config_unavailable":
			return m.telegram_error_config_unavailable();
		case "telegram_bot_not_found":
			return m.telegram_error_bot_not_found();
		case "telegram_bot_enabled":
			return m.telegram_error_disable_bot_before_delete();
		case "telegram_bot_exists":
			return m.telegram_error_bot_exists();
		case "telegram_token_invalid":
			return m.telegram_error_token_invalid();
		case "telegram_api_rejected":
			return m.telegram_error_api_rejected();
		case "telegram_unreachable":
			return m.telegram_error_unreachable();
		case "telegram_command_not_found":
			return m.telegram_error_command_not_found();
		case "telegram_notification_not_found":
			return m.telegram_error_notification_not_found();
		case "telegram_notification_exists":
			return m.telegram_error_notification_exists();
		case "telegram_command_exists":
			return m.telegram_error_command_exists();
		default:
			return m.telegram_operation_failed();
	}
}
