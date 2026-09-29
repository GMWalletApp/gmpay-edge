interface ApiErrorBody {
	error: {
		code: string;
		message: string;
		requestId: string;
		details?: unknown;
	};
}

const requestIds = new WeakMap<Request, string>();
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

/** The validated inbound correlation id, or null when none is acceptable. */
export function headerRequestId(headers: Headers): string | null {
	return (
		[headers.get("cf-ray"), headers.get("x-request-id")].find((candidate) =>
			candidate ? requestIdPattern.test(candidate) : false,
		) ?? null
	);
}

export function requestId(request: Request): string {
	const cached = requestIds.get(request);
	if (cached) return cached;
	const id = headerRequestId(request.headers) ?? crypto.randomUUID();
	requestIds.set(request, id);
	return id;
}
export function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	headers.set("cache-control", "no-store");
	headers.set("pragma", "no-cache");
	headers.set("x-content-type-options", "nosniff");
	headers.set("x-frame-options", "DENY");
	headers.set("referrer-policy", "strict-origin-when-cross-origin");
	return new Response(JSON.stringify(data), { ...init, headers });
}
export function apiError(
	request: Request,
	status: number,
	code: string,
	message: string,
	details?: unknown,
): Response {
	const body: ApiErrorBody = {
		error: {
			code,
			message,
			requestId: requestId(request),
			...(details === undefined ? {} : { details }),
		},
	};
	return json(body, {
		status,
		headers: { "x-request-id": body.error.requestId },
	});
}
export function withRequestId(request: Request, response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("x-request-id", requestId(request));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
