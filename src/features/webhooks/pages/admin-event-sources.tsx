import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { NetworkLabel } from "#/components/crypto-icons/labels";
import { ProButton } from "#/components/pro/base/button";
import { formBooleanValue, ModalForm } from "#/components/pro/form";
import { webhookOperationErrorMessage } from "#/features/webhooks/error-message";
import {
	createPaymentEventSourceFn,
	getPaymentEventSourceCallbackOriginFn,
	type updatePaymentEventSourceFn,
} from "#/features/webhooks/server/payment-event-sources";
import { m } from "#/paraglide/messages";

const networkOptions = [
	{ name: "Ethereum", value: "ethereum" },
	{ name: "Base", value: "base" },
	{ name: "BNB Smart Chain", value: "bsc" },
	{ name: "Polygon", value: "polygon" },
].map((network) => ({
	name: network.name,
	label: <NetworkLabel displayName={network.name} network={network.value} />,
	searchText: `${network.name} ${network.value}`,
	value: network.value,
}));

export function CreatePaymentEventSource({
	trigger,
	onCreated,
}: {
	trigger?: ReactNode;
	onCreated?: () => void | Promise<void>;
} = {}) {
	const [sourceId, setSourceId] = useState("");
	const origin = useQuery({
		queryKey: ["admin", "payment-event-source-callback-origin"],
		queryFn: () => getPaymentEventSourceCallbackOriginFn(),
	});
	useEffect(() => {
		setSourceId(crypto.randomUUID());
	}, []);
	const webhookUrl =
		origin.data && sourceId
			? `${origin.data}/api/providers/alchemy/${sourceId}`
			: "";
	return (
		<ModalForm
			title={m.webhooks_add_event_source()}
			description={m.webhooks_event_source_form_description()}
			trigger={
				trigger ?? (
					<ProButton
						disabled={!sourceId || !origin.data}
						loading={origin.isLoading}
					>
						{m.webhooks_add_event_source()}
					</ProButton>
				)
			}
			initialValues={{ network: "ethereum", enabled: false }}
			schema={[
				{
					name: "network",
					label: m.webhooks_network(),
					valueType: "select",
					required: true,
					fieldProps: { options: networkOptions, searchable: true },
				},
				{
					name: "externalSourceId",
					label: m.webhooks_external_source_id(),
					required: true,
					fieldProps: { minLength: 4, maxLength: 128 },
				},
				{
					name: "signingKey",
					label: m.webhooks_signing_key(),
					valueType: "password",
					required: true,
					fieldProps: { minLength: 16, maxLength: 512 },
				},
				{
					name: "authToken",
					label: m.webhooks_management_token(),
					valueType: "password",
					required: true,
					fieldProps: { minLength: 16, maxLength: 512 },
				},
				{ name: "enabled", label: m.common_enabled(), valueType: "switch" },
			]}
			onFinish={async (values) => {
				await createPaymentEventSourceFn({
					data: {
						id: sourceId,
						network: String(values.network) as
							| "ethereum"
							| "base"
							| "bsc"
							| "polygon",
						externalSourceId: String(values.externalSourceId ?? ""),
						signingKey: String(values.signingKey ?? ""),
						authToken: String(values.authToken ?? ""),
						enabled: formBooleanValue(values.enabled),
					},
				});
				setSourceId(crypto.randomUUID());
				await onCreated?.();
				toast.success(m.webhooks_source_created());
			}}
			onFinishFailed={showWebhookError}
		>
			<div className="mt-4 flex items-center gap-2 rounded-lg border p-3">
				<code className="min-w-0 flex-1 break-all text-xs">
					{webhookUrl || "—"}
				</code>
				<ProButton
					type="button"
					size="icon-sm"
					variant="ghost"
					tooltip={m.webhooks_copy_url()}
					disabled={!webhookUrl}
					onClick={async () => {
						await navigator.clipboard.writeText(webhookUrl);
						toast.success(m.webhooks_url_copied());
					}}
				>
					<Copy />
				</ProButton>
			</div>
		</ModalForm>
	);
}

export type EditableProviderWebhookIngress = {
	id: string;
	externalSourceId: string;
	mode: "shadow" | "active";
	enabled: boolean;
};

export function EditPaymentEventSource({
	source,
	onClose,
	onFinish,
}: {
	source: EditableProviderWebhookIngress;
	onClose: () => void;
	onFinish: (
		data: Parameters<typeof updatePaymentEventSourceFn>[0]["data"],
	) => Promise<unknown>;
}) {
	return (
		<ModalForm
			key={source.id}
			open
			onOpenChange={(open) => !open && onClose()}
			title={m.common_edit()}
			description={`${m.webhooks_event_source_form_description()} ${m.webhooks_active_requirements()}`}
			initialValues={{
				externalSourceId: source.externalSourceId,
				mode: source.mode,
				enabled: source.enabled,
			}}
			schema={[
				{
					name: "externalSourceId",
					label: m.webhooks_external_source_id(),
					required: true,
					fieldProps: { minLength: 4, maxLength: 128 },
				},
				{
					name: "signingKey",
					label: m.webhooks_signing_key(),
					description: m.webhooks_signing_key_preserve(),
					valueType: "password",
					fieldProps: { minLength: 16, maxLength: 512 },
				},
				{
					name: "authToken",
					label: m.webhooks_management_token(),
					description: m.webhooks_management_token_preserve(),
					valueType: "password",
					fieldProps: { minLength: 16, maxLength: 512 },
				},
				{
					name: "clearPreviousSigningKey",
					label: m.webhooks_clear_previous_signing_key(),
					valueType: "switch",
				},
				{
					name: "mode",
					label: m.webhooks_event_mode(),
					valueType: "select",
					required: true,
					fieldProps: {
						options: [
							{ label: m.webhooks_mode_shadow(), value: "shadow" },
							{ label: m.webhooks_mode_active(), value: "active" },
						],
					},
				},
				{ name: "enabled", label: m.common_enabled(), valueType: "switch" },
			]}
			onFinish={async (values) => {
				await onFinish({
					...sourceUpdateInput(source, {
						externalSourceId: String(values.externalSourceId ?? ""),
						mode: values.mode === "active" ? "active" : "shadow",
						enabled: formBooleanValue(values.enabled),
					}),
					...(values.signingKey
						? { signingKey: String(values.signingKey) }
						: {}),
					...(values.authToken ? { authToken: String(values.authToken) } : {}),
					...(formBooleanValue(values.clearPreviousSigningKey)
						? { clearPreviousSigningKey: true }
						: {}),
				});
			}}
			onFinishFailed={showWebhookError}
		/>
	);
}

function sourceUpdateInput(
	source: EditableProviderWebhookIngress,
	overrides: Partial<{
		externalSourceId: string;
		mode: "shadow" | "active";
		enabled: boolean;
	}>,
) {
	return {
		id: source.id,
		externalSourceId: overrides.externalSourceId ?? source.externalSourceId,
		mode: overrides.mode ?? source.mode,
		enabled: overrides.enabled ?? source.enabled,
	};
}

function showWebhookError(error: unknown) {
	toast.error(webhookOperationErrorMessage(error));
}
