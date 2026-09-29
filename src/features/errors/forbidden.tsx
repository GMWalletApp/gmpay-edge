import { useNavigate, useRouter } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import { m } from "#/paraglide/messages";

export function ForbiddenError() {
	const navigate = useNavigate();
	const { history } = useRouter();

	return (
		<div className="h-svh">
			<div className="m-auto flex h-full w-full flex-col items-center justify-center gap-2">
				<h1 className="text-[7rem] leading-tight font-bold">403</h1>
				<span className="font-medium">{m.errors_forbiddenTitle()}</span>
				<p className="text-center text-muted-foreground">
					{m.errors_forbiddenDescription()}
				</p>
				<div className="mt-6 flex gap-4">
					<Button variant="outline" onClick={() => history.go(-1)}>
						{m.common_goBack()}
					</Button>
					<Button onClick={() => navigate({ to: "/admin" })}>
						{m.common_backToHome()}
					</Button>
				</div>
			</div>
		</div>
	);
}
