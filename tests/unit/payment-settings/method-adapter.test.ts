import { describe, expect, it } from "vitest";
import {
	createPaymentMethodAdapters,
	paymentAdapterCandidateLimit,
} from "#/features/payment-settings/server/method-adapter";

type ConnectionRow = {
	connection_id: string;
	adapter: string;
	transport: "http" | "websocket";
	endpoint: string;
	api_key: null;
	credential_config_encrypted: null;
	asset_code: string;
	rail_code: string;
	asset_kind: "native" | "external";
	contract_address: null;
	decimals: number;
	native_symbol: string;
};

describe("payment method adapter routing", () => {
	it.each([
		["tron", "tron", "TRX", "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj"],
		["ethereum", "evm", "ETH", "0x1111111111111111111111111111111111111111"],
		["base", "evm", "ETH", "0x1111111111111111111111111111111111111111"],
		["bsc", "evm", "BNB", "0x1111111111111111111111111111111111111111"],
		["polygon", "evm", "POL", "0x1111111111111111111111111111111111111111"],
		["ton", "ton", "GRAM", `UQ${"a".repeat(46)}`],
		["aptos", "aptos", "APT", "0x1"],
		["solana", "solana", "SOL", "11111111111111111111111111111111"],
	] as const)("constructs and validates the %s chain adapter from a payment-method query", async (railCode, adapterId, assetCode, address) => {
		const [candidate] = await createPaymentMethodAdapters(
			db([chainRow(railCode, adapterId, assetCode)]),
			`method-${railCode}`,
		);
		if (!candidate) throw new Error(`Missing ${railCode} adapter`);
		expect(candidate.adapter).toMatchObject({
			id: adapterId,
			network: railCode,
		});
		const target = await candidate.adapter.createPaymentTarget({
			address,
			expiresAt: new Date(1),
		});
		expect(candidate.adapter.validateAddress(target.address)).toBe(true);
	});

	it.each([
		["binance", "12345", { apiKey: "read-key", secretKey: "secret" }],
		[
			"okx",
			"23456",
			{ apiKey: "read-key", secretKey: "secret", passphrase: "pass" },
		],
		["okpay", "34567", { apiKey: "api-key" }],
	] as const)("constructs the %s receiving adapter only with its receiving credentials", async (railCode, target, credentials) => {
		const [candidate] = await createPaymentMethodAdapters(
			db([providerRow(railCode)]),
			`method-${railCode}`,
			target,
			credentials,
		);
		if (!candidate) throw new Error(`Missing ${railCode} adapter`);
		expect(candidate.adapter).toMatchObject({
			id: railCode,
			network: railCode,
		});
		await expect(
			candidate.adapter.createPaymentTarget({
				address: target,
				expiresAt: new Date(1),
			}),
		).resolves.toMatchObject({ address: target });
	});

	it("pairs an enabled EVM WSS connection with the authoritative HTTP candidate", async () => {
		const http = chainRow("ethereum", "evm", "ETH");
		const websocket = {
			...http,
			connection_id: "connection-ethereum-wss",
			transport: "websocket" as const,
			endpoint: "wss://ethereum.example",
		};
		const candidates = await createPaymentMethodAdapters(
			db([http, websocket]),
			"method-ethereum",
		);
		const primary = candidates[0];
		expect(
			primary && "subscription" in primary && primary.subscription,
		).toMatchObject({
			connectionId: "connection-ethereum-wss",
			adapter: { id: "evm", network: "ethereum" },
		});
	});

	it("rejects private chain endpoints and pins credentialed providers to official origins", async () => {
		const privateChain = chainRow("ethereum", "evm", "ETH");
		privateChain.endpoint = "https://127.0.0.1/rpc";
		await expect(
			createPaymentMethodAdapters(db([privateChain]), "method-ethereum"),
		).resolves.toEqual([]);

		const provider = providerRow("binance");
		provider.endpoint = "https://attacker.example/collect";
		const [candidate] = await createPaymentMethodAdapters(
			db([provider]),
			"method-binance",
			"12345",
			{
				apiKey: "read-key",
				secretKey: "secret",
				apiUrl: "https://attacker.example/also-collect",
			},
		);
		expect(
			(candidate?.adapter as unknown as { config: { apiUrl: string } }).config
				.apiUrl,
		).toBe("https://api-gcp.binance.com");
	});

	it("bounds ordered fallback candidates per payment method", async () => {
		const rows = Array.from(
			{ length: paymentAdapterCandidateLimit + 3 },
			(_, index) => ({
				...chainRow("ethereum", "evm", "ETH"),
				connection_id: `connection-${index}`,
			}),
		);
		const candidates = await createPaymentMethodAdapters(
			db(rows),
			"method-ethereum",
		);
		expect(candidates).toHaveLength(paymentAdapterCandidateLimit);
		expect(candidates.map(({ connectionId }) => connectionId)).toEqual(
			rows
				.slice(0, paymentAdapterCandidateLimit)
				.map(({ connection_id }) => connection_id),
		);
	});
});

function chainRow(
	railCode: string,
	adapter: string,
	assetCode: string,
): ConnectionRow {
	return {
		connection_id: `connection-${railCode}-http`,
		adapter,
		transport: "http",
		endpoint: `https://${railCode}.example`,
		api_key: null,
		credential_config_encrypted: null,
		asset_code: assetCode,
		rail_code: railCode,
		asset_kind: "native",
		contract_address: null,
		decimals: 18,
		native_symbol: assetCode,
	};
}

function providerRow(railCode: string): ConnectionRow {
	return {
		...chainRow(railCode, railCode, "USDT"),
		asset_kind: "external",
		decimals: 8,
	};
}

function db(rows: ConnectionRow[]) {
	return {
		prepare() {
			return {
				bind(...values: unknown[]) {
					const limit = Number(values.at(-1));
					return {
						all: async () => ({
							results: Number.isSafeInteger(limit)
								? rows.slice(0, limit)
								: rows,
						}),
					};
				},
			};
		},
	} as unknown as D1Database;
}
