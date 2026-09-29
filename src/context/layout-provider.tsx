import { createContext, useContext, useState } from "react";
import { SIDEBAR_COOKIE_NAME } from "#/components/ui/sidebar";
import { getCookie, setCookie } from "#/lib/cookies";

export type Collapsible = "offcanvas" | "icon" | "none";
export type LayoutVariant = "inset" | "sidebar" | "floating";

export type LayoutPreferences = {
	collapsible: Collapsible;
	variant: LayoutVariant;
	sidebarOpen: boolean;
};

export const defaultLayoutVariant: LayoutVariant = "floating";
export const defaultLayoutCollapsible: Collapsible = "icon";

const layoutCollapsibleCookie = "layout_collapsible";
const layoutVariantCookie = "layout_variant";
const layoutCookieMaxAge = 60 * 60 * 24 * 7;

/**
 * Layout cookies are read where the admin route loads (SSR request or browser
 * navigation) so the first render already matches the persisted preference.
 */
export function readLayoutPreferences(): LayoutPreferences {
	const collapsible = getCookie(layoutCollapsibleCookie);
	const variant = getCookie(layoutVariantCookie);
	return {
		collapsible:
			collapsible === "offcanvas" ||
			collapsible === "icon" ||
			collapsible === "none"
				? collapsible
				: defaultLayoutCollapsible,
		variant:
			variant === "inset" || variant === "sidebar" || variant === "floating"
				? variant
				: defaultLayoutVariant,
		sidebarOpen: getCookie(SIDEBAR_COOKIE_NAME) !== "false",
	};
}

type LayoutContextType = {
	resetLayout: () => void;

	defaultCollapsible: Collapsible;
	collapsible: Collapsible;
	setCollapsible: (collapsible: Collapsible) => void;

	defaultVariant: LayoutVariant;
	variant: LayoutVariant;
	setVariant: (variant: LayoutVariant) => void;
};

const LayoutContext = createContext<LayoutContextType | null>(null);

export function LayoutProvider({
	initial,
	children,
}: {
	initial: LayoutPreferences;
	children: React.ReactNode;
}) {
	const [collapsible, setCollapsibleState] = useState(initial.collapsible);
	const [variant, setVariantState] = useState(initial.variant);

	const setCollapsible = (next: Collapsible) => {
		setCookie(layoutCollapsibleCookie, next, layoutCookieMaxAge);
		setCollapsibleState(next);
	};
	const setVariant = (next: LayoutVariant) => {
		setCookie(layoutVariantCookie, next, layoutCookieMaxAge);
		setVariantState(next);
	};

	const contextValue: LayoutContextType = {
		resetLayout: () => {
			setCollapsible(defaultLayoutCollapsible);
			setVariant(defaultLayoutVariant);
		},
		defaultCollapsible: defaultLayoutCollapsible,
		collapsible,
		setCollapsible,
		defaultVariant: defaultLayoutVariant,
		variant,
		setVariant,
	};

	return <LayoutContext value={contextValue}>{children}</LayoutContext>;
}

export function useLayout() {
	const context = useContext(LayoutContext);
	if (!context) {
		throw new Error("useLayout must be used within a LayoutProvider");
	}
	return context;
}
