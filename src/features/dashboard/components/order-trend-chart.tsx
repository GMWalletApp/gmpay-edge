import {
	Bar,
	CartesianGrid,
	ComposedChart,
	Line,
	XAxis,
	YAxis,
} from "recharts";
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	ChartTooltipContent,
} from "#/components/ui/chart";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

const chartConfig = {
	orderCount: {
		label: m.payment_dashboard_orders_created(),
		color: "var(--chart-1)",
	},
	paidCount: {
		label: m.payment_dashboard_orders_paid(),
		color: "var(--chart-3)",
	},
} satisfies ChartConfig;

export function OrderTrendChart({
	data,
}: {
	data: Array<{ day: string; orderCount: number; paidCount: number }>;
}) {
	const formatted = data.map((item) => ({
		...item,
		label: new Intl.DateTimeFormat(getLocale(), {
			month: "short",
			day: "numeric",
			timeZone: "UTC",
		}).format(new Date(`${item.day}T00:00:00Z`)),
	}));
	return (
		<ChartContainer className="h-72 w-full" config={chartConfig}>
			<ComposedChart data={formatted} accessibilityLayer>
				<CartesianGrid strokeDasharray="3 3" vertical={false} />
				<XAxis dataKey="label" tickLine={false} axisLine={false} />
				<YAxis allowDecimals={false} tickLine={false} axisLine={false} />
				<ChartTooltip content={<ChartTooltipContent />} />
				<ChartLegend content={<ChartLegendContent />} />
				<Bar
					dataKey="orderCount"
					fill="var(--color-orderCount)"
					radius={[6, 6, 0, 0]}
				/>
				<Line
					dataKey="paidCount"
					dot={false}
					stroke="var(--color-paidCount)"
					strokeWidth={2}
					type="monotone"
				/>
			</ComposedChart>
		</ChartContainer>
	);
}
