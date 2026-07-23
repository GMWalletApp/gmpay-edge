import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signGmpayParameters } from "#/features/api-keys/server/gmpay-signature";
import { OrderServiceError } from "#/features/orders/server/create";
import {
	handleGmpayCreateRequest,
	handleGmpayQueryRequest,
} from "#/features/orders/server/gmpay-api";
import { getOrder } from "#/features/orders/server/query";
import { encryptSecret } from "#/lib/secrets";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("GMPay create transaction HTTP handler", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const pepper = "gmpay-create-handler-pepper";
	const secret = "merchant-secret";
	const pid = "100000000001";

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-gmpay-create-handler" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.api_key_pepper', ?, 1, ?, ?)",
				)
				.bind(JSON.stringify(pepper), now, now),
			db
				.prepare(
					"INSERT INTO api_keys (id, name, pid, secret_encrypted, scopes, created_at, updated_at) VALUES ('key', 'GMPay', ?, ?, '[\"orders:create\",\"orders:read\"]', ?, ?)",
				)
				.bind(pid, await encryptSecret(secret, pepper), now, now),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it.each([
		"json",
		"form",
	] as const)("authenticates and creates a selectable order from %s", async (encoding) => {
		const parameters = {
			pid,
			order_id: `ORDER-${encoding.toUpperCase()}`,
			currency: "usd",
			amount: "12.50",
			notify_url: "https://merchant.example/notify",
		};
		const signed = {
			...parameters,
			signature: signGmpayParameters(parameters, secret),
		};
		const request = new Request(
			"https://pay.example/payments/gmpay/v1/order/create-transaction",
			{
				method: "POST",
				headers: {
					"content-type":
						encoding === "json"
							? "application/json"
							: "application/x-www-form-urlencoded",
					"x-request-id": `request-${encoding}`,
				},
				body:
					encoding === "json"
						? JSON.stringify(signed)
						: new URLSearchParams(signed).toString(),
			},
		);
		const response = await handleGmpayCreateRequest(request, { DB: db } as Env);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-request-id")).toBe(`request-${encoding}`);
		const body = (await response.json()) as {
			status_code: number;
			request_id: string;
			data: {
				trade_id: string;
				status: string;
				token: string;
				network: string;
			};
		};
		expect(body).toMatchObject({
			status_code: 200,
			request_id: `request-${encoding}`,
			data: { status: "pending", token: "", network: "" },
		});
		const order = await db
			.prepare(
				"SELECT api_key_id, api_protocol, payment_asset_id FROM orders WHERE id = ?",
			)
			.bind(body.data.trade_id)
			.first<{
				api_key_id: string;
				api_protocol: string;
				payment_asset_id: string | null;
			}>();
		expect(order).toEqual({
			api_key_id: "key",
			api_protocol: "gmpay",
			payment_asset_id: null,
		});
	});

	it("queries an order by trade ID with the same signed GMPay credential", async () => {
		const parameters = {
			pid,
			order_id: "ORDER-QUERY",
			currency: "USD",
			amount: "8.00",
			notify_url: "https://merchant.example/notify",
		};
		const createParameters = {
			...parameters,
			signature: signGmpayParameters(parameters, secret),
		};
		const created = await handleGmpayCreateRequest(
			new Request(
				"https://pay.example/payments/gmpay/v1/order/create-transaction",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(createParameters),
				},
			),
			{ DB: db } as Env,
		);
		const createdBody = (await created.json()) as {
			data: { trade_id: string; order_id: string };
		};
		const queryParameters = {
			pid,
			trade_id: createdBody.data.trade_id,
		};
		const queryUrl = new URL(
			"https://pay.example/payments/gmpay/v1/order/query",
		);
		for (const [key, value] of Object.entries({
			...queryParameters,
			signature: signGmpayParameters(queryParameters, secret),
		}))
			queryUrl.searchParams.set(key, value);
		const queried = await handleGmpayQueryRequest(
			new Request(queryUrl, { headers: { "x-request-id": "query-request" } }),
			{ DB: db } as Env,
		);
		expect(queried.status).toBe(200);
		expect(queried.headers.get("x-request-id")).toBe("query-request");
		expect(await queried.json()).toMatchObject({
			status_code: 200,
			request_id: "query-request",
			data: {
				trade_id: createdBody.data.trade_id,
				order_id: "ORDER-QUERY",
				status: "pending",
			},
		});
		expect(
			await getOrder(
				db,
				{ id: createdBody.data.trade_id, apiKeyId: "different-key" },
				"https://pay.example",
			),
		).toBeNull();
		const orderNumberParameters = { pid, order_id: "ORDER-QUERY" };
		const orderNumberUrl = new URL(
			"https://pay.example/payments/gmpay/v1/order/query",
		);
		for (const [key, value] of Object.entries({
			...orderNumberParameters,
			signature: signGmpayParameters(orderNumberParameters, secret),
		}))
			orderNumberUrl.searchParams.set(key, value);
		const queriedByOrderNumber = await handleGmpayQueryRequest(
			new Request(orderNumberUrl),
			{ DB: db } as Env,
		);
		expect(queriedByOrderNumber.status).toBe(200);
	});

	it("keeps successful create/query and rejected signatures within explicit D1 budgets", async () => {
		const createParameters = {
			pid,
			order_id: "ORDER-COUNTED",
			currency: "USD",
			amount: "9.00",
			notify_url: "https://merchant.example/notify",
		};
		const createCounters = createDatastoreCounters();
		const createDb = instrumentD1(db, createCounters);
		const created = await handleGmpayCreateRequest(
			new Request(
				"https://pay.example/payments/gmpay/v1/order/create-transaction",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						...createParameters,
						signature: signGmpayParameters(createParameters, secret),
					}),
				},
			),
			{ DB: createDb } as Env,
		);
		expect(created.status).toBe(200);
		expect(createCounters).toMatchObject({
			d1Prepare: 6,
			d1StatementFirst: 2,
			d1StatementAll: 2,
			d1StatementRun: 2,
			d1Batch: 0,
		});

		const createdBody = await created.json<{ data: { trade_id: string } }>();
		const queryParameters = { pid, trade_id: createdBody.data.trade_id };
		const queryUrl = new URL(
			"https://pay.example/payments/gmpay/v1/order/query",
		);
		for (const [key, value] of Object.entries({
			...queryParameters,
			signature: signGmpayParameters(queryParameters, secret),
		}))
			queryUrl.searchParams.set(key, value);
		const queryCounters = createDatastoreCounters();
		const queryDb = instrumentD1(db, queryCounters);
		const queried = await handleGmpayQueryRequest(new Request(queryUrl), {
			DB: queryDb,
		} as Env);
		expect(queried.status).toBe(200);
		expect(queryCounters).toMatchObject({
			d1Prepare: 5,
			d1StatementFirst: 3,
			d1StatementAll: 1,
			d1StatementRun: 1,
			d1Batch: 0,
		});

		const rejectedCounters = createDatastoreCounters();
		const rejectedDb = instrumentD1(db, rejectedCounters);
		const rejected = await handleGmpayCreateRequest(
			new Request(
				"https://pay.example/payments/gmpay/v1/order/create-transaction",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						...createParameters,
						order_id: "ORDER-COUNTED-REJECTED",
						signature: "0".repeat(64),
					}),
				},
			),
			{ DB: rejectedDb } as Env,
		);
		expect(rejected.status).toBe(401);
		expect(rejectedCounters).toMatchObject({
			d1Prepare: 2,
			d1StatementFirst: 1,
			d1StatementAll: 1,
			d1StatementRun: 0,
			d1Batch: 0,
		});
	});

	it("rejects a body changed after signing", async () => {
		const parameters = {
			pid,
			order_id: "ORDER-TAMPERED",
			currency: "USD",
			amount: "10.00",
			notify_url: "https://merchant.example/notify",
		};
		const response = await handleGmpayCreateRequest(
			new Request(
				"https://pay.example/payments/gmpay/v1/order/create-transaction",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						...parameters,
						amount: "10.01",
						signature: signGmpayParameters(parameters, secret),
					}),
				},
			),
			{ DB: db } as Env,
		);
		expect(response.status).toBe(401);
	});

	it("fails closed when persisted credential scopes are malformed", async () => {
		await db
			.prepare("UPDATE api_keys SET scopes = ? WHERE id = 'key'")
			.bind('{"0":"orders:create"}')
			.run();
		try {
			const parameters = {
				pid,
				order_id: "ORDER-MALFORMED-SCOPES",
				currency: "USD",
				amount: "10.00",
				notify_url: "https://merchant.example/notify",
			};
			const response = await handleGmpayCreateRequest(
				new Request(
					"https://pay.example/payments/gmpay/v1/order/create-transaction",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							...parameters,
							signature: signGmpayParameters(parameters, secret),
						}),
					},
				),
				{ DB: db } as Env,
			);
			expect(response.status).toBe(401);
		} finally {
			await db
				.prepare("UPDATE api_keys SET scopes = ? WHERE id = 'key'")
				.bind('["orders:create","orders:read"]')
				.run();
		}
	});

	it("rejects a repeated merchant order through the authoritative D1 constraint", async () => {
		const parameters = {
			pid,
			order_id: "ORDER-DUPLICATE",
			currency: "USD",
			amount: "10.00",
			notify_url: "https://merchant.example/notify",
		};
		const body = JSON.stringify({
			...parameters,
			signature: signGmpayParameters(parameters, secret),
		});
		const create = () =>
			handleGmpayCreateRequest(
				new Request(
					"https://pay.example/payments/gmpay/v1/order/create-transaction",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body,
					},
				),
				{ DB: db } as Env,
			);
		expect((await create()).status).toBe(200);
		const duplicate = await create();
		expect(duplicate.status).toBe(400);
		expect(await duplicate.json()).toMatchObject({
			status_code: 10002,
			message: "External order ID already exists",
		});
	});

	it("does not expose internal domain details in public failures", async () => {
		const parameters = {
			pid,
			order_id: "ORDER-REDACTED",
			currency: "USD",
			amount: "10.00",
			notify_url: "https://merchant.example/notify",
		};
		const response = await handleGmpayCreateRequest(
			new Request(
				"https://pay.example/payments/gmpay/v1/order/create-transaction",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						...parameters,
						signature: signGmpayParameters(parameters, secret),
					}),
				},
			),
			{ DB: db } as Env,
			async () => {
				throw new OrderServiceError(
					"receiving_method_not_ready",
					"RPC secret abc123 is invalid at internal.example",
					422,
				);
			},
		);
		expect(response.status).toBe(400);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-request-id")).toBeTruthy();
		expect(await response.json()).toMatchObject({
			message: "No receiving method is currently available",
		});
	});

	it("redacts unknown create and query failures behind a safe request ID", async () => {
		const createParameters = {
			pid,
			order_id: "ORDER-UNKNOWN-FAILURE",
			currency: "USD",
			amount: "10.00",
			notify_url: "https://merchant.example/notify",
		};
		const createResponse = await handleGmpayCreateRequest(
			new Request(
				"https://pay.example/payments/gmpay/v1/order/create-transaction",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-request-id": "../../unsafe-request-id",
					},
					body: JSON.stringify({
						...createParameters,
						signature: signGmpayParameters(createParameters, secret),
					}),
				},
			),
			{ DB: db } as Env,
			async () => {
				throw new Error("D1_ERROR: SELECT secret_encrypted FROM api_keys");
			},
		);
		expect(createResponse.status).toBe(500);
		const createBody = await createResponse.json<{
			status_code: number;
			message: string;
			request_id: string;
		}>();
		expect(createBody).toMatchObject({
			status_code: 500,
			message: "system error",
		});
		expect(createBody.request_id).not.toBe("../../unsafe-request-id");
		expect(createResponse.headers.get("x-request-id")).toBe(
			createBody.request_id,
		);
		expect(JSON.stringify(createBody)).not.toContain("secret_encrypted");

		const queryParameters = { pid, trade_id: "unknown-order" };
		const queryUrl = new URL(
			"https://pay.example/payments/gmpay/v1/order/query",
		);
		for (const [key, value] of Object.entries({
			...queryParameters,
			signature: signGmpayParameters(queryParameters, secret),
		}))
			queryUrl.searchParams.set(key, value);
		const queryResponse = await handleGmpayQueryRequest(
			new Request(queryUrl),
			{ DB: db } as Env,
			async () => {
				throw new Error("provider token=unsafe at rpc.internal");
			},
		);
		expect(queryResponse.status).toBe(500);
		expect(await queryResponse.json()).toMatchObject({
			status_code: 500,
			message: "system error",
		});
	});
});
