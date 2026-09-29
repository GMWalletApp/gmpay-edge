import { useNavigate, useRouter } from "@tanstack/react-router";
import type { HTMLAttributes } from "react";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

type GeneralErrorProps = HTMLAttributes<HTMLDivElement> & {
	minimal?: boolean;
};

export function GeneralError({
	className,
	minimal = false,
}: GeneralErrorProps) {
	const navigate = useNavigate();
	const { history } = useRouter();

	return (
		<div className={cn("h-svh w-full", className)}>
			<div className="m-auto flex h-full w-full flex-col items-center justify-center gap-2">
				{!minimal && (
					<h1 className="text-[7rem] leading-tight font-bold">500</h1>
				)}
				<span className="font-medium">{m.errors_generalTitle()}</span>
				<p className="text-center text-muted-foreground">
					{m.errors_generalDescription()}
				</p>
				{!minimal && (
					<div className="mt-6 flex gap-4">
						<Button variant="outline" onClick={() => history.go(-1)}>
							{m.common_goBack()}
						</Button>
						<Button onClick={() => navigate({ to: "/admin" })}>
							{m.common_backToHome()}
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
