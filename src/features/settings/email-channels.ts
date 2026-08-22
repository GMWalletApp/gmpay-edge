import { z } from "zod";

export const emailProviderIds = [
	"resend",
	"postmark",
	"sendgrid",
	"mailgun",
	"smtp",
	"cloudflare_email",
] as const;

export type EmailProviderId = (typeof emailProviderIds)[number];

const publicSmtpHostname =
	/^(?=.{1,253}$)(?!localhost$)(?!.*\.local$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export const emailChannelSchema = z
	.object({
		id: z.uuid().optional(),
		name: z.string().trim().min(1).max(80),
		provider: z.enum(emailProviderIds),
		credential: z.string().max(1_000).default(""),
		domain: z.string().trim().max(253).default(""),
		region: z.enum(["us", "eu"]).default("us"),
		smtpHost: z
			.string()
			.trim()
			.max(253)
			.regex(publicSmtpHostname, "Enter a public SMTP hostname")
			.or(z.literal(""))
			.default(""),
		smtpPort: z
			.number()
			.int()
			.min(1)
			.max(65_535)
			.refine((port) => port !== 25, "SMTP port 25 is not supported")
			.default(587),
		smtpUser: z.string().trim().max(320).default(""),
		fromAddress: z.string().trim().min(3).max(320),
		replyTo: z.union([z.literal(""), z.email().max(320)]).default(""),
		sortOrder: z.number().int().min(0).max(1_000_000).default(100),
		enabled: z.boolean().default(true),
	})
	.superRefine((value, context) => {
		if (value.provider === "mailgun" && !value.domain)
			context.addIssue({
				code: "custom",
				message: "Mailgun domain is required",
				path: ["domain"],
			});
		if (
			["resend", "postmark", "sendgrid", "mailgun"].includes(value.provider) &&
			!value.credential
		)
			context.addIssue({
				code: "custom",
				message: "Provider API key is required",
				path: ["credential"],
			});
		if (value.provider === "smtp") {
			if (!value.smtpHost)
				context.addIssue({
					code: "custom",
					message: "SMTP host is required",
					path: ["smtpHost"],
				});
			if (Boolean(value.smtpUser) !== Boolean(value.credential))
				context.addIssue({
					code: "custom",
					message: "SMTP username and password must be configured together",
					path: [value.smtpUser ? "credential" : "smtpUser"],
				});
		}
	});

export const emailChannelEnabledSchema = z.object({
	id: z.uuid(),
	enabled: z.boolean(),
});

export const emailChannelOrderSchema = z
	.object({ ids: z.array(z.uuid()).min(1).max(100) })
	.superRefine((value, context) => {
		if (new Set(value.ids).size !== value.ids.length)
			context.addIssue({
				code: "custom",
				path: ["ids"],
				message: "Email channel IDs must be unique",
			});
	});
