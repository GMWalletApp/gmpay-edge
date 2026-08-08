import { describe, expect, it } from "vitest";
import {
	RequestBodyTooLargeError,
	readLimitedRequestBytes,
} from "#/server/request-body";

describe("limited request bodies", () => {
	it("reads a body at the configured limit", async () => {
		const body = await readLimitedRequestBytes(
			new Request("https://edge.example/input", {
				method: "POST",
				body: "1234",
			}),
			4,
		);
		expect(new TextDecoder().decode(body)).toBe("1234");
	});

	it("rejects a declared oversized body without reading its stream", async () => {
		const request = new Request("https://edge.example/input", {
			method: "POST",
			headers: { "content-length": "5" },
			body: new ReadableStream({
				pull(controller) {
					controller.enqueue(new TextEncoder().encode("12345"));
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		await expect(readLimitedRequestBytes(request, 4)).rejects.toBeInstanceOf(
			RequestBodyTooLargeError,
		);
	});

	it("rejects a chunked body as soon as actual bytes exceed the limit", async () => {
		const request = new Request("https://edge.example/input", {
			method: "POST",
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("123"));
					controller.enqueue(new TextEncoder().encode("45"));
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		await expect(readLimitedRequestBytes(request, 4)).rejects.toBeInstanceOf(
			RequestBodyTooLargeError,
		);
	});
});
