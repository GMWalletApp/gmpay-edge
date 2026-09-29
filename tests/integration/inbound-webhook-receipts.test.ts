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

	it("stores only a validated external request identifier", async () => {
		const request = new Request(
			"https://edge.example/api/providers/okpay/notify",
			{
				method: "POST",
				headers: { "x-request-id": `injected ${"x".repeat(200)}` },
			},
		);
		await recordInboundWebhookReceipt(db, {
			endpointCode: "okpay.notify",
			request,
			startedAt: Date.now(),
			responseStatus: 200,
			signatureStatus: "valid",
		});
		const row = await db
			.prepare(
				"SELECT external_request_id FROM inbound_webhook_receipts WHERE endpoint_code = 'okpay.notify' AND response_status = 200",
			)
			.first<{ external_request_id: string }>();
		expect(row?.external_request_id).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
		expect(row?.external_request_id).not.toContain("injected");
	});

	it("samples unauthenticated rejections per client window and keeps authenticated and failed outcomes", async () => {
		const window = { allowed: true, count: 21, windowStart: 0 };
		const request = (id: string) =>
			new Request("https://edge.example/api/providers/alchemy/source", {
				method: "POST",
				headers: { "x-request-id": id },
			});
		await recordInboundWebhookReceipt(db, {
			endpointCode: "alchemy.address_activity",
			request: request("sampled-out"),
			startedAt: Date.now(),
			responseStatus: 401,
			signatureStatus: "invalid",
			rate: window,
		});
		await recordInboundWebhookReceipt(db, {
			endpointCode: "alchemy.address_activity",
			request: request("rate-limited"),
			startedAt: Date.now(),
			responseStatus: 429,
			signatureStatus: "unknown",
			rate: { ...window, allowed: false, count: 600 },
		});
		await recordInboundWebhookReceipt(db, {
			endpointCode: "alchemy.address_activity",
			request: request("sampled-in"),
			startedAt: Date.now(),
			responseStatus: 401,
			signatureStatus: "invalid",
			rate: { ...window, count: 20 },
		});
		await recordInboundWebhookReceipt(db, {
			endpointCode: "alchemy.address_activity",
			request: request("authenticated"),
			startedAt: Date.now(),
			responseStatus: 400,
			signatureStatus: "valid",
			rate: window,
		});
		await recordInboundWebhookReceipt(db, {
			endpointCode: "alchemy.address_activity",
			request: request("server-failure"),
			startedAt: Date.now(),
			responseStatus: 503,
			signatureStatus: "unknown",
			rate: window,
		});
		const rows = await db
			.prepare(
				"SELECT external_request_id FROM inbound_webhook_receipts WHERE endpoint_code = 'alchemy.address_activity' ORDER BY external_request_id",
			)
			.all<{ external_request_id: string }>();
		expect(rows.results.map((row) => row.external_request_id)).toEqual([
			"authenticated",
			"sampled-in",
			"server-failure",
		]);
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
