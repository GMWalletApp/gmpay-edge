import { type AddressInfo, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertSmtpStartTls,
	SmtpStartTlsUnavailableError,
} from "#/server/runtime/smtp-starttls";

type StubServer = { port: number; close(): Promise<void> };

const servers: StubServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

type StubOptions = {
	greeting?: string;
	ehlo?: string;
	onCommand?: (command: string) => void;
};

async function stubSmtpServer(options: StubOptions = {}) {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		if (options.greeting !== "")
			socket.write(options.greeting ?? "220 mail.example ESMTP\r\n");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let end = buffer.indexOf("\r\n");
			while (end !== -1) {
				const command = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				options.onCommand?.(command);
				const verb = command.split(" ", 1)[0];
				if (verb === "EHLO")
					socket.write(
						options.ehlo ??
							"250-mail.example\r\n250-SIZE 10240000\r\n250-STARTTLS\r\n250 8BITMIME\r\n",
					);
				else if (verb === "QUIT") socket.end("221 bye\r\n");
				else socket.write("500 unexpected\r\n");
				end = buffer.indexOf("\r\n");
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const stub: StubServer = {
		port: (server.address() as AddressInfo).port,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
	servers.push(stub);
	return stub;
}

describe("SMTP STARTTLS preflight", () => {
	it("accepts a relay that advertises STARTTLS and never sends credentials", async () => {
		const commands: string[] = [];
		const { port } = await stubSmtpServer({
			onCommand: (command) => commands.push(command),
		});

		await expect(
			assertSmtpStartTls("127.0.0.1", port, 2_000),
		).resolves.toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(commands).toEqual(["EHLO 127.0.0.1", "QUIT"]);
	});

	it("refuses a plaintext-only relay before any credential is used", async () => {
		const commands: string[] = [];
		const { port } = await stubSmtpServer({
			ehlo: "250-mail.example\r\n250 8BITMIME\r\n",
			onCommand: (command) => commands.push(command),
		});

		await expect(assertSmtpStartTls("127.0.0.1", port, 2_000)).rejects.toThrow(
			SmtpStartTlsUnavailableError,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(commands).toEqual(["EHLO 127.0.0.1", "QUIT"]);
	});

	it("matches the STARTTLS keyword case-insensitively", async () => {
		const { port } = await stubSmtpServer({
			ehlo: "250-mail.example\r\n250 starttls\r\n",
		});
		await expect(
			assertSmtpStartTls("127.0.0.1", port, 2_000),
		).resolves.toBeUndefined();
	});

	it("rejects unexpected greetings and EHLO failures", async () => {
		const rejecting = await stubSmtpServer({ greeting: "554 no service\r\n" });
		await expect(
			assertSmtpStartTls("127.0.0.1", rejecting.port, 2_000),
		).rejects.toThrow("Unexpected SMTP greeting");

		const ehloFailure = await stubSmtpServer({
			ehlo: "502 command not implemented\r\n",
		});
		await expect(
			assertSmtpStartTls("127.0.0.1", ehloFailure.port, 2_000),
		).rejects.toThrow("SMTP EHLO rejected");
	});

	it("times out a silent server and reports closed connections", async () => {
		const silent = await stubSmtpServer({ greeting: "" });
		await expect(
			assertSmtpStartTls("127.0.0.1", silent.port, 100),
		).rejects.toThrow("SMTP STARTTLS probe timed out");

		const closing = await stubSmtpServer({ greeting: "" });
		const probe = assertSmtpStartTls("127.0.0.1", closing.port, 2_000);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await closing.close();
		await expect(probe).rejects.toThrow("SMTP connection closed");
	});
});
