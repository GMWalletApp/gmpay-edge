import { createConnection } from "node:net";

export class SmtpStartTlsUnavailableError extends Error {
	override readonly name = "SmtpStartTlsUnavailableError";

	constructor() {
		super("SMTP server does not advertise STARTTLS");
	}
}

/**
 * The SMTP provider upgrades opportunistically: when EHLO does not advertise
 * STARTTLS it keeps the plaintext connection and would send AUTH credentials
 * and the message unencrypted. Probing the capability first refuses
 * plaintext-only relays before any secret leaves the process. Implicit TLS on
 * port 465 needs no probe because the provider connects with TLS directly.
 */
export async function assertSmtpStartTls(
	host: string,
	port: number,
	timeoutMs: number,
): Promise<void> {
	const capabilities = await readEhloCapabilities(host, port, timeoutMs);
	if (!capabilities.includes("STARTTLS"))
		throw new SmtpStartTlsUnavailableError();
}

function readEhloCapabilities(host: string, port: number, timeoutMs: number) {
	return new Promise<string[]>((resolve, reject) => {
		const socket = createConnection({ host, port });
		let buffer = "";
		let greeted = false;
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			reject(error);
		};
		const timer = setTimeout(
			() => fail(new Error("SMTP STARTTLS probe timed out")),
			timeoutMs,
		);
		socket.setEncoding("utf8");
		socket.on("error", fail);
		socket.on("close", () => fail(new Error("SMTP connection closed")));
		socket.on("data", (chunk: string) => {
			if (settled) return;
			buffer += chunk;
			const reply = takeSmtpReply(buffer);
			if (!reply) return;
			buffer = reply.rest;
			if (!greeted) {
				if (reply.code !== "220")
					return fail(new Error("Unexpected SMTP greeting"));
				greeted = true;
				socket.write(`EHLO ${host}\r\n`);
				return;
			}
			if (reply.code !== "250") return fail(new Error("SMTP EHLO rejected"));
			settled = true;
			clearTimeout(timer);
			// QUIT closes politely; unref keeps a slow server from holding the process.
			socket.end("QUIT\r\n");
			socket.unref();
			resolve(
				reply.lines
					.slice(1)
					.map((line) => line.split(" ", 1)[0]?.toUpperCase() ?? ""),
			);
		});
	});
}

/** Returns one complete reply (`250-...` continuation lines ending in `250 ...`). */
function takeSmtpReply(buffer: string) {
	const lines: string[] = [];
	let offset = 0;
	while (true) {
		const end = buffer.indexOf("\r\n", offset);
		if (end === -1) return undefined;
		const line = buffer.slice(offset, end);
		offset = end + 2;
		const match = /^(\d{3})([ -]?)(.*)$/.exec(line);
		if (!match) return { code: "", lines, rest: buffer.slice(offset) };
		lines.push(match[3] ?? "");
		if (match[2] !== "-")
			return { code: match[1] ?? "", lines, rest: buffer.slice(offset) };
	}
}
