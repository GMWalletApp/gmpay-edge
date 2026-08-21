import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeEnv } from "#/server/runtime/types";

const runtimeEnvStorage = new AsyncLocalStorage<RuntimeEnv>();

export function runWithRuntimeEnv<T>(env: RuntimeEnv, callback: () => T): T {
	return runtimeEnvStorage.run(env, callback);
}

export function currentRuntimeEnv(): RuntimeEnv {
	const env = runtimeEnvStorage.getStore();
	if (!env)
		throw new Error(
			"Runtime bindings are unavailable outside a server request",
		);
	return env;
}
