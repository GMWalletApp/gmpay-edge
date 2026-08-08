import { DomainError } from "#/lib/domain-error";

export async function loadInboundWebhookReceipt(db: D1Database, id: string) {
	const row = await db
		.prepare(`SELECT id, endpoint_code, request_id, external_request_id, method, request_path,
			signature_status, processing_status, response_status, duration_ms,
			error_code, received_at FROM inbound_webhook_receipts
			WHERE id = ? LIMIT 1`)
		.bind(id)
		.first<{
			id: string;
			endpoint_code: string;
			request_id: string;
			external_request_id: string | null;
			method: string;
			request_path: string;
			signature_status: string;
			processing_status: string;
			response_status: number;
			duration_ms: number;
			error_code: string | null;
			received_at: number;
		}>();
	if (!row)
		throw new DomainError(
			"webhook_inbound_receipt_not_found",
			404,
			"Inbound webhook receipt not found",
		);
	return {
		id: row.id,
		endpointCode: row.endpoint_code,
		requestId: row.request_id,
		externalRequestId: row.external_request_id,
		method: row.method,
		requestPath: row.request_path,
		signatureStatus: row.signature_status,
		processingStatus: row.processing_status,
		responseStatus: row.response_status,
		durationMs: row.duration_ms,
		errorCode: row.error_code,
		receivedAt: new Date(row.received_at).toISOString(),
	};
}
