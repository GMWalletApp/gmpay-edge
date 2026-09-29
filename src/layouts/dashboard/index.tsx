import { Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { SidebarInset, SidebarProvider } from "#/components/ui/sidebar";
import {
	type LayoutPreferences,
	LayoutProvider,
} from "#/context/layout-provider";
import { SearchProvider } from "#/context/search-provider";
import type { SystemPermissionGrant } from "#/features/access/system-rbac";
import { AccountDialogsProvider } from "#/layouts/components/account-dialogs";
import { AppHeader } from "#/layouts/components/app-header";
import { AppSidebar } from "#/layouts/components/app-sidebar";
import { CommandMenu } from "#/layouts/components/command-menu";
import { NavigationProvider } from "#/layouts/components/navigation-context";
import { SkipToMain } from "#/layouts/components/skip-to-main";
import type { SidebarData } from "#/layouts/components/types";
import { cn } from "#/lib/utils";
import { type AuthUser, authStore } from "#/stores/auth-store";

export function DashboardLayout({
	user,
	navigation,
	permissions,
	layout,
}: {
	user: AuthUser;
	navigation: SidebarData;
	permissions: readonly SystemPermissionGrant[];
	layout: LayoutPreferences;
}) {
	useEffect(() => authStore.actions.setUser(user), [user]);

	return (
		<NavigationProvider navigation={navigation} permissions={permissions}>
			<SearchProvider>
				<CommandMenu />
				<LayoutProvider initial={layout}>
					<SidebarProvider defaultOpen={layout.sidebarOpen}>
						<AccountDialogsProvider>
							<SkipToMain />
							<AppSidebar data={navigation} user={user} />
							<SidebarInset
								className={cn(
									"@container/content",
									"has-data-[layout=fixed]:h-svh",
									"peer-data-[variant=inset]:has-data-[layout=fixed]:h-[calc(100svh-(var(--spacing)*4))]",
								)}
								id="content"
								tabIndex={-1}
							>
								<AppHeader />
								<Outlet />
							</SidebarInset>
						</AccountDialogsProvider>
					</SidebarProvider>
				</LayoutProvider>
			</SearchProvider>
		</NavigationProvider>
	);
}
