import type { CreateOrderInput } from "#/features/orders/schema";
import { OrderServiceError } from "#/features/orders/server/create";
import type { ApiOrder } from "#/features/orders/server/query";
import { OkPayAdapter } from "#/integrations/wallets/okpay";
import { decryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";

export async function initializeOkPayOrder(
	db: D1Database,
	order: ApiOrder,
	input: CreateOrderInput,
	failure: { deleteOrder: boolean },
) {
	if (!(order.paymentAmount && order.paymentAsset))
		throw new OrderServiceError(
			"receiving_method_required",
			"Select a receiving method before creating a hosted payment",
			409,
		);
	const connection = await db
		.prepare(
			`SELECT rm.config_encrypted, ops.target_value, ops.decimals
		 FROM order_payment_snapshots ops
		 JOIN receiving_methods rm ON rm.id = ops.receiving_method_id
		 JOIN payment_ingresses pc ON pc.id = ops.connection_id
		 WHERE ops.order_id = ? AND ops.rail_code = 'okpay' LIMIT 1`,
		)
		.bind(order.orderId)
		.first<{
			config_encrypted: string | null;
			target_value: string;
			decimals: number;
		}>();
	if (!connection?.config_encrypted)
		throw new OrderServiceError(
			"provider_configuration_missing",
			"OKPay channel credentials are missing",
			503,
		);
	try {
		const runtime = await loadRuntimeConfig(db);
		const clear = await decryptSecret(
			connection.config_encrypted,
			runtime.integrationConfigSecret,
		);
		const config = JSON.parse(clear) as Record<string, unknown>;
		const adapter = new OkPayAdapter({
			...config,
			shopId: config.shopId ?? connection.target_value,
			assetDecimals: { [order.paymentAsset]: connection.decimals },
		});
		const hosted = await adapter.createHostedPayment({
			orderId: order.orderId,
			amount: order.paymentAmount,
			assetCode: order.paymentAsset,
			description: input.description ?? input.externalOrderId ?? order.orderId,
			...(runtime.betterAuthUrl
				? {
						callbackUrl: new URL(
							"/api/providers/okpay/notify",
							runtime.betterAuthUrl,
						).toString(),
					}
				: {}),
			...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
		});
		await db
			.prepare(
				"UPDATE orders SET provider_order_id = ?, payment_url = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
			)
			.bind(
				hosted.providerOrderId,
				hosted.paymentUrl,
				Date.now(),
				order.orderId,
			)
			.run();
	} catch (error) {
		const failed =
			error instanceof OrderServiceError
				? error
				: new OrderServiceError(
						"provider_unavailable",
						"OKPay could not create the hosted payment",
						502,
					);
		await rollbackHostedPayment(db, order.orderId, failure.deleteOrder, failed);
		throw failed;
	}
}

/**
 * The provider never created anything the payer could pay, so nothing is owed.
 * Release the payment selection (and the merchant order created by this
 * request) instead of burning the external order ID as a failed order.
 */
async function rollbackHostedPayment(
	db: D1Database,
	orderId: string,
	deleteOrder: boolean,
	failure: OrderServiceError,
) {
	const now = Date.now();
	await db.batch([
		db
			.prepare("DELETE FROM receiving_method_locks WHERE order_id = ?")
			.bind(orderId),
		db
			.prepare(
				`DELETE FROM order_payment_snapshots WHERE order_id = ?
				 AND NOT EXISTS (SELECT 1 FROM order_payments WHERE order_id = ?)`,
			)
			.bind(orderId, orderId),
		deleteOrder
			? db
					.prepare(
						`DELETE FROM orders WHERE id = ? AND status = 'pending'
						 AND NOT EXISTS (SELECT 1 FROM order_payment_snapshots WHERE order_id = ?)`,
					)
					.bind(orderId, orderId)
			: db
					.prepare(
						`UPDATE orders SET payment_asset_id = NULL, provider_order_id = NULL,
						 payment_url = NULL, version = version + 1, updated_at = ?
						 WHERE id = ? AND status = 'pending'
						 AND NOT EXISTS (SELECT 1 FROM order_payment_snapshots WHERE order_id = ?)`,
					)
					.bind(now, orderId, orderId),
		db
			.prepare(
				`INSERT INTO audit_logs (id, action, target_type, target_id, after, created_at)
				 VALUES (?, 'order.hosted_payment_failed', 'order', ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				orderId,
				JSON.stringify({
					provider: "okpay",
					code: failure.code,
					rolledBack: deleteOrder ? "order" : "selection",
				}),
				now,
			),
	]);
}
