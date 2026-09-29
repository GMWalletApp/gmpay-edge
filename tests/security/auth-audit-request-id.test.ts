import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuditStatement } from "#/server/audit";
import { headerRequestId } from "#/server/http";
import { applyMigrations } from "../integration/migrations";

const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("audit request identifiers", () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-audit-request-id" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		await database
			.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled, two_factor_enabled, created_at, updated_at) VALUES ('actor', 'Actor', 'actor@example.com', 1, 1, 0, 1, 1)",
			)
			.run();
	});

	afterAll(async () => miniflare.dispose());

	it("accepts only validated correlation ids from inbound headers", () => {
		expect(
			headerRequestId(new Headers({ "x-request-id": "req_01.ok:1-2" })),
		).toBe("req_01.ok:1-2");
		expect(
			headerRequestId(
				new Headers({ "cf-ray": "8a1b2c3d4e5f-SJC", "x-request-id": "client" }),
			),
		).toBe("8a1b2c3d4e5f-SJC");
		expect(
			headerRequestId(new Headers({ "x-request-id": "a".repeat(129) })),
		).toBeNull();
		expect(
			headerRequestId(new Headers({ "x-request-id": "bad id {json} /path" })),
		).toBeNull();
		expect(headerRequestId(new Headers())).toBeNull();
	});

	it("stores a generated id instead of an unvalidated header value", async () => {
		const injected = `${"x".repeat(200)} {"forged":true}`;
		await createAuditStatement(
			database,
			new Request("https://pay.example/admin", {
				headers: { "x-request-id": injected },
			}),
			"actor",
			{ action: "test.unvalidated", targetType: "user" },
		).run();
		const stored = await database
			.prepare(
				"SELECT request_id FROM audit_logs WHERE action = 'test.unvalidated'",
			)
			.first<{ request_id: string }>();
		expect(stored?.request_id).toMatch(uuidPattern);
		expect(stored?.request_id).not.toContain("forged");
	});

	it("keeps a validated header id verbatim", async () => {
		await createAuditStatement(
			database,
			new Request("https://pay.example/admin", {
				headers: { "x-request-id": "admin-request-42" },
			}),
			"actor",
			{ action: "test.validated", targetType: "user" },
		).run();
		await expect(
			database
				.prepare(
					"SELECT request_id FROM audit_logs WHERE action = 'test.validated'",
				)
				.first(),
		).resolves.toEqual({ request_id: "admin-request-42" });
	});
});
