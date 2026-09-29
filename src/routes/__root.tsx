import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";
import { Toaster } from "#/components/ui/sonner";
import { TooltipProvider } from "#/components/ui/tooltip";
import { DirectionProvider } from "#/context/direction-provider";
import { SiteBrandProvider } from "#/context/site-brand-provider";
import { ThemeProvider } from "#/context/theme-provider";
import { GeneralError } from "#/features/errors/general-error";
import { NotFoundError } from "#/features/errors/not-found-error";
import { getSiteBrandFn } from "#/features/settings/server/site-brand-entry";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import appCss from "../styles/global.css?url";

const DevelopmentTools = import.meta.env.DEV
	? lazy(() => import("#/components/development-tools"))
	: null;

interface MyRouterContext {
	queryClient: QueryClient;
}

const THEME_INIT_SCRIPT = `(() => {
  try {
    const stored = localStorage.getItem("theme");
    const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = stored === "light" || stored === "dark"
      ? stored
      : systemDark ? "dark" : "light";
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolved);
    root.style.colorScheme = resolved;
    if (stored === "light" || stored === "dark") root.dataset.theme = stored;
    else root.removeAttribute("data-theme");
  } catch {
    document.documentElement.classList.add("light");
    document.documentElement.style.colorScheme = "light";
  }
})();`;

export const Route = createRootRouteWithContext<MyRouterContext>()({
	// Brand settings are low-volatility root data. Keeping the route match fresh
	// briefly avoids re-running the server function on every child navigation.
	staleTime: 5 * 60_000,
	loader: () => getSiteBrandFn(),
	head: ({ loaderData }) => {
		const title = `${loaderData?.name ?? "GMPay Edge"} – ${m.app_title_description()}`;
		const logoUrl = loaderData?.logoUrl ?? "/favicon.png";
		return {
			meta: [
				{
					charSet: "utf-8",
				},
				{
					name: "viewport",
					content: "width=device-width, initial-scale=1",
				},
				{
					title,
				},
				{
					name: "title",
					content: title,
				},
				{
					name: "description",
					content: m.common_seo_description(),
				},
				{
					name: "keywords",
					content: m.common_seo_keywords(),
				},
			],
			links: [
				{
					rel: "stylesheet",
					href: appCss,
				},
				{
					rel: "icon",
					href: logoUrl,
				},
				{
					rel: "apple-touch-icon",
					href: logoUrl,
				},
				{
					rel: "manifest",
					href: "/site.webmanifest",
				},
			],
		};
	},
	notFoundComponent: NotFoundError,
	errorComponent: () => <GeneralError />,
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	const brand = Route.useLoaderData();
	const locale = getLocale();
	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);
	return (
		<html lang={locale} suppressHydrationWarning>
			<head>
				<script suppressHydrationWarning>{THEME_INIT_SCRIPT}</script>
				{/* Route head() keeps one meta per name, so both scheme-specific
				    theme colors (the --background token of global.css) live here;
				    ThemeProvider re-syncs them to the resolved theme after hydration. */}
				<meta
					content="#ffffff"
					media="(prefers-color-scheme: light)"
					name="theme-color"
				/>
				<meta
					content="#09090b"
					media="(prefers-color-scheme: dark)"
					name="theme-color"
				/>
				<HeadContent />
			</head>
			<body className="antialiased wrap-anywhere">
				<SiteBrandProvider brand={brand}>
					<ThemeProvider>
						<DirectionProvider>
							<TooltipProvider>{children}</TooltipProvider>
						</DirectionProvider>
						<Toaster duration={5000} position="top-right" />
					</ThemeProvider>
				</SiteBrandProvider>
				{DevelopmentTools ? (
					<Suspense fallback={null}>
						<DevelopmentTools />
					</Suspense>
				) : null}
				<Scripts />
			</body>
		</html>
	);
}
