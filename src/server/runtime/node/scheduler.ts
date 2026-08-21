export type NodeSchedulerOptions = {
	intervalMs?: number;
	now?: () => number;
};

export class NodeScheduler {
	private timer: ReturnType<typeof setInterval> | undefined;
	private inFlight: Promise<void> | undefined;

	constructor(
		private readonly task: (scheduledAt: number) => Promise<void>,
		private readonly options: NodeSchedulerOptions = {},
	) {}

	start() {
		if (this.timer) return;
		this.timer = setInterval(
			() => this.run(),
			this.options.intervalMs ?? 60_000,
		);
		this.timer.unref?.();
	}

	async stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.inFlight?.catch(() => undefined);
	}

	private run() {
		if (this.inFlight) return;
		this.inFlight = this.task((this.options.now ?? Date.now)())
			.catch((error: unknown) => {
				console.error(
					JSON.stringify({
						event: "node_scheduler_failed",
						error: error instanceof Error ? error.name : "UnknownError",
					}),
				);
			})
			.finally(() => {
				this.inFlight = undefined;
			});
	}
}
