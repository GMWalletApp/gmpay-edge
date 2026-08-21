"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronDown, MoreHorizontal, Pencil, Plus, Send } from "lucide-react";
import { type ComponentProps, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmailProviderLogo } from "#/components/email-provider-logo";
import { ProButton } from "#/components/pro/base/button";
import { ModalForm } from "#/components/pro/form";
import { ProTable } from "#/components/pro/table";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Switch } from "#/components/ui/switch";
import {
	type EmailProviderId,
	emailProviderIds,
} from "#/features/settings/email-channels";
import { settingsErrorMessage } from "#/features/settings/error-message";
import {
	listEmailChannelsFn,
	reorderEmailChannelsFn,
	saveEmailChannelFn,
	sendTestEmailFn,
	setEmailChannelEnabledFn,
} from "#/features/settings/server/email";
import { Main } from "#/layouts/components/main";
import { PageHeader } from "#/layouts/components/page-header";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type EmailChannel = Awaited<
	ReturnType<typeof listEmailChannelsFn>
>["channels"][number];

export function EmailSettingsPage() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "name" });
	const client = useQueryClient();
	const query = useQuery({
		queryKey: ["admin", "email-channels"],
		queryFn: () => listEmailChannelsFn(),
	});
	const [editing, setEditing] = useState<EmailChannel>();
	const [creatingProvider, setCreatingProvider] = useState<EmailProviderId>();
	const [testing, setTesting] = useState<EmailChannel | null>();
	const refresh = useCallback(
		() => client.invalidateQueries({ queryKey: ["admin", "email-channels"] }),
		[client],
	);
	const save = useMutation({
		mutationFn: saveEmailChannelFn,
		onSuccess: async () => {
			setEditing(undefined);
			setCreatingProvider(undefined);
			await refresh();
			toast.success(m.settings_saved());
		},
		onError: (error) => toast.error(settingsErrorMessage(error)),
	});
	const reorder = useMutation({
		mutationFn: reorderEmailChannelsFn,
		onSuccess: refresh,
		onError: (error) => toast.error(settingsErrorMessage(error)),
	});
	const setEnabled = useMutation({
		mutationFn: setEmailChannelEnabledFn,
		onSuccess: refresh,
		onError: (error) => toast.error(settingsErrorMessage(error)),
	});
	const test = useMutation({
		mutationFn: sendTestEmailFn,
		onSuccess: () => {
			setTesting(undefined);
			toast.success(m.settings_email_test_sent());
		},
		onError: (error) => toast.error(settingsErrorMessage(error)),
	});
	const columns = useMemo<ColumnDef<EmailChannel>[]>(
		() => [
			{
				accessorKey: "enabled",
				header: m.common_enabled(),
				meta: { className: "w-20 min-w-20 max-w-20" },
				cell: ({ row }) => (
					<Switch
						aria-label={`${m.common_enabled()} · ${row.original.name}`}
						checked={row.original.enabled}
						disabled={setEnabled.isPending}
						onCheckedChange={(enabled) =>
							setEnabled.mutate({ data: { id: row.original.id, enabled } })
						}
					/>
				),
			},
			{
				accessorKey: "name",
				header: m.settings_email_channel_name(),
				meta: { search: true },
				cell: ({ row }) => <strong>{row.original.name}</strong>,
			},
			{
				accessorKey: "provider",
				header: m.settings_email_provider(),
				meta: { className: "w-48 min-w-48 max-w-48" },
				cell: ({ row }) => (
					<div className="flex items-center gap-2">
						<EmailProviderLogo
							className="size-8"
							providerId={row.original.provider}
						/>
						{emailProviderName(row.original.provider)}
					</div>
				),
			},
			{
				accessorKey: "fromAddress",
				header: m.settings_email_from_address(),
			},
			{
				id: "actions",
				header: m.common_actions(),
				meta: { align: "right" },
				cell: ({ row }) => (
					<div className="flex justify-end">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<ProButton
									size="icon-sm"
									tooltip={m.common_actions()}
									variant="ghost"
								>
									<MoreHorizontal />
								</ProButton>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onClick={() => setTesting(row.original)}>
									<Send />
									{m.settings_email_test_channel()}
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setEditing(row.original)}>
									<Pencil />
									{m.common_edit()}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				),
			},
		],
		[setEnabled],
	);

	return (
		<Main fixed className="gap-4">
			<PageHeader
				title={m.settings_group_email()}
				description={m.settings_group_email_description()}
				actions={
					<div className="flex flex-wrap gap-2">
						<ProButton
							disabled={
								!query.data?.channels.some((channel) => channel.enabled)
							}
							onClick={() => setTesting(null)}
							variant="outline"
						>
							<Send />
							{m.settings_email_test_fallback()}
						</ProButton>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<ProButton>
									<Plus />
									{m.settings_email_add_channel()}
									<ChevronDown />
								</ProButton>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								{emailProviderIds.map((provider) => (
									<DropdownMenuItem
										key={provider}
										onClick={() => setCreatingProvider(provider)}
									>
										<EmailProviderLogo
											className="size-4"
											providerId={provider}
										/>
										{emailProviderName(provider)}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				}
			/>
			<ProTable
				className="min-h-80"
				columns={columns}
				data={query.data?.channels ?? []}
				dragSort={{
					rowKey: "id",
					onDragSortEnd: (rows) =>
						reorder.mutate({ data: { ids: rows.map((row) => row.id) } }),
				}}
				initialState={tableUrlState.initialState}
				loading={query.isPending}
				onChange={tableUrlState.onChange}
				onRefresh={() => query.refetch()}
				table={{ stickyHeader: true }}
				toolbarSearch={{
					columnId: "name",
					placeholder: m.common_search(),
				}}
			/>
			<ModalForm
				key={editing?.id ?? creatingProvider ?? "closed-email-channel"}
				title={
					editing
						? m.settings_email_edit_channel()
						: m.settings_email_add_channel()
				}
				description={m.settings_group_email_description()}
				fieldsClassName="grid gap-4 sm:grid-cols-2"
				initialValues={emailChannelValues(editing, creatingProvider)}
				modalClassName="sm:max-w-2xl"
				onFinish={async (values) => {
					await save.mutateAsync({
						data: {
							id: editing?.id,
							name: String(values.name ?? ""),
							provider: String(values.provider) as EmailProviderId,
							credential: String(values.credential ?? ""),
							domain: String(values.domain ?? ""),
							region: String(values.region ?? "us") as "us" | "eu",
							smtpHost: String(values.smtpHost ?? ""),
							smtpPort: Number(values.smtpPort ?? 587),
							smtpUser: String(values.smtpUser ?? ""),
							fromAddress: String(values.fromAddress ?? ""),
							replyTo: String(values.replyTo ?? ""),
							sortOrder: editing?.sortOrder ?? 100,
							enabled: editing?.enabled ?? true,
						},
					});
				}}
				onOpenChange={(open) => {
					if (!open) {
						setEditing(undefined);
						setCreatingProvider(undefined);
					}
				}}
				open={editing !== undefined || creatingProvider !== undefined}
				schema={emailChannelFormSchema(
					editing?.provider ?? creatingProvider ?? "resend",
				)}
			/>
			<ModalForm
				key={testing?.id ?? "fallback-email-test"}
				title={m.settings_email_test_channel()}
				description={
					testing?.name ?? m.settings_email_test_fallback_description()
				}
				initialValues={{ recipient: "" }}
				onFinish={async (values) => {
					await test.mutateAsync({
						data: {
							channelId: testing?.id ?? null,
							recipient: String(values.recipient ?? ""),
						},
					});
				}}
				onOpenChange={(open) => !open && setTesting(undefined)}
				open={testing !== undefined}
				schema={[
					{
						name: "recipient",
						label: m.common_email(),
						valueType: "email",
						required: true,
					},
				]}
			/>
		</Main>
	);
}

function emailChannelValues(
	channel: EmailChannel | undefined,
	provider: EmailProviderId = "resend",
) {
	return {
		name: channel?.name ?? "",
		provider: channel?.provider ?? provider,
		credential: channel?.credential ?? "",
		domain: channel?.domain ?? "",
		region: channel?.region ?? "us",
		smtpHost: channel?.smtpHost ?? "",
		smtpPort: channel?.smtpPort ?? 587,
		smtpUser: channel?.smtpUser ?? "",
		fromAddress: channel?.fromAddress ?? "",
		replyTo: channel?.replyTo ?? "",
	};
}

const fullWidth = { className: "sm:col-span-2" };
function emailChannelFormSchema(
	provider: EmailProviderId,
): NonNullable<ComponentProps<typeof ModalForm>["schema"]> {
	return [
		{
			name: "name",
			label: m.settings_email_channel_name(),
			required: true,
		},
		{
			name: "provider",
			label: m.settings_email_provider(),
			valueType: "select",
			required: true,
			fieldProps: {
				disabled: true,
				options: emailProviderIds.map((provider) => ({
					value: provider,
					label: emailProviderName(provider),
				})),
			},
		},
		{
			name: "credential",
			label: m.settings_email_credential(),
			valueType: "password",
			hidden: provider === "cloudflare_email",
			formItemProps: fullWidth,
		},
		{
			name: "domain",
			label: m.settings_email_mailgun_domain(),
			required: true,
			hidden: provider !== "mailgun",
		},
		{
			name: "region",
			label: m.settings_email_mailgun_region(),
			valueType: "select",
			required: true,
			hidden: provider !== "mailgun",
			fieldProps: {
				options: [
					{ value: "us", label: "US" },
					{ value: "eu", label: "EU" },
				],
			},
		},
		{
			name: "smtpHost",
			label: m.settings_smtp_host(),
			required: true,
			hidden: provider !== "smtp",
		},
		{
			name: "smtpPort",
			label: m.settings_smtp_port(),
			required: true,
			hidden: provider !== "smtp",
			fieldProps: { inputMode: "numeric" },
		},
		{
			name: "smtpUser",
			label: m.settings_smtp_username(),
			hidden: provider !== "smtp",
			formItemProps: fullWidth,
		},
		{
			name: "fromAddress",
			label: m.settings_email_from_address(),
			required: true,
			formItemProps: fullWidth,
		},
		{
			name: "replyTo",
			label: m.settings_email_reply_to(),
			valueType: "email",
			formItemProps: fullWidth,
		},
	];
}

function emailProviderName(provider: EmailProviderId) {
	if (provider === "cloudflare_email") return "Cloudflare Email";
	if (provider === "sendgrid") return "SendGrid";
	if (provider === "mailgun") return "Mailgun";
	if (provider === "postmark") return "Postmark";
	if (provider === "resend") return "Resend";
	return "SMTP";
}
