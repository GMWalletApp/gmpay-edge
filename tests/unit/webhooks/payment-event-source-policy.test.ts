import { describe, expect, it } from "vitest";
import { paymentEventSourceUpdatePolicy } from "#/features/webhooks/server/payment-event-source-policy";

const ready = {
	externalSourceId: "wh-current",
	enabled: true,
	healthStatus: "healthy",
	reconcileRequiredAt: null,
};

describe("payment event source activation policy", () => {
	it("allows activation only from an enabled, healthy, reconciled source", () => {
		expect(
			paymentEventSourceUpdatePolicy(ready, {
				externalSourceId: ready.externalSourceId,
				mode: "active",
				enabled: true,
				authTokenRotated: false,
			}),
		).toEqual({ externalSourceChanged: false, requiresReconcile: false });
		for (const current of [
			{ ...ready, healthStatus: "degraded" },
			{ ...ready, reconcileRequiredAt: 1 },
		])
			expect(() =>
				paymentEventSourceUpdatePolicy(current, {
					externalSourceId: current.externalSourceId,
					mode: "active",
					enabled: true,
					authTokenRotated: false,
				}),
			).toThrow(
				expect.objectContaining({
					code: "payment_event_source_not_ready",
					status: 409,
				}),
			);
	});

	it("requires another reconciliation after enabling or rotating the Auth Token", () => {
		for (const next of [
			{
				externalSourceId: ready.externalSourceId,
				mode: "active" as const,
				enabled: true,
				authTokenRotated: true,
			},
			{
				externalSourceId: ready.externalSourceId,
				mode: "active" as const,
				enabled: true,
				authTokenRotated: false,
			},
		]) {
			const current = next.authTokenRotated
				? ready
				: { ...ready, enabled: false };
			expect(() => paymentEventSourceUpdatePolicy(current, next)).toThrow(
				expect.objectContaining({ code: "payment_event_source_not_ready" }),
			);
		}
	});

	it("allows replacing a Webhook ID only after the old source is disabled and reconciled", () => {
		const disabled = { ...ready, enabled: false };
		expect(
			paymentEventSourceUpdatePolicy(disabled, {
				externalSourceId: "wh-replacement",
				mode: "shadow",
				enabled: false,
				authTokenRotated: false,
			}),
		).toEqual({ externalSourceChanged: true, requiresReconcile: true });
		expect(() =>
			paymentEventSourceUpdatePolicy(ready, {
				externalSourceId: "wh-replacement",
				mode: "shadow",
				enabled: true,
				authTokenRotated: false,
			}),
		).toThrow(
			expect.objectContaining({ code: "payment_event_source_not_ready" }),
		);
	});

	it("allows disabling an active source while scheduling reconciliation", () => {
		expect(
			paymentEventSourceUpdatePolicy(ready, {
				externalSourceId: ready.externalSourceId,
				mode: "active",
				enabled: false,
				authTokenRotated: false,
			}),
		).toEqual({ externalSourceChanged: false, requiresReconcile: true });
	});
});
