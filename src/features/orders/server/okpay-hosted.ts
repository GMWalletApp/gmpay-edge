import type { CreateOrderInput } from "#/features/orders/schema";
import { OrderServiceError } from "#/features/orders/server/create";
import type { ApiOrder } from "#/features/orders/server/query";
import { assertTransition } from "#/features/orders/state-machine";
import { OkPayAdapter } from "#/integrations/wallets/okpay";
import { decryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";

export async function initializeOkPayOrder(
	db: D1Database,
	order: ApiOrder,
	input: CreateOrderInput,
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
		const now = Date.now();
		assertTransition("pending", "failed", "processing_failed");
		await db.batch([
			db
				.prepare(
					"UPDATE orders SET status = 'failed', version = version + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
				)
				.bind(now, order.orderId),
			db
				.prepare(
					"UPDATE receiving_method_locks SET released_at = ? WHERE order_id = ? AND released_at IS NULL",
				)
				.bind(now, order.orderId),
		]);
		if (error instanceof OrderServiceError) throw error;
		throw new OrderServiceError(
			"provider_unavailable",
			"OKPay could not create the hosted payment",
			502,
		);
	}
}
