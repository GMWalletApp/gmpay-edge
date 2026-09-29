import { ChevronsUpDown, KeyRound, LogOut, Settings } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "#/components/ui/sidebar";
import { useDirection } from "#/context/direction-provider";
import { m } from "#/paraglide/messages";
import { type AuthUser, useAuthUser } from "#/stores/auth-store";
import { accountIdentity, useAccountDialogs } from "./account-dialogs";

export function NavUser({ user: providedUser }: { user?: AuthUser }) {
	const { dir } = useDirection();
	const { isMobile } = useSidebar();
	const openDialog = useAccountDialogs();
	const storedUser = useAuthUser();
	const { name, email, avatar, initials } = accountIdentity(
		providedUser ?? storedUser,
	);

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton
							size="lg"
							className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
						>
							<Avatar className="h-8 w-8 rounded-lg">
								<AvatarImage src={avatar} alt={name} />
								<AvatarFallback className="rounded-lg">
									{initials}
								</AvatarFallback>
							</Avatar>
							<div className="grid flex-1 text-start text-sm leading-tight">
								<span className="truncate font-semibold">{name}</span>
								<span className="truncate text-xs">{email}</span>
							</div>
							<ChevronsUpDown className="ms-auto size-4" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
						side={isMobile ? "bottom" : dir === "rtl" ? "left" : "right"}
						align="end"
						sideOffset={4}
					>
						<DropdownMenuLabel className="p-0 font-normal">
							<div className="flex items-center gap-2 px-1 py-1.5 text-start text-sm">
								<Avatar className="h-8 w-8 rounded-lg">
									<AvatarImage src={avatar} alt={name} />
									<AvatarFallback className="rounded-lg">
										{initials}
									</AvatarFallback>
								</Avatar>
								<div className="grid flex-1 text-start text-sm leading-tight">
									<span className="truncate font-semibold">{name}</span>
									<span className="truncate text-xs">{email}</span>
								</div>
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
							<LogOut />
							{m.layout_signOut_title()}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}
