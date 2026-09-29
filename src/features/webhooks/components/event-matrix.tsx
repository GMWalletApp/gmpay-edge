import type { ReactNode } from "react";
import { Checkbox } from "#/components/pro/base/fields/checkbox";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "#/components/ui/accordion";
import {
	webhookEventItemLabel,
	webhookEventLabel,
} from "#/features/webhooks/event-label";
import { webhookEventTypes } from "#/features/webhooks/types";
import { cn } from "#/lib/utils";

const groups = [
	{
		id: "order",
		events: webhookEventTypes.filter((event) => event.startsWith("order.")),
	},
	{
		id: "payment",
		events: webhookEventTypes.filter((event) => event.startsWith("payment.")),
	},
] as const;

export function WebhookEventMatrix({
	value,
	onChange,
	selectionMode = "multiple",
	additionalGroups = [],
	flatItems = false,
}: {
	value: readonly string[];
	onChange: (value: string[]) => void;
	selectionMode?: "multiple" | "single";
	flatItems?: boolean;
	additionalGroups?: ReadonlyArray<{
		id: string;
		label: ReactNode;
		events: ReadonlyArray<{ value: string; label: ReactNode }>;
	}>;
}) {
	function update(event: string, checked: boolean) {
		if (selectionMode === "single") {
			onChange(checked ? [event] : []);
			return;
		}
		onChange(
			checked
				? [...new Set(value.filter((item) => item !== "*").concat(event))]
				: value.filter((item) => item !== event),
		);
	}

	return (
		<div className="overflow-hidden rounded-lg border px-3">
			<div className="border-b py-3">
				<div className={cn(!flatItems && "rounded-md border p-3")}>
					<Checkbox
						value={value.includes("*")}
						onChange={(checked) =>
							onChange(
								checked === true ? ["*"] : value.filter((item) => item !== "*"),
							)
						}
					>
						{webhookEventLabel("all")}
					</Checkbox>
				</div>
			</div>
			<Accordion type="multiple" defaultValue={[]}>
				{[
					...groups.map((group) => ({
						...group,
						label: webhookEventLabel(group.id),
						events: group.events.map((event) => ({
							value: event,
							label: webhookEventItemLabel(event),
						})),
					})),
					...additionalGroups,
				].map((group) => (
					<AccordionItem key={group.id} value={group.id}>
						<AccordionTrigger>{group.label}</AccordionTrigger>
						<AccordionContent className="grid gap-3 sm:grid-cols-2">
							{group.events.map((event) => (
								<div
									className={cn(flatItems ? "py-1" : "rounded-md border p-3")}
									key={event.value}
								>
									<Checkbox
										value={value.includes(event.value)}
										onChange={(checked) =>
											update(event.value, checked === true)
										}
									>
										{event.label}
									</Checkbox>
								</div>
							))}
						</AccordionContent>
					</AccordionItem>
				))}
			</Accordion>
		</div>
	);
}
