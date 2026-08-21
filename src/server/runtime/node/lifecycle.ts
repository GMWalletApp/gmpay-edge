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
