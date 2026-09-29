import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getPublicPaymentMethodsFn } from "#/features/status/server/assets";
import {
	getPublicPaymentMethodsSnapshot,
	publicPaymentMethodsTtlMs,
} from "#/features/status/server/assets-query";
import { getStatusFn } from "#/features/status/server/functions";
import { adaptCloudflareEnv } from "#/server/runtime/cloudflare";
import { runWithRuntimeEnv } from "#/server/runtime/context";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

// The public server functions run as plain handlers here: the Start RPC wrapper
// and request storage belong to the framework, while the handler bodies own the
// runtime-binding access under test.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({ handler: (handler: unknown) => handler }),
}));
vi.mock("@tanstack/react-start/server", () => ({
	getRequest: () => new Request("https://pay.example/status"),
}));

describe("public status server functions", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-status-public-functions" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('okpay', 'OKPay', 'wallet', 'okpay', ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT OR IGNORE INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('asset-okpay', 'okpay', 'USDT', 'USDT', 'external', 8, ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT OR IGNORE INTO payment_ingresses (id, rail_code, name, type, endpoint, enabled, health_status, created_at, updated_at) VALUES ('connection-okpay', 'okpay', 'OKPay', 'provider', 'https://api.okaypay.me/shop', 1, 'unknown', ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"UPDATE payment_assets SET default_confirmations = 1, created_at = ?, updated_at = ? WHERE id = 'asset-okpay'",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT OR IGNORE INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('receiving-okpay', 'OKPay shop', 'okpay', 'provider', 'shop-1', 'shop-1', 1, ?, ?)",
				)
				.bind(now, now),
			db
				.prepare(
					"INSERT OR IGNORE INTO receiving_method_assets (id, receiving_method_id, payment_asset_id, created_at, updated_at) VALUES ('link-okpay', 'receiving-okpay', 'asset-okpay', ?, ?)",
				)
				.bind(now, now),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it("shares one catalog query round across an anonymous burst", async () => {
		const counters = createDatastoreCounters();
		const instrumented = instrumentD1(db, counters);
		const burst = await Promise.all(
			Array.from({ length: 50 }, () =>
				getPublicPaymentMethodsSnapshot(instrumented, 1),
			),
		);
		const first = burst[0];

		expect(first).toEqual([
			{
				type: "wallet",
				code: "okpay",
				name: "OKPay",
				assets: ["USDT"],
				status: "available",
			},
		]);
		expect(burst).toEqual(Array.from({ length: 50 }, () => first));
		expect(counters).toMatchObject({ d1Prepare: 2, d1StatementAll: 2 });

		await getPublicPaymentMethodsSnapshot(
			instrumented,
			publicPaymentMethodsTtlMs,
		);
		expect(counters.d1Prepare).toBe(2);
		await getPublicPaymentMethodsSnapshot(
			instrumented,
			publicPaymentMethodsTtlMs + 1,
		);
		expect(counters.d1Prepare).toBe(4);
	});

	it("evicts a failed catalog snapshot instead of caching the error", async () => {
		let attempts = 0;
		const failing = {
			prepare: () => ({
				all: async () => {
					attempts += 1;
					throw new Error("D1 secret query text");
				},
			}),
		} as unknown as D1Database;

		await expect(getPublicPaymentMethodsSnapshot(failing, 1)).rejects.toThrow(
			"D1 secret query text",
		);
		await expect(getPublicPaymentMethodsSnapshot(failing, 1)).rejects.toThrow(
			"D1 secret query text",
		);
		expect(attempts).toBe(2);
	});

	it("serves the public catalog and health report from the runtime env", async () => {
		const counters = createDatastoreCounters();
		const env = adaptCloudflareEnv({ DB: instrumentD1(db, counters) });

		const methods = await runWithRuntimeEnv(env, () =>
			getPublicPaymentMethodsFn(),
		);
		expect(methods).toEqual([
			expect.objectContaining({
				type: "wallet",
				code: "okpay",
				assets: ["USDT"],
				status: "available",
			}),
		]);

		const report = await runWithRuntimeEnv(env, () => getStatusFn());
		expect(report).toMatchObject({
			service: "gmpay-edge",
			version: "v1",
			status: "degraded",
		});
		expect(report.components).toContainEqual(
			expect.objectContaining({
				key: "receiving_methods",
				status: "operational",
				count: 1,
			}),
		);
		expect(report.components).toContainEqual(
			expect.objectContaining({ key: "edge_cache", detail: "binding_missing" }),
		);
		expect(counters).toMatchObject({
			d1Prepare: 3,
			d1StatementAll: 2,
			d1StatementFirst: 1,
		});
	});

	it("fails closed without a database binding", async () => {
		const env = adaptCloudflareEnv({});

		await expect(
			runWithRuntimeEnv(env, () => getPublicPaymentMethodsFn()),
		).rejects.toThrow("D1 binding DB is unavailable");
		const report = await runWithRuntimeEnv(env, () => getStatusFn());
		expect(report.status).toBe("degraded");
		expect(report.components).toContainEqual(
			expect.objectContaining({ key: "database", detail: "binding_missing" }),
		);
	});

	it("rejects calls outside a server request", async () => {
		await expect(getStatusFn()).rejects.toThrow(/outside a server request/);
		await expect(getPublicPaymentMethodsFn()).rejects.toThrow(
			/outside a server request/,
		);
	});
});
