import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("GMPay and EPay OpenAPI contract", () => {
	it("declares exactly the implemented merchant entry routes", async () => {
		const document = await openApi();
		expect(Object.keys(document.paths).sort()).toEqual(
			(await implementedMerchantRoutes()).sort(),
		);
	});

	it("documents JSON/form GMPay input and GET/form EPay compatibility", async () => {
		const document = await openApi();
		const gmpay = document.paths["/payments/gmpay/v1/order/create-transaction"]
			?.post as Operation;
		expect(Object.keys(gmpay.requestBody.content).sort()).toEqual([
			"application/json",
			"application/x-www-form-urlencoded",
		]);
		expect(gmpay.callbacks?.orderNotification).toBeTruthy();
		const query = document.paths["/payments/gmpay/v1/order/query"]
			?.get as Operation;
		expect(query.parameters?.map((parameter) => parameter.name).sort()).toEqual(
			["order_id", "pid", "signature", "trade_id"],
		);

		const epay =
			document.paths["/payments/epay/v1/order/create-transaction/submit.php"];
		expect(epay).toHaveProperty("get");
		expect(epay).toHaveProperty("post");
		expect(Object.keys((epay?.get as Operation).responses)).toEqual([
			"200",
			"400",
			"401",
			"429",
			"500",
			"502",
			"503",
		]);
		expect((epay?.get as Operation).responses["200"]).toMatchObject({
			content: {
				"application/json": {
					schema: { $ref: "#/components/schemas/GmpayCreateResponse" },
				},
			},
		});
		expect((epay?.post as Operation).responses["200"]).toMatchObject({
			content: {
				"application/json": {
					schema: { $ref: "#/components/schemas/GmpayCreateResponse" },
				},
			},
		});
		expect((epay?.post as Operation).requestBody.content).toHaveProperty(
			"application/x-www-form-urlencoded",
		);

		const mapi =
			document.paths["/payments/epay/v1/order/create-transaction/mapi.php"];
		expect(mapi).toHaveProperty("get");
		expect(mapi).toHaveProperty("post");
		expect((mapi?.get as Operation).responses["200"]).toMatchObject({
			content: {
				"application/json": {
					schema: { $ref: "#/components/schemas/EpayCreateResponse" },
				},
			},
		});
		const epayQuery = document.paths[
			"/payments/epay/v1/order/create-transaction/api.php"
		]?.get as Operation;
		expect(
			epayQuery.parameters?.map((parameter) => parameter.name).sort(),
		).toEqual(["act", "out_trade_no", "pid", "sign", "sign_type", "trade_no"]);
	});

	it("uses readable GMPay Edge states and never declares a default chain", async () => {
		const document = await openApi();
		const schemas = document.components.schemas;
		const orderStatus = requiredSchema(schemas, "OrderStatus");
		const createRequest = requiredSchema(schemas, "GmpayCreateRequest");
		const createData = requiredSchema(schemas, "GmpayCreateData");
		const notification = requiredSchema(schemas, "GmpayNotification");
		expect(orderStatus.enum).toEqual([
			"pending",
			"confirming",
			"partially_paid",
			"paid",
			"overpaid",
			"expired",
			"cancelled",
			"failed",
			"refunded",
		]);
		expect(createRequest.properties.token?.default).toBeUndefined();
		expect(createRequest.properties.network?.default).toBeUndefined();
		expect(createRequest.properties.amount).toMatchObject({
			type: "string",
		});
		expect(createData.properties.amount).toMatchObject({
			type: "string",
		});
		expect(createData.required).toContain("network");
		expect(createData.properties.trade_id).toMatchObject({
			pattern: "^[0-9]{20}$",
		});
		expect(notification.properties.amount).toMatchObject({
			type: "string",
		});
		expect(createRequest.properties.signature).toMatchObject({
			pattern: "^[0-9a-f]{64}$",
		});
		expect(notification.properties.signature).toMatchObject({
			pattern: "^[0-9a-f]{64}$",
		});
		expect(JSON.stringify(document)).toContain("HMAC-SHA256");
		expect(
			requiredSchema(schemas, "EpayCreateRequest").properties.sign,
		).toMatchObject({ pattern: "^[0-9a-f]{32}$" });
		expect(JSON.stringify(document)).not.toContain("X-GMPay-Nonce");
	});

	it("resolves every local OpenAPI reference", async () => {
		const document = await openApi();
		for (const reference of collectReferences(document)) {
			expect(
				resolveReference(document, reference),
				reference,
			).not.toBeUndefined();
		}
	});
});

function requiredSchema(
	schemas: Awaited<ReturnType<typeof openApi>>["components"]["schemas"],
	name: string,
) {
	const schema = schemas[name];
	if (!schema) throw new Error(`Missing OpenAPI schema: ${name}`);
	return schema;
}

function collectReferences(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(collectReferences);
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, child]) =>
		key === "$ref"
			? typeof child === "string" && child.startsWith("#/")
				? [child]
				: []
			: collectReferences(child),
	);
}

function resolveReference(document: unknown, reference: string): unknown {
	return reference
		.slice(2)
		.split("/")
		.reduce<unknown>(
			(value, segment) =>
				value && typeof value === "object"
					? (value as Record<string, unknown>)[segment]
					: undefined,
			document,
		);
}

async function implementedMerchantRoutes() {
	const root = resolve(
		new URL("../../src/routes/payments", import.meta.url).pathname,
	);
	const files = await routeFiles(root);
	return files.map((file) => {
		const route = relative(root, file)
			.split(sep)
			.join("/")
			.replace(/\.tsx?$/, "")
			.replaceAll("[.]", ".")
			.replace(/\/index$/, "");
		return `/payments/${route}`;
	});
}

async function routeFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = resolve(directory, entry.name);
			return entry.isDirectory()
				? routeFiles(path)
				: Promise.resolve(/\.tsx?$/.test(entry.name) ? [path] : []);
		}),
	);
	return nested.flat();
}

type Operation = {
	requestBody: { content: Record<string, unknown> };
	responses: Record<string, unknown>;
	parameters?: Array<{ name: string }>;
	callbacks?: Record<string, unknown>;
};

async function openApi() {
	const source = await readFile(
		new URL("../../public/openapi.yaml", import.meta.url),
		"utf8",
	);
	return parse(source) as {
		paths: Record<string, Record<string, unknown>>;
		components: {
			schemas: Record<
				string,
				{
					enum: string[];
					required?: string[];
					properties: Record<
						string,
						{ default?: unknown; type?: string; pattern?: string }
					>;
				}
			>;
		};
	};
}
