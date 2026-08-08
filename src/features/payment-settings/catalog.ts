import {
	defaultCryptoExchangeRates,
	defaultFiatExchangeRates,
} from "#/features/payment-settings/default-exchange-rates";

export const initialChainRails = [
	{
		code: "tron",
		name: "TRON",
		family: "tron",
		nativeSymbol: "TRX",
	},
	{
		code: "ethereum",
		name: "Ethereum",
		family: "evm",
		nativeSymbol: "ETH",
	},
	{
		code: "base",
		name: "Base",
		family: "evm",
		nativeSymbol: "ETH",
	},
	{
		code: "bsc",
		name: "BNB Smart Chain",
		family: "evm",
		nativeSymbol: "BNB",
	},
	{
		code: "polygon",
		name: "Polygon",
		family: "evm",
		nativeSymbol: "MATIC",
	},
	{
		code: "ton",
		name: "TON",
		family: "ton",
		nativeSymbol: "GRAM",
	},
	{
		code: "aptos",
		name: "Aptos",
		family: "aptos",
		nativeSymbol: "APT",
	},
	{
		code: "solana",
		name: "Solana",
		family: "solana",
		nativeSymbol: "SOL",
	},
] as const;

export const initialExchangeRails = [
	{
		code: "binance",
		name: "Binance",
		apiUrl: "https://api-gcp.binance.com",
	},
	{
		code: "okx",
		name: "OKX",
		apiUrl: "https://www.okx.com",
	},
] as const;

export const initialWalletRails = [
	{
		code: "okpay",
		name: "OKPay",
		apiUrl: "https://api.okaypay.me/shop",
	},
] as const;

const officialProviderApiUrls: Readonly<Record<string, string>> = {
	...Object.fromEntries(
		initialExchangeRails.map((provider) => [provider.code, provider.apiUrl]),
	),
	...Object.fromEntries(
		initialWalletRails.map((provider) => [provider.code, provider.apiUrl]),
	),
};

export function officialProviderApiUrl(railCode: string) {
	return officialProviderApiUrls[railCode];
}

export const initialPaymentRails = [
	...initialChainRails.map((network) => ({
		code: network.code,
		name: network.name,
		kind: "chain" as const,
		adapter: network.family,
		metadata: {
			family: network.family,
			nativeSymbol: network.nativeSymbol,
		},
	})),
	...initialExchangeRails.map((exchange) => ({
		code: exchange.code,
		name: exchange.name,
		kind: "exchange" as const,
		adapter: exchange.code,
		metadata: {},
	})),
	...initialWalletRails.map((wallet) => ({
		code: wallet.code,
		name: wallet.name,
		kind: "wallet" as const,
		adapter: wallet.code,
		metadata: {},
	})),
] as const;

export const initialChainConnections = [
	{
		id: "rpc-tron-default",
		network: "tron",
		name: "TronGrid",
		url: "https://api.trongrid.io",
		enabled: true,
	},
	{
		id: "rpc-ethereum-default",
		network: "ethereum",
		name: "Ethereum Public RPC",
		url: "https://ethereum-rpc.publicnode.com",
		enabled: true,
	},
	{
		id: "rpc-base-default",
		network: "base",
		name: "Base Public RPC",
		url: "https://base-rpc.publicnode.com",
		enabled: true,
	},
	{
		id: "rpc-bsc-default",
		network: "bsc",
		name: "BSC Public RPC",
		url: "https://bsc-rpc.publicnode.com",
		enabled: true,
	},
	{
		id: "rpc-polygon-default",
		network: "polygon",
		name: "Polygon Public RPC",
		url: "https://polygon-bor-rpc.publicnode.com",
		enabled: true,
	},
	{
		id: "rpc-ton-default",
		network: "ton",
		name: "TON Center",
		url: "https://toncenter.com/api/v3",
		enabled: true,
	},
	{
		id: "rpc-aptos-default",
		network: "aptos",
		name: "Aptos Labs Fullnode",
		url: "https://api.mainnet.aptoslabs.com/v1/graphql",
		enabled: true,
	},
	{
		id: "rpc-solana-default",
		network: "solana",
		name: "Solana Mainnet RPC",
		url: "https://api.mainnet-beta.solana.com",
		enabled: true,
	},
	...(
		[
			["ethereum", "Ethereum WebSocket", "wss://ethereum-rpc.publicnode.com"],
			["base", "Base WebSocket", "wss://base-rpc.publicnode.com"],
			["bsc", "BSC WebSocket", "wss://bsc-rpc.publicnode.com"],
			["polygon", "Polygon WebSocket", "wss://polygon-bor-rpc.publicnode.com"],
		] as const
	).map(([network, name, url]) => ({
		id: `rpc-${network}-websocket`,
		network,
		name,
		url,
		enabled: false,
		priority: 200,
	})),
] as const;

