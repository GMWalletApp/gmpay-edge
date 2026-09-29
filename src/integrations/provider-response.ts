export const maxProviderResponseBytes = 8 * 1024 * 1024;

export class ProviderResponseTooLargeError extends Error {
	constructor(readonly maxBytes: number) {
		super("Provider response exceeds the configured byte limit");
		this.name = "ProviderResponseTooLargeError";
	}
}

/**
 * Parses a provider JSON body without buffering more than `maxBytes`. Provider
 * payloads are untrusted input, so the cap applies before JSON.parse can
 * allocate for an oversized or hostile response.
 */
export async function readProviderJson(
	response: Response,
	maxBytes = maxProviderResponseBytes,
): Promise<unknown> {
	const declaredLength = response.headers.get("content-length");
	if (
		declaredLength &&
		/^\d+$/.test(declaredLength) &&
		Number(declaredLength) > maxBytes
	) {
		await response.body?.cancel().catch(() => undefined);
		throw new ProviderResponseTooLargeError(maxBytes);
	}
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	if (response.body) {
		const reader = response.body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				totalBytes += value.byteLength;
				if (totalBytes > maxBytes)
					throw new ProviderResponseTooLargeError(maxBytes);
				chunks.push(value);
			}
		} catch (error) {
			await reader.cancel().catch(() => undefined);
			throw error;
		}
	}
	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(body));
}
