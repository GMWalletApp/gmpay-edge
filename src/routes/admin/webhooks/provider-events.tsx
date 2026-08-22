import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PaymentProviderEventsPage } from "#/features/webhooks/pages/admin-provider-events";
import { validateProTableSearch } from "#/lib/pro-table-url-state";

export const Route = createFileRoute("/admin/webhooks/provider-events")({
	validateSearch: (search) => ({
		...validateProTableSearch(search),
		sourceId: z.uuid().optional().catch(undefined).parse(search.sourceId),
	}),
	component: RouteComponent,
});

function RouteComponent() {
	return <PaymentProviderEventsPage sourceId={Route.useSearch().sourceId} />;
}
