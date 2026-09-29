import { withClientAddress } from "#/server/runtime/client-address";
import { runWithRuntimeEnv } from "#/server/runtime/context";
import { createNodeApplication } from "#/server/runtime/node/application";
import { handleAppRequest } from "#/server-entry";

const application = await createNodeApplication();

export default {
	fetch(request: Request) {
		return application.trackRequest(() =>
			runWithRuntimeEnv(application.env, () =>
				handleAppRequest(withClientAddress(request), application.env),
			),
		);
	},
};
