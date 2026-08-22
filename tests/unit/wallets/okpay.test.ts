import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OkPayAdapter } from "#/integrations/wallets/okpay";
import createFixture from "../../fixtures/providers/okpay-create-payment.json";
import statusFixture from "../../fixtures/providers/okpay-payment-status.json";

describe("OKPay adapter", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("creates a signed hosted checkout", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		vi.spyOn(Math, "random").mockReturnValue(0);
		const fetchMock = vi.fn().mockResolvedValue(Response.json(createFixture));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			adapter().createHostedPayment({
				orderId: "order-1",
				amount: "3.5",
				assetCode: "USDT",
				callbackUrl: "https://edge.example/api/providers/okpay/notify",
				description: "Order 1",
				returnUrl: "https://merchant.example/return",
			}),
		).resolves.toEqual({
			providerOrderId: "ok-order",
			paymentUrl: "https://pay.example/order",
		});

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.okaypay.me/shop/payLink");
		const body = new URLSearchParams(String(init.body));
		expect(body.get("id")).toBe("12345");
		expect(body.get("callback_url")).toBe(
			"https://edge.example/api/providers/okpay/notify",
		);
		expect(body.get("unique_id")).toBe("order-1");
		expect(body.get("timestamp")).toMatch(/^\d{10}$/);
		expect(body.get("nonce")).toMatch(/^[0-9a-f-]{36}$/);
		expect(body.get("sign")).toMatch(/^[A-F0-9]{64}$/);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "okpay",
				operation: "create_hosted_payment",
				outcome: "success",
				requestCount: 1,
			}),
		);
	});

	it("checks and normalizes a completed hosted payment", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json(statusFixture)),
		);

		await expect(
			adapter().checkHostedPayment("ok-order"),
		).resolves.toMatchObject({
			hash: "ok-order",
			assetCode: "USDT",
			amountUnits: 350_000_000n,
			to: "12345",
			success: true,
		});
	});

	it("keeps a pending hosted payment pending when amount fields are absent", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json(
					signedResponse({
						order_id: "pending-order",
						status: 0,
						unique_id: "merchant-pending-order",
					}),
				),
			),
		);

		await expect(
			adapter().checkHostedPayment("pending-order"),
		).resolves.toBeNull();
	});

	it("rejects an unsafe hosted checkout URL", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json(
					signedResponse({
						order_id: "provider-order",
						pay_url: "javascript:alert(1)",
						status: 0,
					}),
				),
			),
		);
		await expect(
			adapter().createHostedPayment({
				orderId: "order-unsafe",
				amount: "1.00",
				assetCode: "USDT",
				description: "Unsafe URL",
			}),
		).rejects.toThrow("safe pay URL");
	});

	it("ignores a completed provider response with a non-positive amount", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json(
					signedResponse({
						amount: "-1",
						coin: "USDT",
						order_id: "negative-order",
						status: 1,
						unique_id: "order-negative",
					}),
				),
			),
		);

		expect(await adapter().checkHostedPayment("negative-order")).toBeNull();
	});

	it("rejects numeric callback amounts instead of risking precision loss", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json(
					signedResponse({
						amount: 1.25,
						coin: "USDT",
						order_id: "numeric-order",
						status: 1,
						unique_id: "order-numeric",
					}),
				),
			),
		);
		await expect(
			adapter().checkHostedPayment("numeric-order"),
		).rejects.toThrow();
	});

	it("verifies signed callbacks and extracts nested notification data", async () => {
		const instance = adapter();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json(
					signedResponse({
						order_id: "unused",
						pay_url: "https://pay",
						status: 0,
					}),
				),
			),
		);
		await instance.createHostedPayment({
			orderId: "order-1",
			amount: "3.5",
			assetCode: "USDT",
			description: "Order 1",
		});
		const callback = {
			status: "success",
			code: 200,
			data: {
				amount: "3.5",
				coin: "USDT",
				order_id: "ok-order",
				pay_user_id: 123456789,
				status: 1,
				type: "deposit",
				unique_id: "order-1",
			},
			id: 12345,
			sign: "DF84D29D014B24D5C00935389203D3FC17C120A309577CB206D9D4F9BAAB3048",
		};
		expect(instance.verifyCallback(callback)).toBe(true);
		expect(instance.parseCallback(callback)).toEqual({
			amount: "3.5",
			assetCode: "USDT",
			providerOrderId: "ok-order",
			orderId: "order-1",
		});
	});

	it("matches the official nested and zero-value signing vectors", () => {
		const instance = new OkPayAdapter({
			shopId: "10001",
			apiKey: "TESTtoken123456789abcdefghijABCD",
		});
		expect(
			instance.verifyCallback({
				status: "success",
				code: 200,
				data: {
					amount: "100.5",
					coin: "USDT",
					order_id: "abc123def456",
					pay_user_id: 123456789,
					status: 1,
					type: "deposit",
					unique_id: "ORDER-20260628-001",
				},
				id: 10001,
				sign: "64B09C8847849FA6921D8FFBDF8E406D4A8EA623E53970712350F61783403F7D",
			}),
		).toBe(true);
		expect(
			new OkPayAdapter({
				shopId: "7",
				apiKey: "TESTtoken123456789abcdefghijABCD",
			}).verifyCallback({
				a: "0",
				b: 0,
				c: "",
				d: null,
				e: false,
				f: "hello",
				id: 7,
				nest: { x: "1", y: "2" },
				sign: "8BC0AF979075038025DDD51B6F4A2E6CF3FF9B5B5371EB2268D303F89883E92A",
			}),
		).toBe(true);
	});

	it("redacts unexpected provider failures from health details", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("provider-secret-and-url")),
		);

		const health = await adapter().healthCheck();

		expect(health).toMatchObject({
			healthy: false,
			detail: "OKPay health check failed: network",
		});
		expect(health.detail).not.toContain("provider-secret-and-url");
	});

	it("classifies a non-JSON provider outage from its HTTP status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
		);

		await expect(adapter().healthCheck()).resolves.toMatchObject({
			healthy: false,
			detail: "OKPay health check failed: network",
		});
	});

	it("rejects a forged successful provider response", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json({ ...createFixture, sign: "0".repeat(64) }),
				),
		);

		await expect(
			adapter().createHostedPayment({
				orderId: "forged-order",
				amount: "1",
				assetCode: "USDT",
				description: "Forged response",
			}),
		).rejects.toThrow();
	});
});

function adapter() {
	return new OkPayAdapter({
		shopId: "12345",
		apiKey: "secret",
		apiUrl: "https://api.okaypay.me/shop",
		assetDecimals: { USDT: 8 },
	});
}

function signedResponse(data: Record<string, unknown>) {
	const response = { status: "success", code: 200, data, id: 12345 };
	const fields = Object.entries({
		code: response.code,
		...Object.fromEntries(
			Object.entries(data).map(([key, value]) => [`data.${key}`, value]),
		),
		id: response.id,
		status: response.status,
	});
	const base = fields
		.filter(
			([, value]) => value !== null && value !== undefined && value !== "",
		)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, value]) => `${key}=${String(value)}`)
		.join("&");
	return {
		...response,
		sign: bytesToHex(
			hmac(sha256, utf8ToBytes("secret"), utf8ToBytes(base)),
		).toUpperCase(),
	};
}
