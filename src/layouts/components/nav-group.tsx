import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "#/components/ui/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	useSidebar,
} from "#/components/ui/sidebar";
import { normalizePathname } from "./data/sidebar-data";
import type {
	NavCollapsible,
	NavGroup as NavGroupProps,
	NavLink,
} from "./types";

export function NavGroup({ title, items }: NavGroupProps) {
	const { state, isMobile } = useSidebar();
	return (
		<SidebarGroup>
			<SidebarGroupLabel>{title}</SidebarGroupLabel>
			<SidebarMenu>
				{items.map((item) => {
					if (!item.items) {
						return <SidebarMenuLink item={item} key={item.id} />;
					}

					if (state === "collapsed" && !isMobile) {
						return <SidebarMenuCollapsedDropdown item={item} key={item.id} />;
					}

					return <SidebarMenuCollapsible item={item} key={item.id} />;
				})}
			</SidebarMenu>
		</SidebarGroup>
	);
}

function SidebarMenuLink({ item }: { item: NavLink }) {
	const { setOpenMobile } = useSidebar();
	const location = useNavLocation();
	const isActive = matchesNavLocation(item, location);
	return (
		<SidebarMenuItem>
			<SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
				<Link
					activeOptions={{ exact: true }}
					onClick={() => setOpenMobile(false)}
					to={item.url}
				>
					{item.icon && <item.icon />}
					<span>{item.title}</span>
				</Link>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

function SidebarMenuCollapsible({ item }: { item: NavCollapsible }) {
	const { setOpenMobile } = useSidebar();
	const location = useNavLocation();
	const isChildActive = item.items.some((sub) =>
		matchesNavLocation(sub, location),
	);
	const [open, setOpen] = useState(isChildActive);
	// Navigating into a child re-opens the group without an extra commit; a
	// group the operator collapsed stays collapsed until its child is active.
	const [childWasActive, setChildWasActive] = useState(isChildActive);
	if (isChildActive !== childWasActive) {
		setChildWasActive(isChildActive);
		if (isChildActive) setOpen(true);
	}
	return (
		<Collapsible
			asChild
			className="group/collapsible"
			open={open}
			onOpenChange={setOpen}
		>
			<SidebarMenuItem>
				<CollapsibleTrigger asChild>
					<SidebarMenuButton isActive={isChildActive} tooltip={item.title}>
						{item.icon && <item.icon />}
						<span>{item.title}</span>
						<ChevronRight className="ms-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90 rtl:rotate-180" />
					</SidebarMenuButton>
				</CollapsibleTrigger>
				<CollapsibleContent className="CollapsibleContent">
					<SidebarMenuSub>
						{item.items.map((subItem) => (
							<CollapsibleSubItem
								item={subItem}
								key={subItem.id}
								onClose={() => setOpenMobile(false)}
							/>
						))}
					</SidebarMenuSub>
				</CollapsibleContent>
			</SidebarMenuItem>
		</Collapsible>
	);
}

function CollapsibleSubItem({
	item,
	onClose,
}: {
	item: NavLink;
	onClose: () => void;
}) {
	const location = useNavLocation();
	const isActive = matchesNavLocation(item, location);
	return (
		<SidebarMenuSubItem>
			<SidebarMenuSubButton asChild isActive={isActive}>
				<Link activeOptions={{ exact: true }} onClick={onClose} to={item.url}>
					{item.icon && <item.icon />}
					<span>{item.title}</span>
				</Link>
			</SidebarMenuSubButton>
		</SidebarMenuSubItem>
	);
}

function SidebarMenuCollapsedDropdown({ item }: { item: NavCollapsible }) {
	const location = useNavLocation();
	const isChildActive = item.items.some((sub) =>
		matchesNavLocation(sub, location),
	);
	return (
		<SidebarMenuItem>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<SidebarMenuButton isActive={isChildActive} tooltip={item.title}>
						{item.icon && <item.icon />}
						<span>{item.title}</span>
						<ChevronRight className="ms-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
					</SidebarMenuButton>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" side="right" sideOffset={4}>
					<DropdownMenuLabel>{item.title}</DropdownMenuLabel>
					<DropdownMenuSeparator />
					{item.items.map((sub) => (
						<CollapsedDropdownItem item={sub} key={sub.id} />
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</SidebarMenuItem>
	);
}

function CollapsedDropdownItem({ item }: { item: NavLink }) {
	const location = useNavLocation();
	const isActive = matchesNavLocation(item, location);
	return (
		<DropdownMenuItem asChild>
			<Link
				activeOptions={{ exact: true }}
				className={isActive ? "bg-secondary" : ""}
				to={item.url}
			>
				{item.icon && <item.icon />}
				<span className="max-w-52 text-wrap">{item.title}</span>
			</Link>
		</DropdownMenuItem>
	);
}

function useNavLocation() {
	return useRouterState({
		select: (state) => ({
			pathname: state.location.pathname,
		}),
	});
}

export function matchesNavLocation(
	item: NavLink,
	location: { pathname: string },
) {
	const pathname = normalizePathname(location.pathname);
	if (pathname === normalizePathname(String(item.url))) return true;
	if (item.activePrefixes?.some((prefix) => pathname.startsWith(prefix)))
		return true;
	if (!item.activeUrls) return false;
	return item.activeUrls.some((url) => {
		const candidate = normalizePathname(url);
		return pathname === candidate || pathname.startsWith(`${candidate}/`);
	});
}
