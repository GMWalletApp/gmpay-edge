"use client";

import { Link } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "#/components/ui/sheet";
import { AppTitle } from "#/layouts/components/app-title";
import { LocaleSwitch } from "#/layouts/components/locale-switch";
import { ThemeSwitch } from "#/layouts/components/theme-switch";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

export function PublicHeader() {
	const navigation = publicNavigation();
	const [stuck, setStuck] = useState(false);
	useEffect(() => {
		const update = () => setStuck(window.scrollY > 0);
		update();
		window.addEventListener("scroll", update, { passive: true });
		return () => window.removeEventListener("scroll", update);
	}, []);
	return (
		<header
			className={cn(
				"sticky inset-x-0 top-0 z-50 border-transparent border-b transition-[border-color,backdrop-filter]",
				stuck && "border-border backdrop-blur-xl",
			)}
		>
			<div className="container flex h-16 items-center px-4">
				<Link className="shrink-0" to="/">
					<AppTitle />
				</Link>
				<div className="ms-auto hidden items-center md:flex">
					<nav className="flex items-center gap-1 text-muted-foreground text-sm">
						{navigation.map(([label, href]) => (
							<a
								className="rounded-lg px-3 py-2 transition-colors hover:bg-accent hover:text-foreground"
								href={href}
								key={href}
							>
								{label}
							</a>
						))}
					</nav>
					<div className="ms-5 flex items-center gap-1">
						<LocaleSwitch />
						<ThemeSwitch />
					</div>
					<div className="ms-5 flex items-center">
						<Button asChild>
							<Link search={{ redirect: undefined }} to="/sign-in">
								{m.public_sign_in()}
							</Link>
						</Button>
					</div>
				</div>
				<MobileNavigation />
			</div>
		</header>
	);
}

function MobileNavigation() {
	const navigation = publicNavigation();
	return (
		<Sheet>
			<SheetTrigger asChild>
				<Button className="ms-auto md:hidden" size="icon" variant="ghost">
					<Menu />
					<span className="sr-only">{m.public_open_navigation()}</span>
				</Button>
			</SheetTrigger>
			<SheetContent className="w-[min(22rem,88vw)]">
				<SheetHeader>
					<SheetTitle className="sr-only">
						{m.public_navigation_title()}
					</SheetTitle>
					<SheetDescription className="sr-only">
						{m.public_navigation_description()}
					</SheetDescription>
					<AppTitle description />
				</SheetHeader>
				<nav className="grid gap-1 px-4 pt-4">
					{navigation.map(([label, href]) => (
						<SheetClose asChild key={href}>
							<a
								className="rounded-xl px-4 py-3 font-medium transition-colors hover:bg-accent"
								href={href}
							>
								{label}
							</a>
						</SheetClose>
					))}
					<SheetClose asChild>
						<Button asChild className="mt-3 rounded-xl">
							<Link search={{ redirect: undefined }} to="/sign-in">
								{m.public_sign_in()}
							</Link>
						</Button>
					</SheetClose>
				</nav>
				<SheetFooter className="flex-row items-center justify-between">
					<span className="text-muted-foreground text-xs">
						{m.public_display_preferences()}
					</span>
					<div className="flex items-center gap-1">
						<LocaleSwitch />
						<ThemeSwitch />
					</div>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}

function publicNavigation() {
	return [
		[m.public_nav_networks(), "/assets"],
		[m.public_nav_developers(), "/docs"],
		[m.public_nav_status(), "/status"],
	] as const;
}
