import { Link } from "@tanstack/react-router";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarRail,
} from "#/components/ui/sidebar";
import { useLayout } from "#/context/layout-provider";
import type { AuthUser } from "#/stores/auth-store";
import { AppTitle } from "./app-title";
import { NavGroup } from "./nav-group";
import { NavUser } from "./nav-user";
import type { SidebarData } from "./types";

export function AppSidebar({
	data,
	user,
}: {
	data: SidebarData;
	user?: AuthUser;
}) {
	const { collapsible, variant } = useLayout();
	return (
		<Sidebar collapsible={collapsible} variant={variant}>
			<SidebarHeader className="group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:p-1">
				<Link
					activeOptions={{ exact: true }}
					className="flex overflow-hidden rounded-md p-2 group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:[&>span>span]:hidden"
					to="/admin"
				>
					<AppTitle description />
				</Link>
			</SidebarHeader>
			<SidebarContent>
				{data.navGroups.map((group) => (
					<NavGroup key={group.id} {...group} />
				))}
			</SidebarContent>
			<SidebarFooter>
				<NavUser user={user} />
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}
