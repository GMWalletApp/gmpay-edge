import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { getPublicPaymentMethodsSnapshot } from "#/features/status/server/assets-query";
import { getCloudflareEnv } from "#/server/db.server";

export const getPublicPaymentMethodsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const db = getCloudflareEnv(getRequest()).DB;
	if (!db) throw new Error("D1 binding DB is unavailable");
	return getPublicPaymentMethodsSnapshot(db);
});
