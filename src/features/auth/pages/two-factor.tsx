import { useNavigate } from "@tanstack/react-router";
import { Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import { authClient } from "#/features/auth/auth-client";
import { twoFactorVerificationErrorMessage } from "#/features/auth/error-message";
import { safePostAuthRedirect } from "#/features/auth/post-auth-redirect";
import { m } from "#/paraglide/messages";

export function TwoFactorPage() {
	const navigate = useNavigate();
	const [code, setCode] = useState("");
	const [backupMode, setBackupMode] = useState(false);
	const [trustDevice, setTrustDevice] = useState(false);
	const [loading, setLoading] = useState(false);

	async function verify(event: React.SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		setLoading(true);
		try {
			const result = backupMode
				? await authClient.twoFactor.verifyBackupCode({ code, trustDevice })
				: await authClient.twoFactor.verifyTotp({ code, trustDevice });
			if (result.error) {
				toast.error(twoFactorVerificationErrorMessage(result.error));
				return;
			}
			const redirect = safePostAuthRedirect(
				window.sessionStorage.getItem("gmpay.post_auth_redirect"),
			);
			window.sessionStorage.removeItem("gmpay.post_auth_redirect");
			await navigate({ to: redirect, replace: true });
		} catch (error) {
			toast.error(twoFactorVerificationErrorMessage(error));
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="w-full space-y-6">
			<div className="space-y-2">
				<div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
					<ShieldCheck className="size-5" />
				</div>
				<h1 className="font-semibold text-3xl tracking-tight">
					{m.auth_two_factor_title()}
				</h1>
				<p className="text-muted-foreground leading-6">
					{m.auth_two_factor_description()}
				</p>
			</div>
			<form className="space-y-4" onSubmit={verify}>
				<div className="space-y-2">
					<Label htmlFor="two-factor-code">
						{backupMode
							? m.auth_two_factor_backup_label()
							: m.auth_two_factor_code_label()}
					</Label>
					<Input
						id="two-factor-code"
						autoComplete="one-time-code"
						inputMode={backupMode ? "text" : "numeric"}
						value={code}
						onChange={(event) => setCode(event.target.value.trim())}
						required
					/>
				</div>
				<div className="flex items-center justify-between gap-3">
					<Label htmlFor="trust-device">{m.auth_two_factor_trust()}</Label>
					<Switch
						id="trust-device"
						checked={trustDevice}
						onCheckedChange={setTrustDevice}
					/>
				</div>
				<Button className="w-full" disabled={loading || !code}>
					{loading ? <Loader2 className="animate-spin" /> : null}
					{m.auth_two_factor_verify()}
				</Button>
				<Button
					type="button"
					variant="ghost"
					className="w-full"
					onClick={() => {
						setBackupMode((value) => !value);
						setCode("");
					}}
				>
					{backupMode
						? m.auth_two_factor_use_app()
						: m.auth_two_factor_use_backup()}
				</Button>
			</form>
		</div>
	);
}
