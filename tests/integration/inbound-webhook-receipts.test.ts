import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadInboundWebhookReceipt } from "#/features/webhooks/server/inbound-admin";
import {
	inboundWebhookCatalogEndpoints,
	inboundWebhookEndpoints,
	recordInboundWebhookReceipt,
} from "#/features/webhooks/server/inbound-receipts";
import { applyMigrations } from "./migrations";

describe("inbound webhook receipts", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-inbound-webhooks-test" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
	});

	afterAll(async () => miniflare.dispose());

	it("keeps every supported inbound endpoint visible", () => {
		expect(
			inboundWebhookCatalogEndpoints.map((endpoint) => endpoint.code),
		).toEqual(["okpay.notify", "alchemy.address_activity", "telegram.update"]);
		expect(inboundWebhookEndpoints.map((endpoint) => endpoint.code)).toContain(
			"alchemy.address_activity",
		);
	});

	it("records metadata for every attempt and preserves the external request ID", async () => {
		const request = new Request(
			"https://edge.example/api/providers/okpay/notify?secret=not-stored",
			{
				method: "POST",
				headers: { "x-request-id": "request-a" },
			},
		);
		await recordInboundWebhookReceipt(db, {
			endpointCode: "okpay.notify",
			request,
			startedAt: Date.now() - 7,
			responseStatus: 401,
			signatureStatus: "invalid",
			errorCode: "invalid_signature",
		});
		await recordInboundWebhookReceipt(db, {
			endpointCode: "okpay.notify",
			request,
			startedAt: Date.now(),
			responseStatus: 401,
			signatureStatus: "invalid",
		});
		const rows = await db
			.prepare(
				`SELECT id, request_id, external_request_id, request_path, signature_status, processing_status,
				 response_status, error_code FROM inbound_webhook_receipts`,
			)
			.all<Record<string, unknown>>();
		expect(rows.results).toHaveLength(2);
		expect(rows.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: expect.any(String),
					request_id: expect.any(String),
					external_request_id: "request-a",
					request_path: "/api/providers/okpay/notify",
					signature_status: "invalid",
					processing_status: "rejected",
					response_status: 401,
					error_code: "invalid_signature",
				}),
			]),
		);
		expect(new Set(rows.results.map((row) => row.request_id)).size).toBe(2);
		expect(JSON.stringify(rows.results)).not.toContain("not-stored");
		const receipt = await loadInboundWebhookReceipt(
			db,
			String(rows.results[0]?.id),
		);
		expect(receipt).toMatchObject({
			endpointCode: "okpay.notify",
			requestId: rows.results[0]?.request_id,
			externalRequestId: "request-a",
			method: "POST",
			requestPath: "/api/providers/okpay/notify",
			signatureStatus: "invalid",
			processingStatus: "rejected",
			responseStatus: 401,
			errorCode: "invalid_signature",
		});
	});

	it("returns a stable error for a missing receipt", async () => {
		await expect(
			loadInboundWebhookReceipt(db, "00000000-0000-4000-8000-000000000000"),
		).rejects.toMatchObject({
			code: "webhook_inbound_receipt_not_found",
			status: 404,
		});
	});
});
