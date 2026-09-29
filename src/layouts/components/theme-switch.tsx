import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { MouseEvent } from "react";
import { flushSync } from "react-dom";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { useTheme } from "#/context/theme-provider";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

export function ThemeSwitch() {
	const { theme, setTheme } = useTheme();

	const handleThemeSelect = (
		nextTheme: Parameters<typeof setTheme>[0],
		event: MouseEvent,
	) => {
		if (nextTheme === theme) {
			return;
		}

		const prefersReducedMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;

		if (prefersReducedMotion || !("startViewTransition" in document)) {
			setTheme(nextTheme);
			return;
		}

		const x = event.clientX || window.innerWidth / 2;
		const y = event.clientY || window.innerHeight / 2;
		const radius = Math.hypot(
			Math.max(x, window.innerWidth - x),
			Math.max(y, window.innerHeight - y),
		);

		const transition = document.startViewTransition(() => {
			flushSync(() => setTheme(nextTheme));
		});

		transition.ready.then(() => {
			document.documentElement.animate(
				{
					clipPath: [
						`circle(0px at ${x}px ${y}px)`,
						`circle(${radius}px at ${x}px ${y}px)`,
					],
				},
				{
					duration: 500,
					easing: "cubic-bezier(.34,1.56,.64,1)",
					pseudoElement: "::view-transition-new(root)",
				} as KeyframeAnimationOptions,
			);
		});
	};

	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<Button className="scale-95 rounded-full" size="icon" variant="ghost">
					<Sun className="size-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
					<Moon className="absolute size-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
					<span className="sr-only">{m.toggle_theme()}</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem
					onClick={(event) => handleThemeSelect("light", event)}
				>
					<Sun className="size-4" />
					{m.theme_light()}{" "}
					<Check
						className={cn("ms-auto", theme !== "light" && "hidden")}
						size={14}
					/>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={(event) => handleThemeSelect("dark", event)}>
					<Moon className="size-4" />
					{m.theme_dark()}
					<Check
						className={cn("ms-auto", theme !== "dark" && "hidden")}
						size={14}
					/>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={(event) => handleThemeSelect("auto", event)}>
					<Monitor className="size-4" />
					{m.theme_system()}
					<Check
						className={cn("ms-auto", theme !== "auto" && "hidden")}
						size={14}
					/>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
