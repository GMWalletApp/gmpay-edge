import { createFileRoute, redirect } from "@tanstack/react-router";
import { ForgotPasswordPage } from "#/features/auth/pages/forgot-password";
import { getInstallStatus } from "#/features/installation/server/functions";
import { createDefaultSeoHead, siteNameFromMatches } from "#/lib/seo";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/(auth)/forgot-password")({
	head: ({ matches }) => {
		const siteName = siteNameFromMatches(matches);
		return createDefaultSeoHead({
			title: `${m.auth_forgot_password_title()} | ${siteName}`,
			description: m.auth_forgot_password_description(),
			path: "/forgot-password",
			siteName,
		});
	},
	loader: async () => {
		if (!(await getInstallStatus()).installed)
			throw redirect({ to: "/install" });
	},
	component: ForgotPasswordPage,
});
