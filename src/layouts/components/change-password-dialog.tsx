import { toast } from "sonner";
import { ModalForm } from "#/components/pro/form";
import { authClient } from "#/features/auth/auth-client";
import { changePasswordErrorMessage } from "#/features/auth/error-message";
import { m } from "#/paraglide/messages";

export function ChangePasswordDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<ModalForm
			open={open}
			onOpenChange={onOpenChange}
			title={m.account_change_password_title()}
			description={m.account_change_password_description()}
			schema={[
				{
					name: "currentPassword",
					label: m.account_change_password_old_password_label(),
					valueType: "password",
					required: true,
					fieldProps: {
						minLength: 12,
						autoComplete: "current-password",
						placeholder: m.account_change_password_old_password_placeholder(),
					},
				},
				{
					name: "newPassword",
					label: m.account_change_password_new_password_label(),
					valueType: "password",
					required: true,
					fieldProps: {
						minLength: 12,
						maxLength: 200,
						autoComplete: "new-password",
						placeholder: m.account_change_password_new_password_placeholder(),
					},
				},
				{
					name: "confirmPassword",
					label: m.account_change_password_confirm_password_label(),
					valueType: "password",
					required: true,
					fieldProps: {
						minLength: 12,
						maxLength: 200,
						autoComplete: "new-password",
						placeholder:
							m.account_change_password_confirm_password_placeholder(),
					},
				},
				{
					name: "revokeOtherSessions",
					label: m.account_change_password_revoke_sessions(),
					valueType: "switch",
					initialValue: true,
				},
			]}
			onFinish={async (values) => {
				const currentPassword = String(values.currentPassword ?? "");
				const newPassword = String(values.newPassword ?? "");
				const confirmPassword = String(values.confirmPassword ?? "");
				if (currentPassword.length < 12) {
					throw { code: "CURRENT_PASSWORD_REQUIRED" };
				}
				if (newPassword.length < 12) {
					throw { code: "NEW_PASSWORD_TOO_SHORT" };
				}
				if (newPassword !== confirmPassword) {
					throw { code: "PASSWORDS_DO_NOT_MATCH" };
				}
				const result = await authClient.changePassword({
					currentPassword,
					newPassword,
					revokeOtherSessions: values.revokeOtherSessions === "true",
				});
				if (result.error) throw result.error;
				toast.success(m.account_change_password_success());
			}}
			onFinishFailed={(error) => toast.error(changePasswordErrorMessage(error))}
		/>
	);
}
