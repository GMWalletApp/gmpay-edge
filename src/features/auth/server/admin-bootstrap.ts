import { createServerOnlyFn } from "@tanstack/react-start";
import { AccessDeniedError } from "#/features/access/server/access-cache";
import { getAdminPermissions } from "#/features/access/server/require-admin";
import { isInstalled } from "#/features/installation/server/install";
import { getDb } from "#/server/db.server";

/** Installation state and session access load concurrently: one D1 round each. */
export const loadAdminBootstrap = createServerOnlyFn(
	async (request: Request) => {
		const [installed, access] = await Promise.all([
			isInstalled(getDb(request)),
			getAdminPermissions(request).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			),
		]);
		if (!installed) return { installed: false } as const;
		if ("value" in access)
			return { installed: true, access: access.value } as const;
		if (
			access.error instanceof AccessDeniedError &&
			access.error.status === 401
		)
			return { installed: true, access: null } as const;
		throw access.error;
	},
);
