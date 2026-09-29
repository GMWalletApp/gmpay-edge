import { describe, expect, it } from "vitest";
import { AptosAdapter } from "#/integrations/chains/aptos";
import { EvmAdapter } from "#/integrations/chains/evm";
import { SolanaAdapter } from "#/integrations/chains/solana";
import { TonAdapter } from "#/integrations/chains/ton";
import { TronAdapter } from "#/integrations/chains/tron";

describe.skip("live chain RPC smoke", () => {
	it("checks TronGrid and an optional known transaction", async () => {
		const adapter = new TronAdapter({
			apiUrl: process.env.TRON_SMOKE_RPC_URL ?? "https://api.trongrid.io",
			apiKey: process.env.TRON_SMOKE_API_KEY,
		});
		await expect(adapter.healthCheck()).resolves.toMatchObject({
			healthy: true,
		});
		await expectKnownTransaction(adapter, process.env.TRON_SMOKE_TX_HASH);
	});

	it.each([
		["ethereum", "ETH", "https://ethereum-rpc.publicnode.com"],
		["base", "ETH", "https://base-rpc.publicnode.com"],
		["bsc", "BNB", "https://bsc-rpc.publicnode.com"],
		["polygon", "MATIC", "https://polygon-bor-rpc.publicnode.com"],
	] as const)(
		"checks the %s EVM RPC",
		async (network, nativeAsset, fallback) => {
			const prefix = network.toUpperCase();
			const adapter = new EvmAdapter({
				rpcUrl: process.env[`${prefix}_SMOKE_RPC_URL`] ?? fallback,
				network,
				nativeAsset,
			});
			await expect(adapter.healthCheck()).resolves.toMatchObject({
				healthy: true,
			});
			await expectKnownTransaction(
				adapter,
				process.env[`${prefix}_SMOKE_TX_HASH`],
			);
		},
	);

	it("checks TON Center and an optional known transaction", async () => {
		const adapter = new TonAdapter({
			apiUrl: process.env.TON_SMOKE_RPC_URL ?? "https://toncenter.com/api/v3",
			apiKey: process.env.TON_SMOKE_API_KEY,
			nativeAsset: "GRAM",
		});
		await expect(adapter.healthCheck()).resolves.toMatchObject({
			healthy: true,
		});
		await expectKnownTransaction(adapter, process.env.TON_SMOKE_TX_HASH);
	});

	it("checks the Aptos indexer and an optional known version", async () => {
		const adapter = new AptosAdapter({
			indexerUrl:
				process.env.APTOS_SMOKE_RPC_URL ??
				"https://api.mainnet.aptoslabs.com/v1/graphql",
			apiKey: process.env.APTOS_SMOKE_API_KEY,
		});
		await expect(adapter.healthCheck()).resolves.toMatchObject({
			healthy: true,
		});
		await expectKnownTransaction(adapter, process.env.APTOS_SMOKE_TX_VERSION);
	});

	it("checks Solana RPC and an optional known signature", async () => {
		const adapter = new SolanaAdapter({
			rpcUrl:
				process.env.SOLANA_SMOKE_RPC_URL ??
				"https://api.mainnet-beta.solana.com",
			apiKey: process.env.SOLANA_SMOKE_API_KEY,
		});
		await expect(adapter.healthCheck()).resolves.toMatchObject({
			healthy: true,
		});
		await expectKnownTransaction(adapter, process.env.SOLANA_SMOKE_SIGNATURE);
	});
});

async function expectKnownTransaction(
	adapter: { getTransaction(hash: string): Promise<unknown> },
	hash?: string,
) {
	if (!hash) return;
	await expect(adapter.getTransaction(hash)).resolves.not.toBeNull();
}
