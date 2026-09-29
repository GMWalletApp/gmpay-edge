import { createIsolateSnapshot } from "#/server/isolate-snapshot";

export type PublicPaymentMethod = {
	type: "network" | "exchange" | "wallet";
	code: string;
	name: string;
	assets: string[];
	status: "available" | "implemented";
};

export const publicPaymentMethodsTtlMs = 10_000;

const publicPaymentMethodsSnapshot = createIsolateSnapshot<
	PublicPaymentMethod[]
>(publicPaymentMethodsTtlMs);

/** Anonymous `/assets` loads share one catalog query round per ten seconds. */
export function getPublicPaymentMethodsSnapshot(
	db: D1Database,
	now = Date.now(),
) {
	return publicPaymentMethodsSnapshot(
		db,
		() => queryPublicPaymentMethods(db),
		now,
	);
}

export async function queryPublicPaymentMethods(db: D1Database) {
	const rows = await db
		.prepare(`SELECT CASE kind WHEN 'chain' THEN 'network' ELSE kind END AS type,
		 code, name FROM payment_rails ORDER BY kind, name`)
		.all<{
			type: PublicPaymentMethod["type"];
			code: string;
			name: string;
		}>();
	const assets = await db
		.prepare(`SELECT pa.code, pa.rail_code AS provider,
			 MAX(CASE WHEN rm.enabled = 1 AND rm.target_value != ''
			  AND EXISTS (SELECT 1 FROM payment_ingresses connection
			   WHERE connection.rail_code = pa.rail_code AND connection.enabled = 1
			   AND EXISTS (SELECT 1 FROM payment_rails availability_rail
			    WHERE availability_rail.code = connection.rail_code
			     AND (availability_rail.kind IN ('exchange', 'wallet')
			      OR connection.health_status = 'healthy'))) THEN 1 ELSE 0 END) AS available
		 FROM payment_assets pa
		 LEFT JOIN receiving_method_assets link ON link.payment_asset_id = pa.id
		 LEFT JOIN receiving_methods rm ON rm.id = link.receiving_method_id
		 GROUP BY pa.id ORDER BY pa.code`)
		.all<{ code: string; provider: string; available: number }>();
	return rows.results.map((row): PublicPaymentMethod => {
		const supportedAssets = assets.results.filter(
			(asset) => asset.provider === row.code,
		);
		return {
			type: row.type,
			code: row.code,
			name: row.name,
			assets: [...new Set(supportedAssets.map((asset) => asset.code))],
			status: supportedAssets.some((asset) => Boolean(asset.available))
				? "available"
				: "implemented",
		};
	});
}

type AvailablePaymentAsset = {
	code: string;
	network: string;
	symbol: string;
	decimals: number;
};

export async function queryAvailablePaymentAssets(db: D1Database) {
	const result = await db
		.prepare(`SELECT DISTINCT
		 a.code, a.rail_code AS network,
		 a.symbol, a.decimals
		 FROM payment_assets a
		 JOIN receiving_method_assets link ON link.payment_asset_id = a.id
		 JOIN receiving_methods rm ON rm.id = link.receiving_method_id
		 JOIN payment_rails pr ON pr.code = a.rail_code
			 WHERE rm.enabled = 1
			 AND rm.target_value != ''
			 AND EXISTS (SELECT 1 FROM payment_ingresses pc WHERE pc.rail_code = a.rail_code
			  AND pc.enabled = 1
			  AND (pr.kind IN ('exchange', 'wallet') OR pc.health_status = 'healthy'))
		 ORDER BY network, a.code`)
		.all<AvailablePaymentAsset>();
	return result.results;
}
