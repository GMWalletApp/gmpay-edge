import { createFileRoute } from "@tanstack/react-router";
import { ResetPasswordPage } from "#/features/auth/pages/reset-password";
import { createDefaultSeoHead, siteNameFromMatches } from "#/lib/seo";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/(auth)/reset-password")({
	validateSearch: (search: Record<string, unknown>) => ({
		token: typeof search.token === "string" ? search.token : undefined,
	}),
	head: ({ matches }) => {
		const siteName = siteNameFromMatches(matches);
		return createDefaultSeoHead({
			title: `${m.auth_reset_password_title()} | ${siteName}`,
			description: m.auth_reset_password_description(),
			path: "/reset-password",
			siteName,
		});
	},
	component: ResetPasswordRoute,
});

function ResetPasswordRoute() {
	return <ResetPasswordPage token={Route.useSearch().token} />;
}
