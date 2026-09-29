import { useNavigate, useRouter } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import { m } from "#/paraglide/messages";

export function UnauthorisedError() {
	const navigate = useNavigate();
	const { history } = useRouter();

	return (
		<div className="h-svh">
			<div className="m-auto flex h-full w-full flex-col items-center justify-center gap-2">
				<h1 className="text-[7rem] leading-tight font-bold">401</h1>
				<span className="font-medium">{m.errors_unauthorizedTitle()}</span>
				<p className="text-center text-muted-foreground">
					{m.errors_unauthorizedDescription()}
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
