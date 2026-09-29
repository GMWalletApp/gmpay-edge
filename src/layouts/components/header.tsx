import { Separator } from "#/components/ui/separator";
import { SidebarTrigger } from "#/components/ui/sidebar";
import { cn } from "#/lib/utils";

type HeaderProps = React.HTMLAttributes<HTMLElement> & {
	ref?: React.Ref<HTMLElement>;
};

export function Header({ className, children, ...props }: HeaderProps) {
	return (
		<header
			className={cn("sticky top-0 z-50 h-16 w-[inherit]", className)}
			{...props}
		>
			<div className="relative flex h-full items-center gap-3 p-4 sm:gap-4">
				<SidebarTrigger className="max-md:scale-125" variant="outline" />
				<Separator className="h-6" orientation="vertical" />
				{children}
			</div>
		</header>
	);
}
