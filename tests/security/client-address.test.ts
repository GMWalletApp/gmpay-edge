import { describe, expect, it } from "vitest";
import {
	isTrustedProxyAddress,
	readPeerAddress,
	resolveClientAddress,
	withClientAddress,
} from "#/server/runtime/client-address";

const headers = (values: Record<string, string>) => new Headers(values);

describe("Bun client address trust", () => {
	it.each([
		"127.0.0.1",
		"127.255.255.254",
		"10.0.0.1",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.10",
		"169.254.10.1",
		"::1",
		"fc00::1",
		"fd12:3456::1",
		"fe80::1",
		"FE80::1",
		"::ffff:127.0.0.1",
		"::ffff:10.1.2.3",
	])("treats %s as an operator-managed proxy peer", (address) => {
		expect(isTrustedProxyAddress(address)).toBe(true);
	});

	it.each([
		"8.8.8.8",
		"172.15.255.255",
		"172.32.0.1",
		"100.64.0.1",
		"192.169.0.1",
		"2001:db8::1",
		"fec0::1",
		"::ffff:203.0.113.9",
		"not-an-address",
		"",
	])("treats %s as an untrusted public peer", (address) => {
		expect(isTrustedProxyAddress(address)).toBe(false);
	});

	it("honors the right-most forwarded hop and HTTPS from a trusted peer", () => {
		expect(
			resolveClientAddress(
				"127.0.0.1",
				headers({
					"x-forwarded-for": "10.9.9.9, 203.0.113.9, 198.51.100.7",
					"x-forwarded-proto": "http, https",
				}),
			),
		).toEqual({ address: "198.51.100.7", forwardedProtocol: "https" });
	});

	it("ignores forwarded headers from public peers", () => {
		expect(
			resolveClientAddress(
				"203.0.113.9",
				headers({
					"x-forwarded-for": "198.51.100.7",
					"x-forwarded-proto": "https",
				}),
			),
		).toEqual({ address: "203.0.113.9", forwardedProtocol: undefined });
	});

	it("keeps the proxy address when the forwarded hop is unusable", () => {
		for (const hop of [
			"unknown",
			"_hidden",
			"",
			"999.1.1.1",
			"203.0.113.9:x",
		]) {
			expect(
				resolveClientAddress("10.0.0.2", headers({ "x-forwarded-for": hop })),
			).toEqual({ address: "10.0.0.2", forwardedProtocol: undefined });
		}
	});

	it("normalizes IPv4-mapped peers and hop forms with ports", () => {
		expect(resolveClientAddress("::ffff:127.0.0.1", headers({})).address).toBe(
			"127.0.0.1",
		);
		expect(
			resolveClientAddress(
				"::1",
				headers({ "x-forwarded-for": "[2001:DB8::1]:4711" }),
			).address,
		).toBe("2001:db8::1");
		expect(
			resolveClientAddress(
				"::1",
				headers({ "x-forwarded-for": "203.0.113.9:4711" }),
			).address,
		).toBe("203.0.113.9");
	});

	it("yields no address and no upgrade without a socket peer", () => {
		expect(
			resolveClientAddress(
				undefined,
				headers({
					"x-forwarded-for": "198.51.100.7",
					"x-forwarded-proto": "https",
					"cf-connecting-ip": "198.51.100.7",
				}),
			),
		).toEqual({ address: undefined, forwardedProtocol: undefined });
	});

	it("reads the srvx socket peer and rejects other shapes", () => {
		const request = new Request("http://pay.example/");
		expect(readPeerAddress(request)).toBeUndefined();
		Object.defineProperty(request, "ip", { value: "10.0.0.7" });
		expect(readPeerAddress(request)).toBe("10.0.0.7");
		const invalid = new Request("http://pay.example/");
		Object.defineProperty(invalid, "ip", { value: { address: "10.0.0.7" } });
		expect(readPeerAddress(invalid)).toBeUndefined();
	});
});

describe("withClientAddress", () => {
	it("overwrites a spoofed cf-connecting-ip with the public peer", () => {
		const forwarded = withClientAddress(
			new Request("http://pay.example/api/auth/sign-in", {
				method: "POST",
				body: "payload",
				headers: {
					"cf-connecting-ip": "198.51.100.7",
					"x-forwarded-for": "198.51.100.7",
					"x-forwarded-proto": "https",
					"content-type": "text/plain",
				},
			}),
			"203.0.113.9",
		);

		expect(forwarded.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
		expect(forwarded.headers.has("x-forwarded-for")).toBe(false);
		expect(forwarded.headers.has("x-forwarded-proto")).toBe(false);
		expect(forwarded.headers.get("content-type")).toBe("text/plain");
		expect(forwarded.url).toBe("http://pay.example/api/auth/sign-in");
		expect(forwarded.method).toBe("POST");
	});

	it("preserves the request body across the rewrite", async () => {
		const forwarded = withClientAddress(
			new Request("http://pay.example/api/action", {
				method: "POST",
				body: JSON.stringify({ amount: "1.00" }),
			}),
			"203.0.113.9",
		);
		await expect(forwarded.json()).resolves.toEqual({ amount: "1.00" });
	});

	it("applies trusted forwarding to the URL scheme and client address", () => {
		const forwarded = withClientAddress(
			new Request("http://pay.example/install", {
				headers: {
					"cf-connecting-ip": "spoofed",
					"x-forwarded-for": "198.51.100.7",
					"x-forwarded-proto": "https",
				},
			}),
			"127.0.0.1",
		);

		expect(forwarded.url).toBe("https://pay.example/install");
		expect(forwarded.headers.get("cf-connecting-ip")).toBe("198.51.100.7");
	});

	it("strips cf-connecting-ip entirely when no peer is known", () => {
		const forwarded = withClientAddress(
			new Request("http://pay.example/", {
				headers: { "cf-connecting-ip": "198.51.100.7" },
			}),
			undefined,
		);
		expect(forwarded.headers.has("cf-connecting-ip")).toBe(false);
		expect(forwarded.url).toBe("http://pay.example/");
	});

	it("never downgrades a request Bun already received over TLS", () => {
		const forwarded = withClientAddress(
			new Request("https://pay.example/", {
				headers: { "x-forwarded-proto": "http" },
			}),
			"127.0.0.1",
		);
		expect(forwarded.url).toBe("https://pay.example/");
	});
});
