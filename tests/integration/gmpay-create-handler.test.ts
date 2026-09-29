import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	AUTH_FAILURE_LIMIT,
	signGmpayParameters,
} from "#/features/api-keys/server/gmpay-signature";
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

	it("rejects an oversized request body before authentication", async () => {
		const response = await handleGmpayCreateRequest(
			new Request(
				"https://pay.example/payments/gmpay/v1/order/create-transaction",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"content-length": String(64 * 1024 + 1),
					},
					body: "{}",
				},
			),
			{ DB: db } as Env,
		);

		expect(response.status).toBe(413);
	});

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
				status: number;
				status_detail: string;
				token: string;
				network: string;
			};
		};
		expect(body).toMatchObject({
			status_code: 200,
			request_id: `request-${encoding}`,
			data: {
				status: 4,
				status_detail: "pending",
				token: "",
				network: "",
			},
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

	it("accepts and authenticates a JSON number amount", async () => {
		const parameters = {
			pid,
			order_id: "ORDER-NUMERIC-AMOUNT",
			currency: "USD",
			amount: 12.5,
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

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { amount: "12.5", status: 4, status_detail: "pending" },
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
				status: 4,
				status_detail: "pending",
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
		// Credential lookup, runtime config, and one failure-bucket claim.
		expect(rejectedCounters).toMatchObject({
			d1Prepare: 3,
			d1StatementFirst: 2,
			d1StatementAll: 1,
			d1StatementRun: 0,
			d1Batch: 0,
		});
	});

	it.each([
		{
			name: "a non-HTTPS notify_url",
			overrides: { notify_url: "http://merchant.example/notify" },
			code: 10009,
			message: "invalid parameters",
		},
		{
			name: "a token without its network",
			overrides: { token: "USDT" },
			code: 10009,
			message: "invalid parameters",
		},
		{
			name: "a non-HTTPS redirect_url",
			overrides: { redirect_url: "http://merchant.example/return" },
			code: 10009,
			message: "invalid parameters",
		},
		{
			name: "an unknown currency code",
			overrides: { currency: "ABC" },
			code: 10009,
			message: "Unsupported order currency",
		},
		{
			name: "a non-alphabetic currency code",
			overrides: { currency: "AB1" },
			code: 10009,
			message: "Unsupported order currency",
		},
		{
			name: "an amount with more than 18 integer digits",
			overrides: { amount: "1234567890123456789.00" },
			code: 10004,
			message: "Invalid order amount",
		},
	])("rejects $name with a documented 400-class code", async ({
		name,
		overrides,
		code,
		message,
	}) => {
		const parameters = {
			pid,
			order_id: `ORDER-INVALID-${name.replaceAll(/\W+/g, "-")}`,
			currency: "USD",
			amount: "10.00",
			notify_url: "https://merchant.example/notify",
			...overrides,
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
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			status_code: code,
			message,
			data: null,
		});
		await expect(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM orders WHERE external_order_id = ?",
				)
				.bind(parameters.order_id)
				.first(),
		).resolves.toEqual({ count: 0 });
	});

	it("bounds repeated authentication failures per PID and logs a structured line", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const probePid = "100000000099";
		const probe = (attempt: number) =>
			handleGmpayCreateRequest(
				new Request(
					"https://pay.example/payments/gmpay/v1/order/create-transaction",
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-request-id": `probe-${attempt}`,
						},
						body: JSON.stringify({
							pid: probePid,
							order_id: `ORDER-PROBE-${attempt}`,
							currency: "USD",
							amount: "10.00",
							notify_url: "https://merchant.example/notify",
							signature: "0".repeat(64),
						}),
					},
				),
				{ DB: db } as Env,
			);
		try {
			for (let attempt = 1; attempt <= AUTH_FAILURE_LIMIT; attempt++)
				expect((await probe(attempt)).status).toBe(401);
			const refused = await probe(AUTH_FAILURE_LIMIT + 1);
			expect(refused.status).toBe(429);
			expect(await refused.json()).toMatchObject({ status_code: 429 });
			expect(warn).toHaveBeenCalledWith("merchant_auth_failed", {
				pid: probePid,
				requestId: "probe-1",
			});
			expect(warn).toHaveBeenCalledTimes(AUTH_FAILURE_LIMIT);
			await expect(
				db
					.prepare(
						"SELECT SUM(count) AS failures FROM rate_limit_counters WHERE bucket_key = ?",
					)
					.bind(`api-key-auth-fail:${probePid}`)
					.first(),
			).resolves.toEqual({ failures: AUTH_FAILURE_LIMIT });
			await expect(
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM rate_limit_counters WHERE bucket_key LIKE 'api-key:%' AND bucket_key <> 'api-key:key'",
					)
					.first(),
			).resolves.toEqual({ count: 0 });
		} finally {
			warn.mockRestore();
		}
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
