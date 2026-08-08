import { z } from "zod";

const senderSchema = z.email();

export function schedulePasswordResetEmail(
	db: D1Database,
	email: SendEmail | undefined,
	input: { recipient: string; resetUrl: string },
	schedule?: (promise: Promise<unknown>) => void,
) {
	if (!email) {
		console.error(
			JSON.stringify({ event: "password_reset_email_unconfigured" }),
		);
		return;
	}
	const pending = sendPasswordResetEmail(db, email, input).catch(() => {
		console.error(JSON.stringify({ event: "password_reset_email_failed" }));
	});
	if (schedule) schedule(pending);
	else void pending;
}

async function sendPasswordResetEmail(
	db: D1Database,
	email: SendEmail,
	input: { recipient: string; resetUrl: string },
) {
	const rows = await db
		.prepare(
			"SELECT key, value FROM system_settings WHERE key IN ('auth.password_reset_from_email', 'site.name')",
		)
		.all<{ key: string; value: string }>();
	const settings = new Map(
		rows.results.map((row) => [row.key, parseString(row.value)]),
	);
	const sender = senderSchema.parse(
		settings.get("auth.password_reset_from_email"),
	);
	const siteName = settings.get("site.name") || "GMPay Edge";
	await email.send({
		from: { email: sender, name: siteName },
		to: input.recipient,
		subject: `${siteName} password reset`,
		text: `Use this one-time link to reset your password. It expires in 15 minutes:\n\n${input.resetUrl}`,
		html: `<p>Use this one-time link to reset your password. It expires in 15 minutes:</p><p><a href="${escapeHtml(input.resetUrl)}">Reset password</a></p>`,
	});
}

function parseString(value: string | undefined) {
	if (!value) return "";
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "string" ? parsed : "";
	} catch {
		return "";
	}
}

function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}
