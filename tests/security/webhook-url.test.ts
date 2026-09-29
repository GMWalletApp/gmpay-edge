import { describe, expect, it } from "vitest";
import {
	assertSafeResolvedWebhookUrl,
	isSafeWebhookUrl,
} from "#/lib/webhook-url";

describe("webhook URL validation", () => {
	it.each([
		"https://merchant.example/webhooks/gmpay",
		"https://merchant.example./webhooks/gmpay",
		"https://[2606:2800:220:1:248:1893:25c8:1946]/webhook",
		"https://[2002:5db8:d822::1]/webhook",
	])("accepts public HTTPS endpoint %s", (url) => {
		expect(isSafeWebhookUrl(url)).toBe(true);
	});

	it.each([
		"http://merchant.example/webhook",
		"https://localhost/webhook",
		"https://127.0.0.1/webhook",
		"https://10.0.0.4/webhook",
		"https://192.168.1.3/webhook",
		"https://203.0.113.10/webhook",
		"https://169.254.169.254/latest/meta-data",
		"https://[::1]/webhook",
		"https://[::ffff:127.0.0.1]/webhook",
		"https://[::ffff:10.0.0.4]/webhook",
		"https://[::ffff:100.64.0.1]/webhook",
		"https://[::ffff:169.254.169.254]/webhook",
		"https://[::ffff:172.16.0.1]/webhook",
		"https://[::ffff:192.168.1.3]/webhook",
		"https://[::ffff:224.0.0.1]/webhook",
		"https://user:password@merchant.example/webhook",
		"https://localhost./webhook",
		"https://LOCALHOST../webhook",
		"https://127.0.0.1./webhook",
		"https://metadata.google.internal./computeMetadata/v1/",
		"https://[64:ff9b::7f00:1]/webhook",
		"https://[64:ff9b::5db8:d822]/webhook",
		"https://[64:ff9b:1::a]/webhook",
		"https://[2002:7f00:1::]/webhook",
		"https://[2002:c0a8:103::1]/webhook",
		"https://[2001::1]/webhook",
		"https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/webhook",
	])("rejects unsafe endpoint %s", (url) => {
		expect(isSafeWebhookUrl(url)).toBe(false);
	});

	it("fails closed when DNS includes a private or reserved address", async () => {
		await expect(
			assertSafeResolvedWebhookUrl(
				"https://merchant.example/webhook",
				async () => ["93.184.216.34", "127.0.0.1"],
			),
		).resolves.toBe(false);
		await expect(
			assertSafeResolvedWebhookUrl(
				"https://merchant.example/webhook",
				async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
			),
		).resolves.toBe(true);
		await expect(
			assertSafeResolvedWebhookUrl(
				"https://merchant.example/webhook",
				async () => [],
			),
		).resolves.toBe(false);
	});
});
