import { describe, expect, it } from "vitest";
import {
	createPaymentConnectionInput,
	updateProviderPaymentConnectionInput,
} from "#/features/payment-settings/schema";

const base = {
	name: "Primary RPC",
	railCode: "ethereum",
	type: "rpc" as const,
	priority: 100,
};

describe("payment connection input", () => {
	it.each([
		["http", "https://rpc.example"],
		["websocket", "wss://rpc.example/ws"],
	] as const)("accepts %s transport at %s", (transport, endpoint) => {
		expect(
			createPaymentConnectionInput.safeParse({
				...base,
				transport,
				endpoint,
			}).success,
		).toBe(true);
	});

	it.each([
		["http", "http://rpc.example"],
		["http", "wss://rpc.example/ws"],
		["websocket", "https://rpc.example"],
		["websocket", "ws://localhost:8787"],
		["http", "http://localhost:8787"],
		["http", "https://127.0.0.1/rpc"],
		["http", "https://169.254.169.254/latest/meta-data"],
		["http", "https://user:password@rpc.example"],
	] as const)("rejects %s transport at %s", (transport, endpoint) => {
		expect(
			createPaymentConnectionInput.safeParse({
				...base,
				transport,
				endpoint,
			}).success,
		).toBe(false);
	});

	it("requires HTTPS for exchange and wallet provider APIs", () => {
		const input = { id: "okx", name: "OKX", priority: 100 };
		expect(
			updateProviderPaymentConnectionInput.safeParse({
				...input,
				endpoint: "https://www.okx.com",
			}).success,
		).toBe(true);
		expect(
			updateProviderPaymentConnectionInput.safeParse({
				...input,
				endpoint: "http://www.okx.com",
			}).success,
		).toBe(false);
	});

	it("fails closed when public provider connections receive account credentials", () => {
		expect(
			createPaymentConnectionInput.safeParse({
				...base,
				type: "provider",
				transport: "http",
				endpoint: "https://api.example.com",
			}).success,
		).toBe(false);

		const provider = {
			id: "okx",
			name: "OKX",
			endpoint: "https://www.okx.com",
			priority: 100,
		};
		for (const credential of [
			{ accountUid: "123" },
			{ apiKey: "key" },
			{ secretKey: "secret" },
			{ passphrase: "phrase" },
			{ shopId: "456" },
		]) {
			expect(
				updateProviderPaymentConnectionInput.safeParse({
					...provider,
					...credential,
				}).success,
			).toBe(false);
		}
	});

	it("rejects credentials in chain connection configuration", () => {
		for (const credential of [{ apiKey: "key" }, { clearApiKey: true }]) {
			expect(
				createPaymentConnectionInput.safeParse({
					...base,
					transport: "http",
					endpoint: "https://rpc.example",
					...credential,
				}).success,
			).toBe(false);
		}
	});
});
