import { describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "#/features/access/server/access-cache";

const requireAdmin = vi.hoisted(() => vi.fn());

vi.mock("#/features/access/server/require-admin", () => ({ requireAdmin }));
vi.mock("#/server/db.server", () => ({
	getEnv: () => {
		throw new Error("storage must not be touched before authorization");
	},
}));

import { Route } from "#/routes/api/admin/payment-reviews/$reviewId/evidence";

type EvidenceHandler = (input: {
	request: Request;
	params: { reviewId: string };
}) => Promise<Response>;

const handler = (
	Route.options.server as unknown as { handlers: { GET: EvidenceHandler } }
).handlers.GET;
const reviewId = "00000000-0000-4000-8000-000000000001";
const request = () =>
	new Request(
		`https://pay.example/api/admin/payment-reviews/${reviewId}/evidence`,
		{ headers: { "x-request-id": "evidence-access" } },
	);

// Each case installs its own rejection; Vitest 4's mockReset on a rejected
// implementation surfaces as an unhandled rejection, so no shared reset here.
describe("evidence download authorization boundary", () => {
	it.each([
		[401, "unauthorized"],
		[403, "forbidden"],
	] as const)("maps an access denial to a %s JSON API error", async (status, code) => {
		requireAdmin.mockRejectedValue(new AccessDeniedError(status));
		const response = await handler({
			request: request(),
			params: { reviewId },
		});
		expect(response.status).toBe(status);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toMatchObject({
			error: { code, requestId: "evidence-access" },
		});
	});

	it("fails closed with a redacted 500 when authorization itself fails", async () => {
		requireAdmin.mockRejectedValue(new Error("D1_ERROR: SELECT token"));
		const response = await handler({
			request: request(),
			params: { reviewId },
		});
		expect(response.status).toBe(500);
		const body = await response.text();
		expect(body).toContain("internal_error");
		expect(body).not.toContain("D1_ERROR");
	});
});
