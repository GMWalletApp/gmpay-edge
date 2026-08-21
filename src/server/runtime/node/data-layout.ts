import { resolve } from "node:path";

export const NODE_DATABASE_FILENAME = "gmpay.sqlite";
export const NODE_OBJECTS_DIRECTORY = "objects";
export const NODE_MAINTENANCE_LOCK_FILENAME = ".maintenance.lock";

export type NodeDataLayout = ReturnType<typeof resolveNodeDataLayout>;

export function resolveNodeDataLayout(dataDirectory: string) {
	const root = resolve(dataDirectory);
	return {
		root,
		database: resolve(root, NODE_DATABASE_FILENAME),
		objects: resolve(root, NODE_OBJECTS_DIRECTORY),
		maintenanceLock: resolve(root, NODE_MAINTENANCE_LOCK_FILENAME),
	};
}
