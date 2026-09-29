import { m } from "#/paraglide/messages";

function errorCode(error: unknown) {
	if (!error || typeof error !== "object") return;
	if ("code" in error && typeof error.code === "string") return error.code;
	// Better Auth's built-in limiter answers 429 without a body code.
	if ("status" in error && error.status === 429) return "TOO_MANY_REQUESTS";
	return undefined;
}

export function signInErrorMessage(error: unknown) {
	switch (errorCode(error)) {
		case "INVALID_EMAIL_OR_PASSWORD":
		case "INVALID_PASSWORD":
		case "USER_NOT_FOUND":
			return m.auth_error_invalid_credentials();
		case "EMAIL_NOT_VERIFIED":
			return m.auth_error_email_not_verified();
		case "TOO_MANY_REQUESTS":
			return m.auth_error_too_many_requests();
		default:
			return m.auth_signInFailed();
	}
}

export function twoFactorVerificationErrorMessage(error: unknown) {
	switch (errorCode(error)) {
		case "INVALID_CODE":
			return m.auth_error_invalid_two_factor_code();
		case "INVALID_BACKUP_CODE":
			return m.auth_error_invalid_backup_code();
		case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
		case "ACCOUNT_TEMPORARILY_LOCKED":
			return m.auth_error_two_factor_locked();
		case "INVALID_TWO_FACTOR_COOKIE":
		case "SESSION_EXPIRED":
			return m.auth_error_session_expired();
		default:
			return m.auth_two_factor_failed();
	}
}

export function twoFactorManagementErrorMessage(error: unknown) {
	switch (errorCode(error)) {
		case "INVALID_PASSWORD":
			return m.auth_error_current_password_invalid();
		case "INVALID_CODE":
			return m.auth_error_invalid_two_factor_code();
		case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
		case "ACCOUNT_TEMPORARILY_LOCKED":
			return m.auth_error_two_factor_locked();
		case "SESSION_EXPIRED":
			return m.auth_error_session_expired();
		case "TOTP_NOT_ENABLED":
		case "TWO_FACTOR_NOT_ENABLED":
		case "BACKUP_CODES_NOT_ENABLED":
			return m.auth_error_two_factor_unavailable();
		default:
			return m.account_two_factor_failed();
	}
}

export function changePasswordErrorMessage(error: unknown) {
	switch (errorCode(error)) {
		case "CURRENT_PASSWORD_REQUIRED":
			return m.account_change_password_old_password_required();
		case "NEW_PASSWORD_TOO_SHORT":
		case "PASSWORD_TOO_SHORT":
			return m.account_change_password_new_password_required();
		case "PASSWORD_TOO_LONG":
			return m.auth_error_password_too_long();
		case "PASSWORDS_DO_NOT_MATCH":
			return m.account_change_password_confirm_password_mismatch();
		case "INVALID_PASSWORD":
			return m.auth_error_current_password_invalid();
		case "SESSION_EXPIRED":
			return m.auth_error_session_expired();
		case "CREDENTIAL_ACCOUNT_NOT_FOUND":
			return m.auth_error_password_unavailable();
		default:
			return m.account_change_password_failed();
	}
}
