export type NodeRuntimeService = {
	start(): void | Promise<void>;
	stop(): void | Promise<void>;
};

export class NodeRuntimeLifecycle {
	private stopping: Promise<void> | undefined;

	constructor(private readonly services: readonly NodeRuntimeService[]) {}

	async start() {
		for (const service of this.services) await service.start();
	}

	stop() {
		this.stopping ??= this.stopServices();
		return this.stopping;
	}

	installSignalHandlers() {
		const stop = () => void this.stop();
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		return () => {
			process.off("SIGTERM", stop);
			process.off("SIGINT", stop);
		};
	}

	private async stopServices() {
		for (const service of [...this.services].reverse()) await service.stop();
	}
}

/**
 * srvx drains in-flight HTTP requests on SIGTERM independently of this
 * lifecycle. Tracking handled requests lets services that stop later in the
 * reverse order (the database) wait for those requests to settle, bounded so a
 * hung handler cannot block process exit.
 */
export class NodeRequestTracker implements NodeRuntimeService {
	private inFlight = 0;
	private drained: (() => void) | undefined;

	constructor(private readonly drainTimeoutMs = 10_000) {}

	track<T>(handle: () => Promise<T>): Promise<T> {
		this.inFlight += 1;
		return new Promise<T>((resolve) => resolve(handle())).finally(() => {
			this.inFlight -= 1;
			if (this.inFlight === 0) this.drained?.();
		});
	}

	start() {}

	stop() {
		if (this.inFlight === 0) return;
		return new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, this.drainTimeoutMs);
			this.drained = () => {
				clearTimeout(timer);
				resolve();
			};
		});
	}
}
