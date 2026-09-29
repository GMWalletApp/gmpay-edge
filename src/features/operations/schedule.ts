export type ScheduledTaskName =
	| "order_expiration"
	| "webhook_outbox"
	| "rpc_health"
	| "crypto_rate_sync"
	| "fiat_rate_sync"
	| "payment_scan_enqueue"
	| "frequent_cleanup"
	| "retention_cleanup"
	| "payment_defaults";

export const manualScheduledTaskNames = [
	"order_expiration",
	"webhook_outbox",
	"rpc_health",
	"crypto_rate_sync",
	"fiat_rate_sync",
	"payment_defaults",
] as const satisfies ReadonlyArray<ScheduledTaskName>;

export const scheduledTaskCatalog = [
	...manualScheduledTaskNames.map((task) => ({ task, manual: true as const })),
	{ task: "payment_scan_enqueue", manual: false },
	{ task: "frequent_cleanup", manual: false },
	{ task: "retention_cleanup", manual: false },
] as const satisfies ReadonlyArray<{
	task: ScheduledTaskName;
	manual: boolean;
}>;

export function formatScheduleInterval(durationMs: number, locale: string) {
	const seconds = Math.max(0, Math.floor(durationMs / 1_000));
	const units = [
		{ unit: "day", seconds: 86_400 },
		{ unit: "hour", seconds: 3_600 },
		{ unit: "minute", seconds: 60 },
	] as const;
	const interval = units.find(
		(candidate) =>
			seconds >= candidate.seconds && seconds % candidate.seconds === 0,
	);
	const formatted = new Intl.NumberFormat(locale, {
		style: "unit",
		unit: interval?.unit ?? "second",
		unitDisplay: "long",
	}).format(interval ? seconds / interval.seconds : seconds);
	return /^(ja|ko|zh)(-|$)/.test(locale)
		? formatted.replaceAll(/\s/g, "")
		: formatted;
}

export function nextTaskExecutionAt(
	task: ScheduledTaskName,
	lastStartedAt: string | null,
	rateIntervalsMs: { crypto: number; fiat: number },
	now = Date.now(),
) {
	if (task === "payment_defaults") return null;
	if (task === "crypto_rate_sync" || task === "fiat_rate_sync") {
		const intervalMs =
			task === "crypto_rate_sync"
				? rateIntervalsMs.crypto
				: rateIntervalsMs.fiat;
		const last = lastStartedAt ? new Date(lastStartedAt).getTime() : now;
		return new Date(Math.max(last + intervalMs, now)).toISOString();
	}
	return new Date(Math.floor(now / 60_000) * 60_000 + 60_000).toISOString();
}
