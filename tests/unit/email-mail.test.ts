import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "#/lib/secrets";
import type {
	RuntimeDatabase,
	RuntimeMailSender,
} from "#/server/runtime/types";

const providerMocks = vi.hoisted(() => {
	const sendEmail = vi.fn();
	const shutdown = vi.fn();
	const provider = () => ({ sendEmail, shutdown });
	return {
		sendEmail,
		shutdown,
		mailgunProvider: vi.fn(provider),
		postmarkProvider: vi.fn(provider),
		resendProvider: vi.fn(provider),
		sendGridProvider: vi.fn(provider),
		smtpProvider: vi.fn(provider),
	};
});

vi.mock("@visulima/email/providers/mailgun", () => ({
	mailgunProvider: providerMocks.mailgunProvider,
}));
vi.mock("@visulima/email/providers/postmark", () => ({
	postmarkProvider: providerMocks.postmarkProvider,
}));
vi.mock("@visulima/email/providers/resend", () => ({
	resendProvider: providerMocks.resendProvider,
}));
vi.mock("@visulima/email/providers/sendgrid", () => ({
	sendGridProvider: providerMocks.sendGridProvider,
}));
vi.mock("@visulima/email/providers/smtp", () => ({
	smtpProvider: providerMocks.smtpProvider,
}));

import { ConfiguredMailSender } from "#/server/runtime/email-mail";

const encryptionSecret = "email-encryption-secret-value";

describe("configured email delivery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		providerMocks.sendEmail.mockResolvedValue({
			success: true,
			data: { messageId: "mail-1" },
		});
	});

	it("falls back from unavailable Cloudflare Email to SMTP", async () => {
		const db = database([
			channel({ id: "cloudflare", provider: "cloudflare_email" }),
			channel({
				id: "smtp",
				provider: "smtp",
				smtp_host: "smtp.example.com",
				smtp_port: 465,
			}),
		]);

		await expect(
			new ConfiguredMailSender(db).send({
				to: "root@example.com",
				subject: "Reset password",
				text: "Reset",
			}),
		).resolves.toEqual({ messageId: "mail-1" });

		expect(providerMocks.smtpProvider).toHaveBeenCalledWith(
			expect.objectContaining({
				host: "smtp.example.com",
				port: 465,
				secure: true,
				rejectUnauthorized: true,
			}),
		);
		expect(providerMocks.sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				from: { email: "security@example.com", name: "GMPay Edge" },
				to: { email: "root@example.com" },
			}),
		);
	});

	it("decrypts API credentials before creating an HTTP provider", async () => {
		const encrypted = await encryptSecret("resend-secret", encryptionSecret);
		const db = database([
			channel({
				id: "resend",
				provider: "resend",
				credential_encrypted: encrypted,
			}),
		]);

		await new ConfiguredMailSender(db).send({
			to: "root@example.com",
			subject: "Reset password",
			text: "Reset",
		});

		expect(providerMocks.resendProvider).toHaveBeenCalledWith({
			apiKey: "resend-secret",
			retries: 0,
			timeout: 10_000,
		});
	});

	it("uses the Cloudflare Email binding when configured", async () => {
		const cloudflareSend = vi.fn().mockResolvedValue({ messageId: "cf-1" });
		const cloudflare = { send: cloudflareSend } as RuntimeMailSender;
		const db = database([
			channel({ id: "cloudflare", provider: "cloudflare_email" }),
		]);

		await new ConfiguredMailSender(db, cloudflare).send({
			to: "root@example.com",
			subject: "Reset password",
			text: "Reset",
		});

		expect(cloudflareSend).toHaveBeenCalledWith(
			expect.objectContaining({
				from: { email: "security@example.com", name: "GMPay Edge" },
				to: "root@example.com",
			}),
		);
	});
});

function database(channels: Array<Record<string, unknown>>) {
	return {
		prepare: vi.fn((sql: string) => ({
			all: vi.fn(async () =>
				sql.includes("FROM email_channel_configs")
					? { results: channels, success: true }
					: { results: [], success: true },
			),
			first: vi.fn(async () =>
				sql.includes("runtime.integration_config_secret")
					? { value: JSON.stringify(encryptionSecret) }
					: null,
			),
		})),
	} as unknown as RuntimeDatabase;
}

function channel(overrides: Record<string, unknown>) {
	return {
		id: "channel",
		provider: "smtp",
		credential_encrypted: null,
		domain: null,
		region: "us",
		smtp_host: null,
		smtp_port: null,
		smtp_user: null,
		from_address: "GMPay Edge <security@example.com>",
		reply_to: null,
		...overrides,
	};
}
