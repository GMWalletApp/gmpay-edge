import { Badge } from "#/components/ui/badge";
import { m } from "#/paraglide/messages";

const successful = new Set(["paid", "overpaid", "confirmed", "succeeded"]);
const destructive = new Set([
	"failed",
	"dead",
	"expired",
	"cancelled",
	"rejected",
]);

export function StatusBadge({ value }: { value: string }) {
	return (
		<Badge
			variant={
				successful.has(value)
					? "default"
					: destructive.has(value)
						? "destructive"
						: "secondary"
			}
		>
			{statusLabel(value)}
		</Badge>
	);
}

export function statusLabel(value: string) {
	const labels: Record<string, string> = {
		pending: m.status_pending(),
		confirming: m.status_confirming(),
		paid: m.status_paid(),
		partially_paid: m.status_partially_paid(),
		overpaid: m.status_overpaid(),
		expired: m.status_expired(),
		cancelled: m.status_cancelled(),
		failed: m.status_failed(),
		refunded: m.status_refunded(),
		detected: m.status_detected(),
		pending_review: m.status_pending_review(),
		confirmed: m.status_confirmed(),
		succeeded: m.status_succeeded(),
		queued: m.status_queued(),
		received: m.status_received(),
		processing: m.status_processing(),
		ignored: m.status_ignored(),
		ambiguous: m.status_ambiguous(),
		retrying: m.status_retrying(),
		dead: m.status_stopped(),
		rejected: m.status_rejected(),
	};
	return labels[value] ?? value.replaceAll("_", " ");
}
