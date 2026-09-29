import { describe, expect, it } from "vitest";
import { EvmAdapter } from "#/integrations/chains/evm";
import { TronAdapter } from "#/integrations/chains/tron";
import { BinancePayAdapter } from "#/integrations/exchanges/binance";
import {
	ProviderResponseTooLargeError,
	readProviderJson,
} from "#/integrations/provider-response";

describe("bounded provider responses", () => {
	it("parses JSON bodies within the byte limit", async () => {
		await expect(
			readProviderJson(Response.json({ ok: true }), 1024),
		).resolves.toEqual({ ok: true });
	});
	it("rejects a declared content length above the limit before reading", async () => {
		const response = new Response("x".repeat(64), {
			headers: { "content-length": "9999" },
		});
		await expect(readProviderJson(response, 128)).rejects.toBeInstanceOf(
			ProviderResponseTooLargeError,
		);
	});
	it("rejects a streamed body that grows past the limit before parsing", async () => {
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls > 100) throw new Error("reader kept consuming the stream");
				controller.enqueue(new TextEncoder().encode("[".repeat(40)));
			},
		});
		await expect(
			readProviderJson(new Response(body), 100),
		).rejects.toBeInstanceOf(ProviderResponseTooLargeError);
		expect(pulls).toBeLessThanOrEqual(4);
	});
	it("surfaces empty bodies as JSON syntax errors like Response.json", async () => {
		await expect(readProviderJson(new Response(null))).rejects.toBeInstanceOf(
			SyntaxError,
		);
	});
	it("classifies oversized responses as retryable invalid responses", () => {
		const error = new ProviderResponseTooLargeError(1);
		expect(
			new TronAdapter({ apiUrl: "https://api.trongrid.io" }).classifyError(
				error,
			),
		).toBe("invalid_response");
		expect(
			new EvmAdapter({
				rpcUrl: "https://rpc.example",
				network: "ethereum",
				nativeAsset: "ETH",
			}).classifyError(error),
		).toBe("invalid_response");
		expect(
			new BinancePayAdapter({
				apiKey: "api-key",
				secretKey: "secret-key",
			}).classifyError(error),
		).toBe("invalid_response");
	});
});
