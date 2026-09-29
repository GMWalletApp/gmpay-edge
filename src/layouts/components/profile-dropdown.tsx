import { KeyRound, Settings, ShieldCheck } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { m } from "#/paraglide/messages";
import { useAuthUser } from "#/stores/auth-store";
import { accountIdentity, useAccountDialogs } from "./account-dialogs";

export function ProfileDropdown() {
	const openDialog = useAccountDialogs();
	const { name, email, avatar, initials } = accountIdentity(useAuthUser());

	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" className="relative h-8 w-8 rounded-full">
					<Avatar className="h-8 w-8">
						<AvatarImage src={avatar} alt={name} />
						<AvatarFallback>{initials}</AvatarFallback>
					</Avatar>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-56" align="end" forceMount>
				<DropdownMenuLabel className="font-normal">
					<div className="flex flex-col gap-1.5">
						<p className="text-sm leading-none font-medium">{name}</p>
						<p className="text-xs leading-none text-muted-foreground">
							{email}
						</p>
					</div>
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={(event) => {
						event.preventDefault();
						openDialog("settings");
					}}
				>
					<Settings />
					{m.layout_profile_settings()}
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={(event) => {
						event.preventDefault();
						openDialog("two-factor");
					}}
				>
					<ShieldCheck />
					{m.account_two_factor_title()}
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={(event) => {
						event.preventDefault();
						openDialog("password");
					}}
				>
					<KeyRound />
					{m.account_change_password_title()}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					variant="destructive"
					onClick={() => openDialog("sign-out")}
				>
					{m.layout_signOut_title()}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
