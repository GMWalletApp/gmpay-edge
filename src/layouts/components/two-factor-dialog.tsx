import { Download } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CopyButton, ProButton } from "#/components/pro/base/button";
import { CheckboxControl } from "#/components/pro/base/fields/checkbox";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/features/auth/auth-client";
import { twoFactorManagementErrorMessage } from "#/features/auth/error-message";
import { m } from "#/paraglide/messages";

type Setup = { totpURI: string; backupCodes: string[] };

export function TwoFactorDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const session = authClient.useSession();
	const enabled = Boolean(
		(session.data?.user as { twoFactorEnabled?: boolean } | undefined)
			?.twoFactorEnabled,
	);
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [setup, setSetup] = useState<Setup>();
	const [backupCodesSaved, setBackupCodesSaved] = useState(false);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!open) {
			setPassword("");
			setCode("");
			setSetup(undefined);
			setBackupCodesSaved(false);
		}
	}, [open]);

	async function beginSetup() {
		setLoading(true);
		try {
			const result = await authClient.twoFactor.enable({
				password,
				issuer: "GMPay Edge",
			});
			if (result.error) {
				toast.error(twoFactorManagementErrorMessage(result.error));
				return;
			}
			if (result.data.method !== "totp") {
				toast.error(
					twoFactorManagementErrorMessage(
						new Error("Unexpected two-factor method"),
					),
				);
				return;
			}
			setSetup({
				totpURI: result.data.totpURI,
				backupCodes: result.data.backupCodes,
			});
			setPassword("");
			setBackupCodesSaved(false);
		} catch (error) {
			toast.error(twoFactorManagementErrorMessage(error));
		} finally {
			setLoading(false);
		}
	}

	async function confirmSetup() {
		setLoading(true);
		try {
			const result = await authClient.twoFactor.verifyTotp({ code });
			if (result.error) {
				toast.error(twoFactorManagementErrorMessage(result.error));
				return;
			}
			await session.refetch();
			toast.success(m.account_two_factor_enabled());
			onOpenChange(false);
		} catch (error) {
			toast.error(twoFactorManagementErrorMessage(error));
		} finally {
			setLoading(false);
		}
	}

	async function disable() {
		setLoading(true);
		try {
			const result = await authClient.twoFactor.disable({ password });
			if (result.error) {
				toast.error(twoFactorManagementErrorMessage(result.error));
				return;
			}
			await session.refetch();
			toast.success(m.account_two_factor_disabled());
			onOpenChange(false);
		} catch (error) {
			toast.error(twoFactorManagementErrorMessage(error));
		} finally {
			setLoading(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{m.account_two_factor_title()}</DialogTitle>
					<DialogDescription>
						{enabled
							? m.account_two_factor_disable_description()
							: m.account_two_factor_enable_description()}
					</DialogDescription>
				</DialogHeader>

				{setup ? (
					<div className="space-y-4">
						<div className="mx-auto w-fit rounded-xl bg-white p-3">
							<QRCodeSVG
								size={176}
								title={m.account_two_factor_qr_title()}
								value={setup.totpURI}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="totp-code">
								{m.auth_two_factor_code_label()}
							</Label>
							<Input
								id="totp-code"
								autoComplete="one-time-code"
								inputMode="numeric"
								value={code}
								onChange={(event) => setCode(event.target.value.trim())}
							/>
						</div>
						<div className="rounded-lg border bg-muted/40 p-3">
							<div className="mb-2 flex items-center justify-between gap-2">
								<p className="font-medium text-sm">
									{m.account_two_factor_backup_codes()}
								</p>
								<div className="flex gap-1">
									<CopyButton
										copy={() => formatBackupCodes(setup.backupCodes)}
										aria-label={m.common_copy()}
										size="icon-xs"
										tooltip={m.common_copy()}
										variant="ghost"
									/>
									<ProButton
										aria-label={m.account_two_factor_download_codes()}
										onClick={() => downloadBackupCodes(setup.backupCodes)}
										size="icon-xs"
										tooltip={m.account_two_factor_download_codes()}
										variant="ghost"
									>
										<Download />
									</ProButton>
								</div>
							</div>
							<div className="grid grid-cols-2 gap-1 font-mono text-xs">
								{setup.backupCodes.map((backupCode) => (
									<span key={backupCode}>{backupCode}</span>
								))}
							</div>
							<div className="mt-3 flex items-start gap-2">
								<CheckboxControl
									id="two-factor-backup-codes-saved"
									aria-label={m.account_two_factor_codes_saved()}
									checked={backupCodesSaved}
									onCheckedChange={(checked) =>
										setBackupCodesSaved(checked === true)
									}
								/>
								<label
									className="text-muted-foreground text-xs leading-snug"
									htmlFor="two-factor-backup-codes-saved"
								>
									{m.account_two_factor_codes_saved()}
								</label>
							</div>
						</div>
					</div>
				) : (
					<div className="space-y-2">
						<Label htmlFor="two-factor-password">
							{m.account_two_factor_password()}
						</Label>
						<Input
							id="two-factor-password"
							type="password"
							autoComplete="current-password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</div>
				)}

				<DialogFooter>
					<Button
						disabled={
							loading ||
							(setup
								? code.length < 6 || !backupCodesSaved
								: password.length < 12)
						}
						onClick={setup ? confirmSetup : enabled ? disable : beginSetup}
						variant={enabled && !setup ? "destructive" : "default"}
					>
						{setup
							? m.auth_two_factor_verify()
							: enabled
								? m.account_two_factor_disable()
								: m.account_two_factor_enable()}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function formatBackupCodes(codes: readonly string[]) {
	return `${codes.join("\n")}\n`;
}

function downloadBackupCodes(codes: readonly string[]) {
	const blob = new Blob([formatBackupCodes(codes)], { type: "text/plain" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = "gmpay-edge-two-factor-backup-codes.txt";
	anchor.click();
	URL.revokeObjectURL(url);
}
