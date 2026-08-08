import { z } from "zod";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig, type RuntimeConfig } from "#/server/runtime-config";

const connectionCredentialSchema = z
	.object({ apiKey: z.string().min(1).max(512) })
	.strict();

export async function encryptPaymentConnectionCredential(
	apiKey: string,
	integrationConfigSecret: string,
) {
	return encryptSecret(
		JSON.stringify(connectionCredentialSchema.parse({ apiKey })),
		integrationConfigSecret,
	);
}

export async function loadPaymentConnectionApiKey(
	db: D1Database,
	input: {
		connectionId: string;
		configEncrypted: string | null;
		legacyApiKey: string | null;
	},
	sharedRuntime?: RuntimeConfig,
) {
	if (!input.configEncrypted && !input.legacyApiKey) return undefined;
	const runtime = sharedRuntime ?? (await loadRuntimeConfig(db));
	if (!runtime.integrationConfigSecret)
		throw new Error("Payment connection credential secret is unavailable");
	if (input.configEncrypted)
		return parseCredential(
			await decryptSecret(
				input.configEncrypted,
				runtime.integrationConfigSecret,
			),
		).apiKey;
	const legacyApiKey = input.legacyApiKey;
	if (!legacyApiKey) return undefined;
	const now = Date.now();
	const configEncrypted = await encryptPaymentConnectionCredential(
		legacyApiKey,
		runtime.integrationConfigSecret,
	);
	await db.batch([
		db
			.prepare(
				`INSERT INTO payment_ingress_credentials
				 (payment_ingress_id, config_encrypted, created_at, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(payment_ingress_id) DO NOTHING`,
			)
			.bind(input.connectionId, configEncrypted, now, now),
		db
			.prepare(
				"UPDATE payment_ingresses SET api_key = NULL, updated_at = ? WHERE id = ? AND api_key = ?",
			)
			.bind(now, input.connectionId, legacyApiKey),
	]);
	return legacyApiKey;
}

function parseCredential(value: string) {
	return connectionCredentialSchema.parse(JSON.parse(value));
}
