"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { Check, LoaderCircle, X } from "lucide-react";
import { Slot, Tooltip as TooltipPrimitive } from "radix-ui";
import {
	type ComponentProps,
	type MouseEvent,
	type ReactNode,
	useEffect,
	useState,
} from "react";
import { m } from "#/paraglide/messages";

export const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-primary/90",
				destructive:
					"bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
				outline:
					"border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
				secondary:
					"bg-secondary text-secondary-foreground hover:bg-secondary/80",
				ghost:
					"hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default: "h-9 px-4 py-2 has-[>svg]:px-3",
				xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
				lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
				icon: "size-9",
				"icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-8",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

export type ProButtonSize = VariantProps<typeof buttonVariants>["size"];

interface ProButtonProps
	extends Omit<ComponentProps<"button">, "children" | "size">,
		VariantProps<typeof buttonVariants> {
	asChild?: boolean;
	loading?: boolean;
	tooltip?: ReactNode;
	children?: ReactNode;
}

export function ProButton({
	asChild,
	disabled,
	type = "button",
	variant,
	size,
	className,
	loading,
	tooltip,
	"aria-disabled": ariaDisabled,
	"aria-label": ariaLabel,
	children,
	...props
}: ProButtonProps) {
	const Comp = asChild ? Slot.Root : "button";
	const buttonDisabled = disabled || loading;
	const button = (
		<Comp
			type={type}
			data-slot="pro-button"
			disabled={buttonDisabled}
			aria-disabled={ariaDisabled ?? (buttonDisabled || undefined)}
			aria-label={
				ariaLabel ?? (typeof tooltip === "string" ? tooltip : undefined)
			}
			className={buttonVariants({ variant, size, className })}
			{...props}
		>
			{loading && <LoaderCircle className="size-4 animate-spin" />}
			{children}
		</Comp>
	);

	if (tooltip == null || tooltip === false) return button;

	return (
		<TooltipPrimitive.Provider delayDuration={300}>
			<TooltipPrimitive.Root>
				<TooltipPrimitive.Trigger asChild>{button}</TooltipPrimitive.Trigger>
				<TooltipPrimitive.Portal>
					<TooltipPrimitive.Content
						sideOffset={0}
						className={
							"z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
						}
					>
						{tooltip}
						<TooltipPrimitive.Arrow
							className={
								"z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground"
							}
						/>
					</TooltipPrimitive.Content>
				</TooltipPrimitive.Portal>
			</TooltipPrimitive.Root>
		</TooltipPrimitive.Provider>
	);
}

export function CopyButton({
	copy,
	icon,
	tooltip,
	loading,
	onClick,
	children,
	...props
}: ProButtonProps & {
	copy: string | (() => string | Promise<string>);
	icon?: ReactNode;
}) {
	const [status, setStatus] = useState<
		"idle" | "copying" | "success" | "error"
	>("idle");
	const isCopying = status === "copying";
	const copyTooltip = getCopyTooltip(status, tooltip);
	const copyIcon = getCopyIcon({ loading, status, icon });

	useEffect(() => {
		if (status !== "success" && status !== "error") return;
		const timer = setTimeout(() => setStatus("idle"), 2000);
		return () => clearTimeout(timer);
	}, [status]);

	async function handleClick(event: MouseEvent<HTMLButtonElement>) {
		event.stopPropagation();
		if (isCopying || loading) return;

		setStatus("copying");
		try {
			await copyToClipboard(typeof copy === "function" ? await copy() : copy);
			setStatus("success");
			onClick?.(event);
		} catch {
			setStatus("error");
		}
	}

	return (
		<ProButton
			{...props}
			tooltip={copyTooltip}
			loading={loading}
			onClick={handleClick}
		>
			{copyIcon}
			{children}
		</ProButton>
	);
}

function getCopyTooltip(
	status: "idle" | "copying" | "success" | "error",
	tooltip?: ReactNode,
) {
	if (status === "success") return m.common_copy_success();
	if (status === "error") return m.common_copy_failed();
	return tooltip;
}

function getCopyIcon({
	loading,
	status,
	icon,
}: {
	loading?: boolean;
	status: "idle" | "copying" | "success" | "error";
	icon?: ReactNode;
}) {
	if (loading) return null;
	if (status === "success")
		return <Check className="size-4 text-green-600 dark:text-green-400" />;
	if (status === "error") return <X className="size-4 text-destructive" />;
	return icon;
}

async function copyToClipboard(text: string) {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.top = "-9999px";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	textarea.select();

	try {
		// Clipboard API requires a secure context; keep this fallback for HTTP deployments.
		const legacyDocument = document as unknown as {
			execCommand(commandId: "copy"): boolean;
		};
		if (!legacyDocument.execCommand("copy"))
			throw new Error("Copy command was rejected.");
	} finally {
		document.body.removeChild(textarea);
	}
}
