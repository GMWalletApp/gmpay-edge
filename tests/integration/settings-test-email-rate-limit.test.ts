import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimTestEmailRateLimit } from "#/features/settings/server/test-email-rate-limit";
import { applyMigrations } from "./migrations";

describe("test email rate limit", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-test-email-rate-limit" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
	});

	afterAll(async () => miniflare.dispose());

	it("allows five test emails per actor per hour and isolates actors", async () => {
		const now = 1_800_000_000_000;
		const results = await Promise.all(
			Array.from({ length: 6 }, () =>
				claimTestEmailRateLimit(db, "operator-a", now),
			),
		);
		expect(results.filter((result) => result.allowed)).toHaveLength(5);
		expect(results.filter((result) => !result.allowed)).toHaveLength(1);
		await expect(
			claimTestEmailRateLimit(db, "operator-b", now),
		).resolves.toMatchObject({ allowed: true });
		await expect(
			claimTestEmailRateLimit(db, "operator-a", now + 3_600_000),
		).resolves.toMatchObject({ allowed: true });
	});
});
