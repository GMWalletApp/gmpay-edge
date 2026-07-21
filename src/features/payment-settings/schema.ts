import { z } from "zod";

export const paymentConnectionToggleInput = z
	.object({
		type: z.literal("rpc"),
		id: z.string().trim().min(1).max(100),
		enabled: z.boolean(),
	})
	.strict();

export const paymentConnectionIdInput = z.object({
	id: z.string().trim().min(1).max(100),
});

const connectionFields = z.object({
	name: z.string().trim().min(1).max(100),
	transport: z.enum(["http", "websocket"]),
	endpoint: z.url(),
	priority: z.number().int().min(0).max(10_000),
});

export const evmScanConfigFields = {
	timeoutMs: z.number().int().min(1000).max(30_000).optional(),
	blockLookback: z.number().int().min(1).max(20_000).optional(),
	logBlockRange: z.number().int().min(1).max(20_000).optional(),
	maxScanTransactions: z.number().int().min(1).max(10_000).optional(),
};

function transportMatchesEndpoint(value: {
	transport: "http" | "websocket";
	endpoint: string;
}) {
	if (value.transport === "websocket")
		return value.endpoint.startsWith("wss://");
	const endpoint = new URL(value.endpoint);
	return (
		endpoint.protocol === "https:" ||
		(endpoint.protocol === "http:" && endpoint.hostname === "localhost")
	);
}

const connectionProtocolIssue = {
	message:
		"HTTP connections require https:// and WebSocket connections require wss://",
	path: ["endpoint"],
};

export const createPaymentConnectionInput = connectionFields
	.extend({
		...evmScanConfigFields,
		railCode: z.string().trim().min(1).max(50),
		type: z.literal("rpc"),
		apiKey: z.string().trim().max(512).optional(),
	})
	.strict()
	.refine(transportMatchesEndpoint, connectionProtocolIssue);

export const updateChainPaymentConnectionInput = paymentConnectionIdInput
	.extend({
		...connectionFields.shape,
		...evmScanConfigFields,
		apiKey: z.string().trim().max(512).optional(),
		clearApiKey: z.boolean().default(false),
	})
	.strict()
	.refine(transportMatchesEndpoint, connectionProtocolIssue);

export const updateProviderPaymentConnectionInput = paymentConnectionIdInput
	.extend({
		name: z.string().trim().min(1).max(100),
		endpoint: z.url(),
		priority: z.number().int().min(0).max(10_000),
	})
	.strict()
	.refine((value) => value.endpoint.startsWith("https://"), {
		message: "Provider API address must use HTTPS",
		path: ["endpoint"],
	});
