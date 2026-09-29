import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "#/lib/utils.ts";
import { m } from "#/paraglide/messages";
import { ProButton } from "../base/button";

export function ProModal({
	trigger,
	title,
	description,
	children,
	open,
	onOpenChange,
	className,
}: {
	trigger?: ReactNode;
	title: ReactNode;
	description?: ReactNode;
	children?: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	className?: string;
}) {
	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			{trigger != null && (
				<DialogPrimitive.Trigger data-slot="pro-modal-trigger" asChild>
					{trigger}
				</DialogPrimitive.Trigger>
			)}
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay
					className={
						"fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
					}
				/>
				<DialogPrimitive.Content
					data-slot="pro-modal-content"
					className={cn(
						"fixed top-[50%] left-[50%] z-50 w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
						"flex max-h-[90vh] flex-col",
						className,
					)}
				>
					<div
						data-slot="pro-modal-header"
						className="flex shrink-0 flex-col gap-2 text-center sm:text-left"
					>
						<DialogPrimitive.Title
							data-slot="pro-modal-title"
							className="text-lg leading-none font-semibold"
						>
							{title}
						</DialogPrimitive.Title>
						{description != null && (
							<DialogPrimitive.Description
								data-slot="pro-modal-description"
								className="text-muted-foreground text-sm"
							>
								{description}
							</DialogPrimitive.Description>
						)}
					</div>
					{children}
					<DialogPrimitive.Close asChild>
						<ProButton
							variant="ghost"
							size="icon-sm"
							aria-label={m.common_close()}
							className="absolute top-4 right-4 opacity-70 hover:opacity-100"
						>
							<XIcon />
						</ProButton>
					</DialogPrimitive.Close>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}
