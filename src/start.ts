import { createStart } from "@tanstack/react-start";
import { requestMiddleware } from "#/server/middleware";
import { serverFunctionErrorMiddleware } from "#/server/server-function-errors";

export const startInstance = createStart(() => ({
	requestMiddleware,
	functionMiddleware: [serverFunctionErrorMiddleware],
}));
