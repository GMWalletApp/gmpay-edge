import { createFileRoute } from "@tanstack/react-router";
import { EmailSettingsPage } from "#/features/settings/pages/email";
import { validateProTableSearch } from "#/lib/pro-table-url-state";

export const Route = createFileRoute("/admin/email")({
	validateSearch: validateProTableSearch,
	component: EmailSettingsPage,
});
