export function withForwardedProtocol(request: Request) {
	const protocol = request.headers
		.get("x-forwarded-proto")
		?.split(",", 1)[0]
		?.trim()
		.toLowerCase();
	if (protocol !== "https") return request;

	const url = new URL(request.url);
	if (url.protocol === "https:") return request;
	url.protocol = "https:";
	return new Request(url, request);
}
