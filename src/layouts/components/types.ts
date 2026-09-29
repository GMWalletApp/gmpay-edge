import type { LinkProps } from "@tanstack/react-router";

interface BaseNavItem {
	id: string;
	activePrefixes?: string[];
	activeUrls?: string[];
	icon?: React.ElementType;
	title: string;
}

type NavLink = BaseNavItem & {
	url: LinkProps["to"] | (string & {});
	items?: never;
};

type NavCollapsible = BaseNavItem & {
	items: (BaseNavItem & { url: LinkProps["to"] | (string & {}) })[];
	url?: never;
};

type NavItem = NavCollapsible | NavLink;

interface NavGroup {
	id: string;
	items: NavItem[];
	title: string;
}

interface SidebarData {
	navGroups: NavGroup[];
}

export type { NavCollapsible, NavGroup, NavLink, SidebarData };
