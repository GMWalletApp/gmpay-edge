import { describe, expect, it } from "vitest";
import { emailChannelSchema } from "#/features/settings/email-channels";

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

	it("requires credentials for HTTP providers", () => {
		expect(
			emailChannelSchema.safeParse({
				...base,
				provider: "resend",
				credential: "",
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
