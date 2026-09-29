import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { Activity, CircleCheck, ReceiptText, Webhook } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { StatusBadge } from "#/components/status-badge";
import { Badge } from "#/components/ui/badge";
import { getAdminDashboardFn } from "#/features/dashboard/server/admin";
import { Main } from "#/layouts/components/main";
import { PageHeader } from "#/layouts/components/page-header";
import {
	formatDateTime,
	formatDecimalAmount,
	formatNumber,
} from "#/lib/format";
import { m } from "#/paraglide/messages";

const OrderTrendChart = lazy(() =>
	import("#/features/dashboard/components/order-trend-chart").then(
		(module) => ({
			default: module.OrderTrendChart,
		}),
	),
);

export const dashboardQuery = queryOptions({
	queryKey: ["admin", "dashboard"],
	queryFn: () => getAdminDashboardFn(),
	// Match the polling interval so focus restores do not add a second request
	// immediately before the scheduled refresh.
	staleTime: 30_000,
	refetchInterval: 30_000,
});

export function AdminDashboardPage() {
	return (
		<Main fixed className="gap-4">
			<PageHeader
				title={m.payment_dashboard_title()}
				description={m.payment_dashboard_description()}
			/>
			<Suspense fallback={<DashboardPending />}>
				<DashboardContent />
			</Suspense>
		</Main>
	);
}

function DashboardContent() {
	const { data } = useSuspenseQuery(dashboardQuery);
	const metrics = [
		[
			"orders",
			m.payment_dashboard_total_orders(),
			formatNumber(data.orders.total),
			ReceiptText,
		],
		[
			"paid",
			m.payment_dashboard_paid_orders(),
			formatNumber(data.orders.paid),
			CircleCheck,
		],
		[
			"payments",
			m.payment_dashboard_payments(),
			formatNumber(data.payments.total),
			Activity,
		],
		[
			"webhooks",
			m.payment_dashboard_webhook_success(),
			data.webhooks.successRate == null ? "—" : `${data.webhooks.successRate}%`,
			Webhook,
		],
	] as const;
	return (
		<>
			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				{metrics.map(([id, label, value, Icon]) => (
					<article
						className="rounded-2xl border bg-card p-5 shadow-sm"
						key={id}
					>
						<div className="flex items-center justify-between text-muted-foreground text-sm">
							<span>{label}</span>
							<Icon className="size-4" />
						</div>
						<p className="mt-5 font-semibold text-3xl">{value}</p>
					</article>
				))}
			</div>
			<div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
				<section className="rounded-2xl border bg-card p-5 shadow-sm">
					<div className="mb-4">
						<h2 className="font-medium text-lg">
							{m.payment_dashboard_order_trend()}
						</h2>
						<p className="text-muted-foreground text-sm">
							{m.payment_dashboard_order_trend_description()}
						</p>
					</div>
					<Suspense
						fallback={
							<div className="h-72 animate-pulse rounded-xl bg-muted/50" />
						}
					>
						<OrderTrendChart data={data.dailyOrders} />
					</Suspense>
				</section>
				<section className="rounded-2xl border bg-card p-5 shadow-sm">
					<h2 className="font-medium text-lg">
						{m.payment_dashboard_operations()}
					</h2>
					<p className="mb-4 text-muted-foreground text-sm">
						{m.payment_dashboard_operations_description()}
					</p>
					<div className="divide-y">
						<HealthRow
							label={m.receiving_methods_title()}
							ready={data.receivingMethods.enabled}
							total={data.receivingMethods.total}
						/>
						<HealthRow
							label={m.payment_dashboard_connections()}
							ready={data.connections.healthy}
							total={data.connections.total}
						/>
						<HealthRow
							label={m.payment_dashboard_webhooks()}
							ready={data.webhooks.succeeded}
							total={data.webhooks.completed}
						/>
					</div>
				</section>
			</div>
			<section className="min-h-0 flex-1 overflow-hidden rounded-2xl border bg-card">
				<div className="border-b px-6 py-4">
					<h2 className="font-medium text-lg">
						{m.payment_dashboard_recent_orders()}
					</h2>
					<p className="text-muted-foreground text-sm">
						{m.payment_dashboard_recent_orders_description()}
					</p>
				</div>
				<div className="h-full overflow-y-auto">
					{data.recentOrders.length ? (
						data.recentOrders.map((order) => (
							<div
								className="grid gap-2 border-b px-6 py-4 last:border-b-0 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-4"
								key={order.id}
							>
								<div className="min-w-0">
									<strong className="block truncate text-sm">
										{order.externalOrderId}
									</strong>
									<DashboardDateTime value={order.createdAt} />
								</div>
								<div>
									<span className="block text-sm">
										{formatDecimalAmount(order.amount)} {order.currency}
									</span>
									<small className="text-muted-foreground">
										{order.assetCode} · {order.network}
									</small>
								</div>
								<div className="sm:justify-self-end">
									<StatusBadge value={order.status} />
								</div>
							</div>
						))
					) : (
						<div className="grid min-h-48 place-items-center text-muted-foreground text-sm">
							{m.payment_dashboard_no_orders()}
						</div>
					)}
				</div>
			</section>
		</>
	);
}

function DashboardDateTime({ value }: { value: string }) {
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	return (
		<small className="text-muted-foreground">
			{formatDateTime(value, undefined, mounted ? undefined : "UTC")}
		</small>
	);
}

function DashboardPending() {
	return (
		<div className="grid flex-1 gap-4">
			<span className="sr-only">{m.common_loading()}</span>
			<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
				{[0, 1, 2, 3].map((item) => (
					<div
						className="h-32 animate-pulse rounded-2xl border bg-muted/50"
						key={item}
					/>
				))}
			</div>
			<div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
				<div className="h-72 animate-pulse rounded-2xl border bg-muted/50" />
				<div className="h-72 animate-pulse rounded-2xl border bg-muted/50" />
			</div>
			<div className="min-h-48 animate-pulse rounded-2xl border bg-muted/50" />
		</div>
	);
}

function HealthRow({
	label,
	ready,
	total,
}: {
	label: string;
	ready: number;
	total: number;
}) {
	const complete = total > 0 && ready === total;
	return (
		<div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
			<span className="text-sm">{label}</span>
			<Badge variant={complete ? "default" : "outline"}>
				{ready} / {total}
			</Badge>
		</div>
	);
}
