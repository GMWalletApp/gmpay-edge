import { mailgunProvider } from "@visulima/email/providers/mailgun";
import { postmarkProvider } from "@visulima/email/providers/postmark";
import { resendProvider } from "@visulima/email/providers/resend";
import { sendGridProvider } from "@visulima/email/providers/sendgrid";
import { smtpProvider } from "@visulima/email/providers/smtp";
import type { EmailProviderId } from "#/features/settings/email-channels";
import { decryptSecret } from "#/lib/secrets";
import type {
	RuntimeDatabase,
	RuntimeEmailAddress,
	RuntimeEmailMessage,
	RuntimeMailSender,
} from "#/server/runtime/types";

type EmailChannelRow = {
	id: string;
	provider: EmailProviderId;
	credential_encrypted: string | null;
	domain: string | null;
	region: "us" | "eu";
	smtp_host: string | null;
	smtp_port: number | null;
	smtp_user: string | null;
	from_address: string;
	reply_to: string | null;
};

export class ConfiguredMailSender implements RuntimeMailSender {
	constructor(
		private readonly db: RuntimeDatabase,
		private readonly cloudflareEmail?: RuntimeMailSender,
	) {}

	send(message: RuntimeEmailMessage) {
		return sendConfiguredEmail(this.db, this.cloudflareEmail, message);
	}
}

export async function sendConfiguredEmail(
	db: RuntimeDatabase,
	cloudflareEmail: RuntimeMailSender | undefined,
	message: RuntimeEmailMessage,
	channelId?: string,
) {
	const channels = await loadEnabledChannels(db, channelId);
	if (channels.length === 0) throw new Error("No enabled email channel");
	const encryptionSecret = await loadEncryptionSecret(db);
	let lastError: unknown;
	for (const channel of channels) {
		try {
			return await sendWithChannel(
				channel,
				encryptionSecret,
				cloudflareEmail,
				message,
			);
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error("All enabled email channels failed", { cause: lastError });
}

async function loadEnabledChannels(
	db: RuntimeDatabase,
	channelId?: string,
): Promise<EmailChannelRow[]> {
	const rows = await db
		.prepare(
			`SELECT id, provider, credential_encrypted, domain, region, smtp_host,
			 smtp_port, smtp_user, from_address, reply_to
			 FROM email_channel_configs WHERE enabled = 1
			 ORDER BY sort_order, id`,
		)
		.all<EmailChannelRow>();
	return channelId
		? rows.results.filter((channel) => channel.id === channelId)
		: rows.results;
}

async function loadEncryptionSecret(db: RuntimeDatabase) {
	const row = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'runtime.integration_config_secret' LIMIT 1",
		)
		.first<{ value: string }>();
	if (!row) throw new Error("Email credential encryption is unavailable");
	try {
		const value: unknown = JSON.parse(row.value);
		if (typeof value === "string" && value.length >= 16) return value;
	} catch {}
	throw new Error("Email credential encryption is unavailable");
}

async function sendWithChannel(
	channel: EmailChannelRow,
	encryptionSecret: string,
	cloudflareEmail: RuntimeMailSender | undefined,
	message: RuntimeEmailMessage,
) {
	const configuredMessage: RuntimeEmailMessage = {
		...message,
		from: parseEmailAddress(channel.from_address),
		replyTo: channel.reply_to
			? parseEmailAddress(channel.reply_to)
			: message.replyTo,
	};
	if (channel.provider === "cloudflare_email") {
		if (!cloudflareEmail)
			throw new Error("Cloudflare Email binding is unavailable");
		return cloudflareEmail.send(configuredMessage);
	}
	const credential = channel.credential_encrypted
		? await decryptSecret(channel.credential_encrypted, encryptionSecret)
		: "";
	const provider = createProvider(channel, credential);
	try {
		const result = await provider.sendEmail({
			from: toProviderAddress(configuredMessage.from),
			to: toProviderAddresses(configuredMessage.to),
			cc: configuredMessage.cc
				? toProviderAddresses(configuredMessage.cc)
				: undefined,
			bcc: configuredMessage.bcc
				? toProviderAddresses(configuredMessage.bcc)
				: undefined,
			replyTo: configuredMessage.replyTo
				? toProviderAddress(configuredMessage.replyTo)
				: undefined,
			subject: configuredMessage.subject,
			text: configuredMessage.text,
			html: configuredMessage.html,
			headers: configuredMessage.headers,
		});
		if (!result.success)
			throw result.error instanceof Error
				? result.error
				: new Error("Email provider delivery failed");
		return result.data;
	} finally {
		await provider.shutdown?.();
	}
}

function createProvider(channel: EmailChannelRow, credential: string) {
	const common = { retries: 0, timeout: 10_000 } as const;
	switch (channel.provider) {
		case "resend":
			return resendProvider({ apiKey: credential, ...common });
		case "postmark":
			return postmarkProvider({ serverToken: credential, ...common });
		case "sendgrid":
			return sendGridProvider({ apiKey: credential, ...common });
		case "mailgun":
			return mailgunProvider({
				apiKey: credential,
				domain: channel.domain ?? "",
				endpoint:
					channel.region === "eu"
						? "https://api.eu.mailgun.net"
						: "https://api.mailgun.net",
				...common,
			});
		case "smtp":
			return smtpProvider({
				host: channel.smtp_host ?? "",
				port: channel.smtp_port ?? 587,
				secure: channel.smtp_port === 465,
				rejectUnauthorized: true,
				pool: false,
				...(channel.smtp_user
					? { user: channel.smtp_user, password: credential }
					: {}),
				...common,
			});
		case "cloudflare_email":
			throw new Error("Cloudflare Email uses its runtime binding");
	}
}

function parseEmailAddress(value: string): RuntimeEmailAddress {
	const displayAddress = /^(.*?)\s*<([^<>]+)>$/.exec(value.trim());
	if (!displayAddress) return value.trim();
	return {
		email: displayAddress[2]?.trim() ?? "",
		name: displayAddress[1]?.trim().replace(/^"|"$/g, "") ?? "",
	};
}

function toProviderAddresses(
	address: RuntimeEmailAddress | RuntimeEmailAddress[],
) {
	return Array.isArray(address)
		? address.map(toProviderAddress)
		: toProviderAddress(address);
}

function toProviderAddress(address: RuntimeEmailAddress | undefined) {
	if (!address) throw new Error("Email sender is unavailable");
	return typeof address === "string"
		? { email: address }
		: { email: address.email, name: address.name };
}
