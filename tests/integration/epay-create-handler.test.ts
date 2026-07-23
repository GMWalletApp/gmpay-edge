import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signEpayParameters } from "#/features/api-keys/server/gmpay-signature";
import {
	authenticateEpayInput,
	handleEpayCreateRequest,
	handleEpayQueryRequest,
} from "#/features/orders/server/epay-adapter";
import { encryptSecret } from "#/lib/secrets";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("EPay compatibility HTTP handler", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const pepper = "epay-create-handler-pepper";
	const secret = "merchant-secret";
	const pid = "100000000002";

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-epay-create-handler" },
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
					"INSERT INTO api_keys (id, name, pid, secret_encrypted, scopes, created_at, updated_at) VALUES ('key', 'EPay', ?, ?, '[\"orders:create\",\"orders:read\"]', ?, ?)",
				)
				.bind(pid, await encryptSecret(secret, pepper), now, now),
		]);
	});

	afterAll(async () => miniflare.dispose());

	it.each([
		"GET",
		"POST",
	] as const)("adapts a signed %s request into the shared selectable order service", async (method) => {
		const counters = createDatastoreCounters();
		const countedDb = instrumentD1(db, counters);
		const parameters = {
			pid,
			money: "20.00",
			out_trade_no: `EPAY-${method}`,
			notify_url: "https://merchant.example/epay-notify",
			return_url: "https://merchant.example/return",
			type: "alipay",
			param: `context-${method.toLowerCase()}`,
			clientip: "203.0.113.10",
			device: "mobile",
		};
		const signed = {
			...parameters,
			sign: signEpayParameters(parameters, secret),
			sign_type: "MD5",
		};
		const encoded = new URLSearchParams(signed).toString();
		const request = new Request(
			`https://pay.example/payments/epay/v1/order/create-transaction/submit.php${
				method === "GET" ? `?${encoded}` : ""
			}`,
			{
				method,
				headers: {
					"x-request-id": `epay-${method.toLowerCase()}`,
					...(method === "POST"
						? { "content-type": "application/x-www-form-urlencoded" }
						: {}),
				},
				body: method === "POST" ? encoded : undefined,
			},
		);
		const response = await handleEpayCreateRequest(request, {
			DB: countedDb,
		} as Env);
		expect(response.status).toBe(200);
		expect(counters).toMatchObject({
			d1Prepare: 6,
			d1StatementFirst: 2,
			d1StatementAll: 2,
			d1StatementRun: 2,
			d1Batch: 0,
		});
		expect(response.headers.get("x-request-id")).toBe(
			`epay-${method.toLowerCase()}`,
		);
		const body = await response.json<{
			data: { trade_id: string; payment_url: string };
		}>();
		expect(body.data.payment_url).toBe(
			`https://pay.example/checkout/${body.data.trade_id}`,
		);
		const orderId = body.data.trade_id;
		const order = await db
			.prepare(
				"SELECT api_protocol, payment_asset_id, return_url, metadata FROM orders WHERE id = ?",
			)
			.bind(orderId)
			.first<{
				api_protocol: string;
				payment_asset_id: string | null;
				metadata: string;
				return_url: string;
			}>();
		expect(order?.api_protocol).toBe("epay");
		expect(order?.payment_asset_id).toBeNull();
		expect(order?.return_url).toBe(
			`https://merchant.example/return?param=context-${method.toLowerCase()}`,
		);
		expect(JSON.parse(order?.metadata ?? "{}")).toEqual({
			integration: "epay",
			epayType: "alipay",
			epayParam: `context-${method.toLowerCase()}`,
		});
	});

	it("returns Pro-compatible mapi data and returns param from order queries", async () => {
		const parameters = {
			pid,
			money: "30.00",
			out_trade_no: "EPAY-PRO-COMPAT",
			notify_url: "https://merchant.example/epay-notify",
			return_url: "https://merchant.example/return?source=plugin",
			type: "alipay",
			param: "opaque merchant context",
			clientip: "203.0.113.20",
			device: "pc",
		};
		const signed = {
			...parameters,
			sign: signEpayParameters(parameters, secret),
			sign_type: "MD5",
		};
		const createResponse = await handleEpayCreateRequest(
			new Request(
				"https://pay.example/payments/epay/v1/order/create-transaction/mapi.php",
				{
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams(signed),
				},
			),
			{ DB: db } as Env,
			undefined,
			"mapi",
		);
		expect(createResponse.status).toBe(200);
		const created = await createResponse.json<{
			code: number;
			trade_no: string;
			payurl: string;
			qrcode: string;
			img: string;
			param: string;
		}>();
		expect(created).toMatchObject({
			code: 1,
			payurl: `https://pay.example/checkout/${created.trade_no}`,
			qrcode: `https://pay.example/checkout/${created.trade_no}`,
			img: `https://pay.example/checkout/${created.trade_no}`,
			param: "opaque merchant context",
		});

		const queryParameters = {
			act: "order",
			pid,
			out_trade_no: parameters.out_trade_no,
		};
		const query = {
			...queryParameters,
			sign: signEpayParameters(queryParameters, secret),
			sign_type: "MD5",
		};
		const queryResponse = await handleEpayQueryRequest(
			new Request(
				`https://pay.example/payments/epay/v1/order/create-transaction/api.php?${new URLSearchParams(query)}`,
			),
			{ DB: db } as Env,
		);
		expect(queryResponse.status).toBe(200);
		expect(await queryResponse.json()).toMatchObject({
			code: 1,
			trade_no: created.trade_no,
			out_trade_no: "EPAY-PRO-COMPAT",
			type: "alipay",
			money: "30",
			status: 0,
			trade_status: "WAIT_BUYER_PAY",
			param: "opaque merchant context",
		});
	});

	it("rejects unsupported payment types at the input boundary", async () => {
		const counters = createDatastoreCounters();
		const response = await handleEpayCreateRequest(
			new Request(
				"https://pay.example/payments/epay/v1/order/create-transaction/submit.php?pid=merchant&money=1.00&out_trade_no=invalid&type=unsupported&notify_url=https%3A%2F%2Fmerchant.example%2Fnotify&sign=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			),
			{ DB: instrumentD1(db, counters) } as Env,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			status_code: 10009,
			message: "invalid parameters",
		});
		expect(counters).toEqual(createDatastoreCounters());
	});

	it("rejects disabled credentials and accepts them again after re-enabling", async () => {
		const parameters = {
			pid,
			money: "20.00",
			out_trade_no: "EPAY-ENABLED-STATE",
			notify_url: "https://merchant.example/epay-notify",
			type: "alipay",
		};
		const input = {
			...parameters,
			sign: signEpayParameters(parameters, secret),
			sign_type: "MD5" as const,
		};
		await db.prepare("UPDATE api_keys SET enabled = 0 WHERE id = 'key'").run();
		await expect(authenticateEpayInput(db, input)).resolves.toBeNull();
		await db.prepare("UPDATE api_keys SET enabled = 1 WHERE id = 'key'").run();
		await expect(authenticateEpayInput(db, input)).resolves.toMatchObject({
			apiKeyId: "key",
			pid,
		});
	});

	it("does not expose unknown database or provider failures", async () => {
		const parameters = {
			pid,
			money: "20.00",
			out_trade_no: "EPAY-UNKNOWN-FAILURE",
			notify_url: "https://merchant.example/epay-notify",
			type: "alipay",
		};
		const signed = {
			...parameters,
			sign: signEpayParameters(parameters, secret),
			sign_type: "MD5",
		};
		const response = await handleEpayCreateRequest(
			new Request(
				`https://pay.example/payments/epay/v1/order/create-transaction/submit.php?${new URLSearchParams(signed)}`,
			),
			{ DB: db } as Env,
			async () => {
				throw new Error("D1_ERROR: token=unsafe provider.internal");
			},
		);
		expect(response.status).toBe(500);
		const body = await response.json<{
			status_code: number;
			message: string;
		}>();
		expect(body).toMatchObject({ status_code: 500, message: "system error" });
		expect(JSON.stringify(body)).not.toContain("unsafe");
	});
});
