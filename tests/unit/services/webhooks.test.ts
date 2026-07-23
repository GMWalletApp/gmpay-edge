import { describe, expect, it, vi } from "vitest";
import {
	verifyEpaySignature,
	verifyGmpaySignature,
} from "#/features/api-keys/server/gmpay-signature";
import {
	deliverWebhook,
	parseRetryAfter,
	retryDelayMs,
} from "#/features/webhooks/server/delivery";

describe("webhooks", () => {
	it("caps exponential retry backoff", () => {
		expect(retryDelayMs(1)).toBe(15_000);
		expect(retryDelayMs(20)).toBe(3_600_000);
	});

	it("parses Retry-After seconds and HTTP dates within the retry cap", () => {
		const now = Date.UTC(2026, 6, 14, 0, 0, 0);
		expect(parseRetryAfter("12", now)).toBe(12_000);
		expect(parseRetryAfter("Tue, 14 Jul 2026 00:10:00 GMT", now)).toBe(600_000);
		expect(parseRetryAfter("999999", now)).toBe(3_600_000);
		expect(parseRetryAfter("invalid", now)).toBeUndefined();
		expect(parseRetryAfter("-1", now)).toBeUndefined();
	});

	it("delivers GMPay callbacks with the source-compatible HMAC-SHA256 body and ok acknowledgement", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("ok", { status: 200 }));
		const result = await deliverWebhook(
			{
				deliveryId: "delivery-gmpay",
				eventId: "event-gmpay",
				attempt: 1,
				url: "https://merchant.example/notify",
				secret: "merchant-secret",
				protocol: "gmpay",
				payload: { ignored: true },
				gmpay: {
					pid: "gmp_merchant",
					trade_id: "trade-1",
					order_id: "ORDER-1001",
					amount: "12.5",
					actual_amount: "1.75",
					receive_address: "TMerchantAddress",
					token: "USDT",
					block_transaction_id: "transaction-1",
					status: "paid",
				},
			},
			fetcher,
		);
		expect(result.success).toBe(true);
		const [, init] = fetcher.mock.calls[0] ?? [];
		const body = JSON.parse(String(init?.body)) as Record<
			string,
			string | number
		>;
		const signature = String(body.signature);
		expect(signature).toMatch(/^[0-9a-f]{64}$/);
		expect(verifyGmpaySignature(body, "merchant-secret", signature)).toBe(true);
		expect(body).toMatchObject({
			pid: "gmp_merchant",
			trade_id: "trade-1",
			order_id: "ORDER-1001",
			status: "paid",
		});
		expect(Object.keys(body).sort()).toEqual(
			[
				"pid",
				"trade_id",
				"order_id",
				"amount",
				"actual_amount",
				"receive_address",
				"token",
				"block_transaction_id",
				"status",
				"signature",
			].sort(),
		);
		expect(JSON.stringify(body)).not.toMatch(
			/externalOrderId|external_order_id/,
		);
		expect(result.requestSnapshot).toMatchObject({
			method: "POST",
			body: { signature: "[REDACTED]", token: "USDT" },
		});
		expect(JSON.stringify(result.requestSnapshot)).not.toContain(signature);
	});

	it("retries a GMPay callback unless the merchant returns plain text ok", async () => {
		const result = await deliverWebhook(
			{
				deliveryId: "delivery-gmpay",
				eventId: "event-gmpay",
				attempt: 1,
				url: "https://merchant.example/notify",
				secret: "merchant-secret",
				protocol: "gmpay",
				payload: {},
				gmpay: {
					pid: "gmp_merchant",
					trade_id: "trade-1",
					order_id: "ORDER-1001",
					amount: "12.5",
					actual_amount: "1.75",
					receive_address: "TMerchantAddress",
					token: "USDT",
					block_transaction_id: "transaction-1",
					status: "paid",
				},
			},
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response('{"accepted":true}', { status: 200 })),
		);
		expect(result).toMatchObject({
			success: false,
			errorCode: "invalid_acknowledgement",
		});
	});

	it("adapts EPay callbacks to signed GET query parameters", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("ok", { status: 200 }));
		const result = await deliverWebhook(
			{
				deliveryId: "delivery-epay",
				eventId: "event-epay",
				attempt: 1,
				url: "https://merchant.example/notify?merchant_context=1",
				secret: "merchant-secret",
				protocol: "epay",
				payload: {},
				epay: {
					pid: "100000000001",
					trade_no: "trade-1",
					out_trade_no: "EPAY-1001",
					type: "usdt.tron",
					name: "Invoice 1001",
					money: "12.50",
					trade_status: "TRADE_SUCCESS",
				},
			},
			fetcher,
		);
		expect(result.success).toBe(true);
		expect(result.requestSnapshot).toMatchObject({
			method: "GET",
			url: "https://merchant.example/notify?merchant_context=1",
			body: null,
			query: {
				sign: "[REDACTED]",
				sign_type: "MD5",
				trade_status: "TRADE_SUCCESS",
			},
		});
		const [target, init] = fetcher.mock.calls[0] ?? [];
		const url = new URL(String(target));
		expect(init?.method).toBe("GET");
		expect(init?.body).toBeUndefined();
		expect(url.searchParams.get("merchant_context")).toBe("1");
		expect(url.searchParams.get("trade_status")).toBe("TRADE_SUCCESS");
		expect(url.searchParams.get("sign_type")).toBe("MD5");
		const signed = Object.fromEntries(url.searchParams);
		expect(Object.keys(signed).sort()).toEqual(
			[
				"merchant_context",
				"pid",
				"trade_no",
				"out_trade_no",
				"type",
				"name",
				"money",
				"trade_status",
				"sign",
				"sign_type",
			].sort(),
		);
		expect(JSON.stringify(signed)).not.toMatch(
			/externalOrderId|external_order_id/,
		);
		expect(
			verifyEpaySignature(
				signed,
				"merchant-secret",
				String(signed.sign),
				new Set(["sign", "sign_type", "merchant_context"]),
			),
		).toBe(true);
	});

	it("accepts the traditional success acknowledgement for EPay callbacks", async () => {
		const result = await deliverWebhook(
			{
				deliveryId: "delivery-epay-success",
				eventId: "event-epay-success",
				attempt: 1,
				url: "https://merchant.example/notify",
				secret: "merchant-secret",
				protocol: "epay",
				payload: {},
				epay: {
					pid: "100000000001",
					trade_no: "trade-1",
					out_trade_no: "EPAY-1001",
					type: "usdt.tron",
					name: "Invoice 1001",
					money: "12.50",
					trade_status: "TRADE_SUCCESS",
					param: "merchant-context",
				},
			},
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response("success", { status: 200 })),
		);
		expect(result.success).toBe(true);
	});

	it("retains the redacted request snapshot for timeout and network failures", async () => {
		for (const error of [
			new DOMException("timed out", "TimeoutError"),
			new TypeError("network unavailable"),
		]) {
			const result = await deliverWebhook(
				{
					deliveryId: "delivery-failure",
					eventId: "event-failure",
					url: "https://merchant.example/notify",
					secret: "merchant-secret",
					payload: { status: "paid" },
					attempt: 1,
					protocol: "gmpay",
					gmpay: gmpayCallback,
				},
				vi.fn<typeof fetch>().mockRejectedValue(error),
			);
			expect(result.errorCode).toBe(
				error.name === "TimeoutError" ? "timeout" : "network_error",
			);
			expect(result.requestSnapshot).toMatchObject({
				method: "POST",
				body: { signature: "[REDACTED]" },
			});
		}
	});

	it("bounds response capture without buffering the full body", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new TextEncoder().encode("x".repeat(4_096)));
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ status: 500 },
		);
		const result = await deliverWebhook(
			{
				deliveryId: "d",
				eventId: "e",
				url: "https://example.com/hook",
				secret: "s",
				payload: {},
				attempt: 1,
				protocol: "gmpay",
				gmpay: gmpayCallback,
			},
			vi.fn<typeof fetch>().mockResolvedValue(response),
		);
		expect(result.responseExcerpt).toHaveLength(512);
		expect(cancelled).toBe(true);
	});
});

const gmpayCallback = {
	pid: "100000000001",
	trade_id: "trade-1",
	order_id: "ORDER-1",
	amount: "1.00",
	actual_amount: "1.00",
	receive_address: "TMerchantAddress",
	token: "USDT",
	block_transaction_id: "transaction-1",
	status: "paid" as const,
};
