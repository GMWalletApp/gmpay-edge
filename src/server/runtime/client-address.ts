import { isIPv4, isIPv6 } from "node:net";

/**
 * Bun serves plain sockets, so the only authoritative client fact is the peer
 * address of the connection. Forwarding headers are honored solely when that
 * peer is a loopback, private, or link-local address: the place where an
 * operator-managed reverse proxy terminates TLS. Public peers may be anyone,
 * so their forwarded headers are discarded and they count as the client.
 * Cloudflare Workers never reach this module; Cloudflare sets
 * `cf-connecting-ip` itself.
 */
export type ClientAddressResolution = {
	address: string | undefined;
	forwardedProtocol: "https" | undefined;
};

export function resolveClientAddress(
	peerAddress: string | undefined,
	headers: Headers,
): ClientAddressResolution {
	const peer =
		peerAddress === undefined ? undefined : normalizeIpAddress(peerAddress);
	if (!peer || !isTrustedProxyAddress(peer))
		return { address: peer, forwardedProtocol: undefined };
	const forwardedHop = lastForwardedValue(headers.get("x-forwarded-for"));
	const protocol = lastForwardedValue(
		headers.get("x-forwarded-proto"),
	)?.toLowerCase();
	return {
		address: (forwardedHop && parseForwardedAddress(forwardedHop)) || peer,
		forwardedProtocol: protocol === "https" ? "https" : undefined,
	};
}

/**
 * Rewrites the request so `cf-connecting-ip` and `request.url` carry the
 * resolved client address and scheme. Inbound forwarding headers are consumed
 * here and never reach application code.
 */
export function withClientAddress(
	request: Request,
	peerAddress = readPeerAddress(request),
): Request {
	const resolved = resolveClientAddress(peerAddress, request.headers);
	const url = new URL(request.url);
	if (resolved.forwardedProtocol === "https") url.protocol = "https:";
	const forwarded = new Request(url, request);
	forwarded.headers.delete("x-forwarded-for");
	forwarded.headers.delete("x-forwarded-proto");
	if (resolved.address)
		forwarded.headers.set("cf-connecting-ip", resolved.address);
	else forwarded.headers.delete("cf-connecting-ip");
	return forwarded;
}

/** srvx exposes the Bun socket peer as `request.ip`; anything else is untrusted. */
export function readPeerAddress(request: Request): string | undefined {
	if (!("ip" in request)) return undefined;
	const ip: unknown = request.ip;
	return typeof ip === "string" && ip !== "" ? ip : undefined;
}

export function isTrustedProxyAddress(address: string): boolean {
	const normalized = normalizeIpAddress(address);
	if (!normalized) return false;
	if (isIPv4(normalized)) {
		const [first = 0, second = 0] = normalized.split(".").map(Number);
		return (
			first === 127 ||
			first === 10 ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 168) ||
			(first === 169 && second === 254)
		);
	}
	return (
		normalized === "::1" ||
		/^f[cd][0-9a-f]{2}:/.test(normalized) ||
		/^fe[89ab][0-9a-f]:/.test(normalized)
	);
}

function normalizeIpAddress(value: string): string | undefined {
	const trimmed = value.trim();
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
	const candidate = mapped?.[1] ?? trimmed;
	if (isIPv4(candidate)) return candidate;
	if (isIPv6(candidate)) return candidate.toLowerCase();
	return undefined;
}

function lastForwardedValue(header: string | null): string | undefined {
	return header
		?.split(",")
		.map((value) => value.trim())
		.filter(Boolean)
		.at(-1);
}

/** Accepts bare addresses plus the `[v6]:port` and `v4:port` hop forms some proxies emit. */
function parseForwardedAddress(hop: string): string | undefined {
	const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(hop);
	if (bracketed) return normalizeIpAddress(bracketed[1] ?? "");
	const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(hop);
	return normalizeIpAddress(withPort?.[1] ?? hop);
}
