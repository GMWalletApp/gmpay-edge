import { describe, expect, it } from "vitest";
import { emailChannelSchema } from "#/features/settings/email-channels";

const channelId = "6f0d3c1e-4b2a-4c6d-9e8f-1a2b3c4d5e6f";

const base = {
	name: "Primary",
	credential: "secret",
	domain: "",
	region: "us" as const,
	smtpHost: "",
	smtpPort: 587,
	smtpUser: "",
	fromAddress: "GMPay Edge <security@example.com>",
	replyTo: "",
	sortOrder: 100,
	enabled: true,
};

describe("email channel validation", () => {
	it("accepts Cloudflare Email without an API credential", () => {
		expect(
			emailChannelSchema.parse({
				...base,
				provider: "cloudflare_email",
				credential: "",
			}),
		).toMatchObject({ provider: "cloudflare_email", credential: "" });
	});

	it("requires credentials for HTTP providers when creating a channel", () => {
		expect(
			emailChannelSchema.safeParse({
				...base,
				provider: "resend",
				credential: "",
			}).success,
		).toBe(false);
	});

	it("lets an existing channel keep its stored credential when the field is blank", () => {
		expect(
			emailChannelSchema.safeParse({
				...base,
				id: channelId,
				provider: "resend",
				credential: "",
			}).success,
		).toBe(true);
		expect(
			emailChannelSchema.safeParse({
				...base,
				id: channelId,
				provider: "smtp",
				smtpHost: "smtp.example.com",
				smtpUser: "user@example.com",
				credential: "",
			}).success,
		).toBe(true);
	});

	it("keeps the SMTP username and password paired", () => {
		expect(
			emailChannelSchema.safeParse({
				...base,
				provider: "smtp",
				smtpHost: "smtp.example.com",
				smtpUser: "user@example.com",
				credential: "",
			}).success,
		).toBe(false);
		for (const id of [undefined, channelId])
			expect(
				emailChannelSchema.safeParse({
					...base,
					id,
					provider: "smtp",
					smtpHost: "smtp.example.com",
					smtpUser: "",
					credential: "secret",
				}).success,
			).toBe(false);
	});

	it("rejects private SMTP hosts and port 25", () => {
		for (const [smtpHost, smtpPort] of [
			["localhost", 587],
			["mail.local", 587],
			["smtp.example.com", 25],
		] as const) {
			expect(
				emailChannelSchema.safeParse({
					...base,
					provider: "smtp",
					smtpHost,
					smtpPort,
					smtpUser: "user@example.com",
				}).success,
			).toBe(false);
		}
	});
});
