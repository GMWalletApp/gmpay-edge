import { hmac } from "@noble/hashes/hmac.js";
import { md5 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { constantTimeEqual } from "#/lib/crypto";
import { decryptSecret } from "#/lib/secrets";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { hasRequiredApiScope, parseApiScopes } from "../scopes";
import { claimApiRateLimit } from "./rate-limit";

export class GmpayRateLimitError extends Error {}
export class AmbiguousSignatureParametersError extends Error {}

const LAST_USED_WRITE_INTERVAL_MS = 10 * 60_000;
/** Failed authentications per submitted PID and minute before probes are refused. */
export const AUTH_FAILURE_LIMIT = 20;
const AUTH_FAILURE_WINDOW_MS = 60_000;

type AuthenticationContext = { requestId?: string | null };

type CredentialRow = {
	id: string;
	secret_encrypted: string;
	scopes: string;
	enabled: number;
	expires_at: number | null;
	revoked_at: number | null;
};

export function gmpaySignaturePayload(
	parameters: object,
	excluded = new Set(["signature"]),
) {
	const pairs = Object.entries(parameters)
		.filter(
			([key, value]) =>
				!excluded.has(key) && value !== null && value !== undefined,
		)
		.map(([key, value]) => [key, normalizeValue(value)] as const)
		.filter(([, value]) => value !== "")
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, value]) => {
			// Legacy signatures have no escaping. Restrict the accepted language so
			// a value cannot be reinterpreted as another signed parameter boundary.
			if (
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
				/&[A-Za-z_][A-Za-z0-9_]*=/.test(value)
			)
				throw new AmbiguousSignatureParametersError(
					"Ambiguous signature parameters",
				);
			return `${key}=${value}`;
		});
	return pairs.join("&");
}

export function signGmpayParameters(
	parameters: object,
	secret: string,
	excluded?: Set<string>,
) {
	return bytesToHex(
		hmac(
			sha256,
			utf8ToBytes(secret),
			utf8ToBytes(gmpaySignaturePayload(parameters, excluded)),
		),
	);
}

export function signEpayParameters(
	parameters: object,
	secret: string,
	excluded = new Set(["sign", "sign_type"]),
) {
	return bytesToHex(
		md5(utf8ToBytes(`${gmpaySignaturePayload(parameters, excluded)}${secret}`)),
	);
}

export function verifyGmpaySignature(
	parameters: object,
	secret: string,
	signature: string,
	excluded?: Set<string>,
) {
	try {
		return constantTimeEqual(
			signGmpayParameters(parameters, secret, excluded),
			signature,
		);
	} catch (error) {
		if (error instanceof AmbiguousSignatureParametersError) return false;
		throw error;
	}
}

export function verifyEpaySignature(
	parameters: object,
	secret: string,
	signature: string,
	excluded?: Set<string>,
) {
	try {
		return constantTimeEqual(
			signEpayParameters(parameters, secret, excluded),
			signature,
		);
	} catch (error) {
		if (error instanceof AmbiguousSignatureParametersError) return false;
		throw error;
	}
}

export async function authenticateGmpayParameters(
	db: D1Database,
	parameters: object,
	requiredScope: string,
	context?: AuthenticationContext,
) {
	return authenticateParameters(db, parameters, requiredScope, {
		signatureField: "signature",
		verifySignature: verifyGmpaySignature,
		context,
	});
}

export async function authenticateEpayParameters(
	db: D1Database,
	parameters: object,
	requiredScope: string,
	context?: AuthenticationContext,
) {
	return authenticateParameters(db, parameters, requiredScope, {
		signatureField: "sign",
		excluded: new Set(["sign", "sign_type"]),
		verifySignature: verifyEpaySignature,
		context,
	});
}

async function authenticateParameters(
	db: D1Database,
	parameters: object,
	requiredScope: string,
	options: {
		signatureField: string;
		excluded?: Set<string>;
		verifySignature: typeof verifyGmpaySignature;
		context?: AuthenticationContext;
	},
) {
	const pid = normalizeValue(parameterValue(parameters, "pid"));
	const signature = normalizeValue(
		parameterValue(parameters, options.signatureField),
	);
	if (!(pid && signature)) return null;
	const now = Date.now();
	const failureBucket = {
		bucketKey: `api-key-auth-fail:${pid}`,
		limit: AUTH_FAILURE_LIMIT,
		windowMs: AUTH_FAILURE_WINDOW_MS,
		now,
	};
	// One round trip returns the credential and the current failure-window count,
	// so unauthenticated probes are bounded without taxing valid requests. The
	// failure bucket is separate: rejected signatures never consume success quota.
	const row = await db
		.prepare(
			`SELECT k.id, k.secret_encrypted, k.scopes, k.enabled, k.expires_at, k.revoked_at,
			 (SELECT count FROM rate_limit_counters WHERE bucket_key = ? AND window_start = ?) AS auth_failures
			 FROM (SELECT 1) AS probe LEFT JOIN api_keys k ON k.pid = ?`,
		)
		.bind(
			failureBucket.bucketKey,
			Math.floor(now / AUTH_FAILURE_WINDOW_MS) * AUTH_FAILURE_WINDOW_MS,
			pid,
		)
		.first<Partial<CredentialRow> & { auth_failures: number | null }>();
	if ((row?.auth_failures ?? 0) >= AUTH_FAILURE_LIMIT)
		throw new GmpayRateLimitError("API authentication failure limit exceeded");
	const credential = row?.id ? (row as CredentialRow) : null;
	const verified = credential
		? await verifyCredential(
				db,
				credential,
				parameters,
				signature,
				requiredScope,
				options,
			)
		: null;
	if (!(credential && verified)) {
		await claimFixedWindowRateLimit(db, failureBucket);
		console.warn("merchant_auth_failed", {
			pid,
			requestId: options.context?.requestId ?? null,
		});
		return null;
	}
	const rate = await claimApiRateLimit(db, {
		apiKeyId: credential.id,
		limit: 120,
	});
	if (!rate.allowed) throw new GmpayRateLimitError("API rate limit exceeded");
	await db
		.prepare(
			`UPDATE api_keys SET last_used_at = ?, updated_at = ?
			 WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`,
		)
		.bind(now, now, credential.id, now - LAST_USED_WRITE_INTERVAL_MS)
		.run();
	return { apiKeyId: credential.id, pid, ...verified };
}

/** Returns the decrypted secret and scopes only when every credential check passes. */
async function verifyCredential(
	db: D1Database,
	row: CredentialRow,
	parameters: object,
	signature: string,
	requiredScope: string,
	options: {
		excluded?: Set<string>;
		verifySignature: typeof verifyGmpaySignature;
	},
) {
	if (
		row.enabled !== 1 ||
		row.revoked_at ||
		(row.expires_at !== null && row.expires_at < Date.now())
	)
		return null;
	const scopes = parseApiScopes(row.scopes);
	if (!scopes || !hasRequiredApiScope(scopes, requiredScope)) return null;
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.apiKeyPepper) return null;
	const secret = await decryptSecret(
		row.secret_encrypted,
		runtime.apiKeyPepper,
	);
	return options.verifySignature(
		parameters,
		secret,
		signature,
		options.excluded,
	)
		? { secret, scopes }
		: null;
}

function parameterValue(parameters: object, key: string) {
	return Object.entries(parameters).find(([name]) => name === key)?.[1];
}

function normalizeValue(value: unknown) {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}
