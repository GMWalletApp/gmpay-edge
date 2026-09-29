import { Check, Languages } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { Input } from "#/components/pro/base/fields/input";
import { ProEditor } from "#/components/pro/editor";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { telegramOperationErrorMessage } from "#/features/telegram/error-message";
import type { TelegramCommandRecord } from "#/features/telegram/server/commands-admin";
import { renderTelegramTemplate } from "#/features/telegram/template";
import { webhookEventTypes } from "#/features/webhooks/types";
import {
	localeLabels,
	type SupportedLocale,
	supportedLocales,
} from "#/lib/locales";
import { m } from "#/paraglide/messages";

export function showTelegramError(error: unknown) {
	toast.error(telegramOperationErrorMessage(error));
}

export function telegramOptionLabel(value: string) {
	const labels: Record<string, string> = {
		private: m.telegram_target_private(),
		group: m.telegram_target_group(),
		channel: m.telegram_target_channel(),
		default: m.telegram_scope_default(),
		admin: m.telegram_scope_admin(),
	};
	return labels[value] ?? m.common_unknown();
}

export function eventValues(value: unknown) {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export function isWebhookEventType(
	value: string,
): value is (typeof webhookEventTypes)[number] {
	return webhookEventTypes.includes(
		value as (typeof webhookEventTypes)[number],
	);
}

export function emptyTemplateTranslations(): Record<SupportedLocale, string> {
	return Object.fromEntries(
		supportedLocales.map((locale) => [locale, ""]),
	) as Record<SupportedLocale, string>;
}

export function templateTranslations(value: unknown) {
	const result = emptyTemplateTranslations();
	if (typeof value === "string") {
		try {
			return templateTranslations(JSON.parse(value));
		} catch {
			return result;
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		return result;
	for (const locale of supportedLocales) {
		const content = (value as Record<string, unknown>)[locale];
		if (typeof content === "string") result[locale] = content;
	}
	return result;
}

export function commandDescriptions(command: TelegramCommandRecord) {
	return {
		"en-US": command.descriptionEnUs,
		"ja-JP": command.descriptionJaJp,
		"ko-KR": command.descriptionKoKr,
		"ru-RU": command.descriptionRuRu,
		"zh-TW": command.descriptionZhTw,
		"zh-CN": command.descriptionZhCn,
	} satisfies Record<SupportedLocale, string>;
}

export function telegramCommandValues(values: Record<string, unknown>) {
	const descriptions = templateTranslations(values.descriptions);
	return {
		command: String(values.command ?? ""),
		descriptionEnUs: descriptions["en-US"],
		descriptionJaJp: descriptions["ja-JP"],
		descriptionKoKr: descriptions["ko-KR"],
		descriptionRuRu: descriptions["ru-RU"],
		descriptionZhTw: descriptions["zh-TW"],
		descriptionZhCn: descriptions["zh-CN"],
		templateTranslations: templateTranslations(values.templateTranslations),
		scope: String(values.scope ?? "default") as
			| "default"
			| "private"
			| "group"
			| "admin",
		sortOrder: Number(values.sortOrder ?? 100),
	};
}

export function commandFormSchema() {
	return [
		{ name: "command", label: m.telegram_command(), required: true },
		{
			name: "descriptions",
			label: m.common_name(),
			required: true,
			render: (field: {
				value: unknown;
				onChange: (value: string) => void;
			}) => (
				<CommandDescriptionsEditor
					value={templateTranslations(field.value)}
					onChange={(value) => field.onChange(JSON.stringify(value))}
				/>
			),
		},
		templateContentFormField("templateTranslations"),
		{
			name: "scope",
			label: m.telegram_scope(),
			valueType: "select" as const,
			required: true,
			fieldProps: {
				options: ["default", "private", "group", "admin"].map((value) => ({
					label: telegramOptionLabel(value),
					value,
				})),
			},
		},
		{
			name: "sortOrder",
			label: m.telegram_sort_order(),
			valueType: "text" as const,
			required: true,
			fieldProps: { type: "number" },
		},
	];
}

export function templateContentFormField(
	name = "translations",
	showDescription = true,
) {
	return {
		name,
		label: m.telegram_template_content(),
		required: true,
		...(showDescription
			? { description: m.telegram_template_variables() }
			: {}),
		render: (field: { value: unknown; onChange: (value: string) => void }) => (
			<TemplateTranslationsEditor
				value={templateTranslations(field.value)}
				onChange={(value) => field.onChange(JSON.stringify(value))}
			/>
		),
	};
}

function TelegramTemplatePreview({ content }: { content: string }) {
	const rendered = renderTelegramTemplate(content, {
		orderId: "019f5151-example",
		externalOrderId: "ORDER-1001",
		status: "paid",
		amount: "100.00",
		currency: "USD",
		payment: { amount: "100.00", asset: "USDT", network: "TRON" },
	});
	return (
		<Markdown
			components={{
				a: ({ children, ...props }) => (
					<a
						{...props}
						className="text-primary underline underline-offset-4"
						rel="noreferrer"
						target="_blank"
					>
						{children}
					</a>
				),
				code: ({ children }) => (
					<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
						{children}
					</code>
				),
				p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
				pre: ({ children }) => (
					<pre className="mb-3 overflow-auto rounded-md bg-muted p-3 last:mb-0">
						{children}
					</pre>
				),
			}}
		>
			{rendered}
		</Markdown>
	);
}

function TemplateTranslationsEditor({
	value,
	onChange,
}: {
	value: Record<SupportedLocale, string>;
	onChange: (value: Record<SupportedLocale, string>) => void;
}) {
	const [locale, setLocale] = useState<SupportedLocale>("en-US");
	return (
		<ProEditor
			value={value[locale]}
			onChange={(content) => onChange({ ...value, [locale]: content })}
			toolbarTitle={`${m.telegram_template_content()} · ${localeLabels[locale]}`}
			toolbar={<LocaleMenu locale={locale} onChange={setLocale} />}
			preview={{ component: TelegramTemplatePreview }}
		/>
	);
}

function CommandDescriptionsEditor({
	value,
	onChange,
}: {
	value: Record<SupportedLocale, string>;
	onChange: (value: Record<SupportedLocale, string>) => void;
}) {
	const [locale, setLocale] = useState<SupportedLocale>("en-US");
	return (
		<Input
			aria-label={`${m.common_name()} · ${localeLabels[locale]}`}
			inputClassName="pr-3"
			prefix={
				<LocaleMenu
					locale={locale}
					onChange={setLocale}
					align="start"
					className="h-8 rounded-none border-r px-3"
				/>
			}
			value={value[locale]}
			onChange={(event) =>
				onChange({ ...value, [locale]: event.currentTarget.value })
			}
		/>
	);
}

function LocaleMenu({
	locale,
	onChange,
	align = "end",
	className = "h-8",
}: {
	locale: SupportedLocale;
	onChange: (locale: SupportedLocale) => void;
	align?: "start" | "end";
	className?: string;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<ProButton
					aria-label={m.switch_language()}
					className={className}
					size="sm"
					variant="ghost"
				>
					<Languages />
					{localeLabels[locale]}
				</ProButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent align={align}>
				{supportedLocales.map((candidate) => (
					<DropdownMenuItem key={candidate} onClick={() => onChange(candidate)}>
						<span className="w-4">
							{locale === candidate ? <Check /> : null}
						</span>
						{localeLabels[candidate]}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