export const initialPaymentAssets = [
	asset("tron-trx", "TRX", "tron", "TRX", "native", null, 6),
	asset(
		"tron-usdt",
		"USDT",
		"tron",
		"USDT",
		"token",
		"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
		6,
	),
	asset("ethereum-eth", "ETH", "ethereum", "ETH", "native", null, 18),
	asset(
		"ethereum-usdt",
		"USDT",
		"ethereum",
		"USDT",
		"token",
		"0xdac17f958d2ee523a2206206994597c13d831ec7",
		6,
	),
	asset(
		"ethereum-usdc",
		"USDC",
		"ethereum",
		"USDC",
		"token",
		"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
		6,
	),
	asset("base-eth", "ETH", "base", "ETH", "native", null, 18),
	asset(
		"base-usdt",
		"USDT",
		"base",
		"USDT",
		"token",
		"0xfde4c96c8593536e31f229ea8f37b2ada2699bb2",
		6,
	),
	asset(
		"base-usdc",
		"USDC",
		"base",
		"USDC",
		"token",
		"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
		6,
	),
	asset("bsc-bnb", "BNB", "bsc", "BNB", "native", null, 18),
	asset(
		"bsc-usdt",
		"USDT",
		"bsc",
		"USDT",
		"token",
		"0x55d398326f99059ff775485246999027b3197955",
		18,
	),
	asset(
		"bsc-usdc",
		"USDC",
		"bsc",
		"USDC",
		"token",
		"0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
		18,
	),
	asset("polygon-matic", "MATIC", "polygon", "MATIC", "native", null, 18),
	asset(
		"polygon-usdt",
		"USDT",
		"polygon",
		"USDT",
		"token",
		"0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
		6,
	),
	asset(
		"polygon-usdc",
		"USDC",
		"polygon",
		"USDC",
		"token",
		"0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
		6,
	),
	asset("ton-gram", "GRAM", "ton", "GRAM", "native", null, 9),
	asset(
		"ton-usdt",
		"USDT",
		"ton",
		"USDT",
		"token",
		"0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe",
		6,
	),
	asset(
		"aptos-usdt",
		"USDT",
		"aptos",
		"USDT",
		"token",
		"0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b",
		6,
	),
	asset("aptos-apt", "APT", "aptos", "APT", "native", null, 8),
	asset(
		"aptos-usdc",
		"USDC",
		"aptos",
		"USDC",
		"token",
		"0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
		6,
	),
	asset(
		"solana-usdt",
		"USDT",
		"solana",
		"USDT",
		"token",
		"Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
		6,
	),
	asset("solana-sol", "SOL", "solana", "SOL", "native", null, 9),
	asset(
		"solana-usdc",
		"USDC",
		"solana",
		"USDC",
		"token",
		"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
		6,
	),
	asset("binance-usdt", "USDT", "binance", "USDT", "external", null, 8),
	asset("binance-usdc", "USDC", "binance", "USDC", "external", null, 8),
	asset("okx-usdt", "USDT", "okx", "USDT", "external", null, 8),
	asset("okx-usdc", "USDC", "okx", "USDC", "external", null, 8),
	asset("okpay-usdt", "USDT", "okpay", "USDT", "external", null, 8),
	asset("okpay-trx", "TRX", "okpay", "TRX", "external", null, 6),
] as const;

export const initialPaymentConnections = [
	...initialChainConnections.map((node) => ({
		id: `connection-${node.id.replace(/^rpc-/, "")}`,
		railCode: node.network,
		name: node.name,
		type: "rpc" as const,
		endpoint: node.url,
		transport: node.url.startsWith("wss://")
			? ("websocket" as const)
			: ("http" as const),
		priority: "priority" in node ? node.priority : 100,
		enabled: node.enabled,
		healthStatus: "unknown" as const,
	})),
	...initialExchangeRails.map((exchange) => ({
		id: `connection-${exchange.code}-default`,
		railCode: exchange.code,
		name: exchange.name,
		type: "provider" as const,
		endpoint: exchange.apiUrl,
		priority: 100,
		enabled: true,
		healthStatus: "unknown" as const,
	})),
	...initialWalletRails.map((wallet) => ({
		id: `connection-${wallet.code}-default`,
		railCode: wallet.code,
		name: wallet.name,
		type: "provider" as const,
		endpoint: wallet.apiUrl,
		priority: 100,
		enabled: true,
		healthStatus: "unknown" as const,
	})),
] as const;

export const initialExchangeRates = [
	...Object.entries(defaultCryptoExchangeRates).map(([base, rate]) => ({
		id: `rate-${base.toLowerCase()}-usdt`,
		category: "crypto" as const,
		base,
		quote: "USDT",
		rate,
		source: "binance",
	})),
	// USD, USDT, and USDC use the built-in 1:1 parity path. Fiat currencies
	// without a local rate are omitted until a provider supplies one.
	...Object.entries(defaultFiatExchangeRates).map(([quote, rate]) => ({
		id: `rate-usd-${quote.toLowerCase()}`,
		category: "fiat" as const,
		base: "USD",
		quote,
		rate,
		source: "exchangerate_host",
	})),
] as const;

function confirmationsForRail(rail: string) {
	if (rail === "tron") return 20;
	if (["ethereum", "base", "bsc", "polygon"].includes(rail)) return 12;
	return 1;
}

function asset(
	id: string,
	code: string,
	network: string,
	symbol: string,
	kind: "native" | "token" | "external",
	contractAddress: string | null,
	decimals: number,
) {
	return {
		id,
		code,
		railCode: network,
		symbol,
		kind,
		contractAddress,
		decimals,
		defaultConfirmations: confirmationsForRail(network),
	};
}
