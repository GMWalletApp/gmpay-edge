import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const orderDomainEntries = [
	"src/features/orders/server/create.ts",
	"src/features/orders/server/query.ts",
] as const;
const explicitCapabilityEntries = [
	...orderDomainEntries,
	"src/features/orders/server/okpay-hosted.ts",
	"src/features/payment-settings/server/check-method-readiness.ts",
	"src/features/payment-settings/server/connection-health.ts",
	"src/features/payment-settings/server/method-adapter.ts",
	"src/features/checkout/server/payment-options.ts",
	"src/features/checkout/server/submit-transaction.ts",
	"src/features/payments/server/expiration.ts",
	"src/features/payments/server/late-payment.ts",
	"src/features/payments/server/order-status-event.ts",
	"src/features/payments/server/payment-events.ts",
	"src/features/payments/server/process.ts",
	"src/features/payments/server/record-late-payment.ts",
] as const;

describe("explicit Worker runtime dependencies", () => {
	it.each(orderDomainEntries)(
		"keeps %s independent from ambient Env",
		(file) => {
			const source = readFileSync(resolve(root, file), "utf8");

			expect(source).not.toMatch(/#\/server\/db\.server/);
			expect(source).not.toMatch(/\bget(?:Cloudflare)?Env\s*\(/);
		},
	);

	it.each(explicitCapabilityEntries)(
		"does not pass the complete Env through %s",
		(file) => {
			const source = readFileSync(resolve(root, file), "utf8");

			expect(source).not.toMatch(/\b_?env:\s*(?:Partial<)?Env\b/);
		},
	);

	it("keeps operational decisions authoritative in D1", () => {
		const source = readFileSync(
			resolve(root, "src/server/operational-settings.ts"),
			"utf8",
		);

		expect(source).not.toMatch(/KVNamespace|cacheGenerations|pendingLoads/);
		expect(source).toContain("SELECT key, value FROM system_settings");
	});
});
