export class RequestBodyTooLargeError extends Error {
	constructor(readonly maximumBytes: number) {
		super("Request body exceeds the configured byte limit");
		this.name = "RequestBodyTooLargeError";
	}
}

export async function readLimitedRequestBytes(
	request: Request,
	maximumBytes: number,
) {
	const declaredLength = request.headers.get("content-length");
	if (
		declaredLength &&
		/^\d+$/.test(declaredLength) &&
		Number(declaredLength) > maximumBytes
	) {
		await request.body?.cancel().catch(() => undefined);
		throw new RequestBodyTooLargeError(maximumBytes);
	}

	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maximumBytes)
				throw new RequestBodyTooLargeError(maximumBytes);
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

export async function readLimitedRequestText(
	request: Request,
	maximumBytes: number,
) {
	return new TextDecoder().decode(
		await readLimitedRequestBytes(request, maximumBytes),
	);
}
