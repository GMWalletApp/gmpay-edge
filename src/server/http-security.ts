export function applySecurityHeaders(request: Request, response: Response) {
	const headers = new Headers(response.headers);
	const routePath = new URL(request.url).pathname;
	const scriptSources = ["'self'", "'unsafe-inline'"];
	if (routePath === "/docs") scriptSources.push("https://cdn.jsdmirror.com");
	headers.set("x-content-type-options", "nosniff");
	headers.set("x-frame-options", "DENY");
	headers.set("referrer-policy", "strict-origin-when-cross-origin");
	headers.set(
		"permissions-policy",
		"camera=(), microphone=(), geolocation=(), payment=()",
	);
	headers.set("cross-origin-resource-policy", "same-origin");
	headers.set("cross-origin-opener-policy", "same-origin");
	headers.set(
		"content-security-policy",
		[
			"default-src 'self'",
			"base-uri 'self'",
			"object-src 'none'",
			"frame-ancestors 'none'",
			"form-action 'self'",
			"img-src 'self' data: blob: https:",
			"font-src 'self' data:",
			"style-src 'self' 'unsafe-inline'",
			`script-src ${scriptSources.join(" ")}`,
			"connect-src 'self' https: wss:",
			"worker-src 'self' blob:",
		].join("; "),
	);
	if (new URL(request.url).protocol === "https:")
		headers.set(
			"strict-transport-security",
			"max-age=31536000; includeSubDomains",
		);
	if (response.status >= 400) {
		headers.set("cache-control", "no-store");
		headers.set("pragma", "no-cache");
	} else if (!headers.has("cache-control")) {
		const cacheControl = responseCacheControl(request);
		headers.set("cache-control", cacheControl);
		if (cacheControl.includes("no-store")) headers.set("pragma", "no-cache");
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function responseCacheControl(request: Request) {
	if (request.method !== "GET" && request.method !== "HEAD")
		return "private, no-store";

	const pathname = new URL(request.url).pathname;
	if (/^\/assets\/.+/.test(pathname))
		return "public, max-age=31536000, immutable";
	if (/(?:^|;\s*)PARAGLIDE_LOCALE=/.test(request.headers.get("cookie") ?? ""))
		return "private, no-store";

	const routePath = pathname;
	if (
		/^\/(?:admin|checkout|sign-in|two-factor|install|api|payments)(?:\/|$)/.test(
			routePath,
		)
	)
		return "private, no-store";
	if (routePath === "/status") return "no-store";
	if (["", "/", "/assets", "/docs"].includes(routePath))
		return "public, max-age=0, must-revalidate";
	if (
		/^\/(?:apple-touch-icon\.png|favicon\.(?:ico|png)|openapi\.yaml|pwa-(?:192x192|512x512|maskable-192x192|maskable-512x512)\.png|robots\.txt|site\.webmanifest)$/.test(
			routePath,
		)
	)
		return "public, max-age=0, must-revalidate";
	return "no-store";
}
