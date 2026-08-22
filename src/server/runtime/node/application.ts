import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { PaymentQueueMessage } from "#/features/payments/types";
import type { WebhookQueueMessage } from "#/features/webhooks/types";
import { handleQueue } from "#/server/queue";
import { runWithRuntimeEnv } from "#/server/runtime/context";
import { ConfiguredMailSender } from "#/server/runtime/email-mail";
import {
	applyNodeMigrations,
	NodeDurableQueue,
	NodeMemoryCache,
	NodeObjectStorage,
	NodeRuntimeLifecycle,
	NodeScheduler,
	openNodeDatabase,
	resolveNodeDataLayout,
} from "#/server/runtime/node";
import type { RuntimeEnv } from "#/server/runtime/types";
import { runMaintenance } from "#/server/scheduled";

const WEBHOOK_QUEUE_NAME = "gmpay-edge-webhooks";
const PAYMENT_QUEUE_NAME = "gmpay-edge-payments";

export type NodeApplication = {
	env: RuntimeEnv;
	dataDirectory: string;
	stop(): Promise<void>;
};

export async function createNodeApplication(
	dataDirectory = process.env.GMPAY_DATA_DIR,
): Promise<NodeApplication> {
	if (!dataDirectory)
		throw new Error("GMPAY_DATA_DIR must point to a persistent data directory");

	const layout = resolveNodeDataLayout(dataDirectory);
	await mkdir(layout.root, { recursive: true, mode: 0o700 });
	if (await pathExists(layout.maintenanceLock))
		throw new Error(
			`Data maintenance is active for ${layout.root}; start the server after it completes`,
		);
	const database = openNodeDatabase(layout.database);
	try {
		await applyNodeMigrations(database, resolve(process.cwd(), "drizzle"));
	} catch (error) {
		database.close();
		throw error;
	}

	const webhookQueue = new NodeDurableQueue<WebhookQueueMessage>(
		database,
		WEBHOOK_QUEUE_NAME,
	);
	const paymentQueue = new NodeDurableQueue<PaymentQueueMessage>(
		database,
		PAYMENT_QUEUE_NAME,
	);
	const pendingTasks = new Set<Promise<unknown>>();
	const env: RuntimeEnv = {
		runtime: "bun",
		DB: database,
		CACHE: new NodeMemoryCache(),
		FILES: new NodeObjectStorage(layout.objects),
		WEBHOOK_QUEUE: webhookQueue,
		PAYMENT_QUEUE: paymentQueue,
		MAIL: new ConfiguredMailSender(database),
		waitUntil(promise) {
			pendingTasks.add(promise);
			void promise
				.catch((error: unknown) => {
					console.error(
						JSON.stringify({
							event: "bun_background_task_failed",
							error: error instanceof Error ? error.name : "UnknownError",
						}),
					);
				})
				.finally(() => pendingTasks.delete(promise));
		},
	};
	const workerEnv = env as unknown as Env;
	const consume = (batch: unknown) =>
		runWithRuntimeEnv(env, () =>
			handleQueue(
				batch as MessageBatch<WebhookQueueMessage | PaymentQueueMessage>,
				workerEnv,
			),
		);
	const webhookConsumer = webhookQueue.createConsumer(consume, {
		concurrency: 5,
		maxAttempts: 8,
		baseRetryDelayMs: 15_000,
	});
	const paymentConsumer = paymentQueue.createConsumer(consume, {
		concurrency: 2,
		maxAttempts: 5,
		baseRetryDelayMs: 15_000,
	});
	const scheduler = new NodeScheduler((scheduledAt) =>
		runWithRuntimeEnv(env, () =>
			runMaintenance(workerEnv, "* * * * *", undefined, scheduledAt),
		),
	);
	const lifecycle = new NodeRuntimeLifecycle([
		{
			start() {},
			async stop() {
				await Promise.allSettled(pendingTasks);
				database.close();
			},
		},
		webhookConsumer,
		paymentConsumer,
		scheduler,
	]);
	await lifecycle.start();
	const removeSignalHandlers = lifecycle.installSignalHandlers();

	return {
		env,
		dataDirectory: layout.root,
		async stop() {
			removeSignalHandlers();
			await lifecycle.stop();
		},
	};
}

async function pathExists(path: string) {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
