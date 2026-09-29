import { createContext, useContext, useState } from "react";
import { m } from "#/paraglide/messages";
import type { AuthUser } from "#/stores/auth-store";
import { ChangePasswordDialog } from "./change-password-dialog";
import { ConfigDrawer } from "./config-drawer";
import { SignOutDialog } from "./sign-out-dialog";
import { TwoFactorDialog } from "./two-factor-dialog";

export type AccountDialog = "settings" | "two-factor" | "password" | "sign-out";

const AccountDialogsContext = createContext<
	((dialog: AccountDialog) => void) | null
>(null);

/**
 * Mounts each account dialog once for the admin shell; the sidebar and header
 * menus only request which one to open.
 */
export function AccountDialogsProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [dialog, setDialog] = useState<AccountDialog | null>(null);
	const openChange = (target: AccountDialog) => (open: boolean) =>
		setDialog(open ? target : null);
	return (
		<AccountDialogsContext value={setDialog}>
			{children}
			<ConfigDrawer
				open={dialog === "settings"}
				onOpenChange={openChange("settings")}
			/>
			<TwoFactorDialog
				open={dialog === "two-factor"}
				onOpenChange={openChange("two-factor")}
			/>
			<ChangePasswordDialog
				open={dialog === "password"}
				onOpenChange={openChange("password")}
			/>
			<SignOutDialog
				open={dialog === "sign-out"}
				onOpenChange={openChange("sign-out")}
			/>
		</AccountDialogsContext>
	);
}

export function useAccountDialogs() {
	const open = useContext(AccountDialogsContext);
	if (!open)
		throw new Error(
			"useAccountDialogs must be used within AccountDialogsProvider",
		);
	return open;
}

export function accountIdentity(user: AuthUser | null | undefined) {
	const name = user?.name || user?.email || m.common_owner();
	return {
		name,
		email: user?.email ?? "",
		avatar: user?.image ?? "",
		initials: name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase())
			.join(""),
	};
}
