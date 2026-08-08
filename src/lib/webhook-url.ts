import { z } from "zod";

const blockedHostnames = new Set([
	"0.0.0.0",
	"localhost",
	"localhost.localdomain",
	"metadata.google.internal",
	"169.254.169.254",
	"[::]",
	"[::1]",
]);

export function isSafeWebhookUrl(value: string) {
	return isSafePublicUrl(value, ["https:"]);
}

export function isSafePublicUrl(
	value: string,
	allowedProtocols: readonly string[],
) {
	try {
		const url = new URL(value);
		if (
			!allowedProtocols.includes(url.protocol) ||
			url.username ||
			url.password
		)
			return false;
		const hostname = url.hostname.toLowerCase();
		if (
			blockedHostnames.has(hostname) ||
			hostname.endsWith(".local") ||
			hostname.endsWith(".internal") ||
			hostname.endsWith(".localhost")
		)
			return false;
		return !isPrivateIpv4(hostname) && !isPrivateIpv6(hostname);
	} catch {
		return false;
	}
}

const dnsResponseSchema = z.object({
	Status: z.number().int(),
	Answer: z
		.array(
			z.object({
				type: z.number().int(),
				data: z.string(),
			}),
		)
		.optional(),
});

export type WebhookHostnameResolver = (hostname: string) => Promise<string[]>;

export async function assertSafeResolvedWebhookUrl(
	value: string,
	resolveHostname: WebhookHostnameResolver,
) {
	if (!isSafeWebhookUrl(value)) return false;
	const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "");
	if (isIpAddress(hostname)) return isPublicIpAddress(hostname);
	const addresses = await resolveHostname(hostname);
	return addresses.length > 0 && addresses.every(isPublicIpAddress);
}

export async function resolveWebhookHostname(
	hostname: string,
	fetcher: typeof fetch = fetch,
) {
	const responses = await Promise.all(
		["A", "AAAA"].map((type) =>
			fetcher(
				`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
				{
					headers: { accept: "application/dns-json" },
					redirect: "error",
					signal: AbortSignal.timeout(3_000),
				},
			),
		),
	);
	const addresses: string[] = [];
	for (const response of responses) {
		if (!response.ok) throw new Error("Webhook DNS resolution failed");
		const result = dnsResponseSchema.parse(await response.json());
		if (result.Status !== 0) continue;
		for (const answer of result.Answer ?? [])
			if (answer.type === 1 || answer.type === 28) addresses.push(answer.data);
	}
	return addresses;
}

function isIpAddress(hostname: string) {
	return (
		isPrivateIpv4(hostname) ||
		parseIpv6(hostname) !== null ||
		/^\d+(?:\.\d+){3}$/.test(hostname)
	);
}

function isPublicIpAddress(address: string) {
	if (/^\d+(?:\.\d+){3}$/.test(address)) return !isPrivateIpv4(address);
	if (parseIpv6(address) !== null) return !isPrivateIpv6(address);
	return false;
}

function isPrivateIpv4(hostname: string) {
	const parts = hostname.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part)))
		return false;
	const octets = parts.map(Number);
	if (octets.some((octet) => octet > 255)) return true;
	return isPrivateIpv4Octets(octets);
}

function isPrivateIpv4Octets(octets: number[]) {
	const [a, b, c] = octets;
	if (a === undefined || b === undefined || c === undefined) return true;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 192 && b === 88 && c === 99) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

function isPrivateIpv6(hostname: string) {
	const address = parseIpv6(hostname.replace(/^\[|\]$/g, "").toLowerCase());
	if (address === null) return false;
	const upper96 = address >> 32n;
	if (upper96 === 0n || upper96 === 0xffffn) {
		const ipv4 = Number(address & 0xffff_ffffn);
		return isPrivateIpv4Octets([
			(ipv4 >>> 24) & 255,
			(ipv4 >>> 16) & 255,
			(ipv4 >>> 8) & 255,
			ipv4 & 255,
		]);
	}
	return (
		address === 0n ||
		address === 1n ||
		address >> 64n === 0x100n ||
		address >> 80n === 0x2001_0002n ||
		address >> 96n === 0x2001_0db8n ||
		address >> 121n === 0x7en ||
		address >> 118n === 0x3fan ||
		address >> 120n === 0xffn
	);
}

function parseIpv6(value: string) {
	if (!value.includes(":")) return null;
	const halves = value.split("::");
	if (halves.length > 2) return null;
	const left = halves[0]?.split(":").filter(Boolean) ?? [];
	const right = halves[1]?.split(":").filter(Boolean) ?? [];
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
	const groups = [
		...left,
		...Array.from({ length: missing }, () => "0"),
		...right,
	];
	if (
		groups.length !== 8 ||
		groups.some((part) => !/^[\da-f]{1,4}$/.test(part))
	)
		return null;
	return groups.reduce(
		(result, part) => (result << 16n) | BigInt(`0x${part}`),
		0n,
	);
}
