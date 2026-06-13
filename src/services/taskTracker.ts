import { getAdapter } from "./modelAdapter";

/**
 * 集中式批量轮询管理器（非每节点各自 setInterval）+ 指数退避。
 * 抽象边界稳定，Phase 后期升级 SSE/WebSocket 只换实现。
 */
export interface TrackedTask {
	taskId: string;
	nodeId: string;
	adapterKey: string;
}

export type ProgressCallback = (
	nodeId: string,
	progress: number,
	status: string,
	resultUri?: string,
) => void;

export class TaskTracker {
	private tasks = new Map<string, TrackedTask>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private intervalMs = 2000;
	constructor(private onProgress: ProgressCallback) {}

	track(task: TrackedTask): void {
		this.tasks.set(task.taskId, task);
		this.ensureRunning();
	}

	private ensureRunning(): void {
		if (this.timer || this.tasks.size === 0) return;
		const tick = async () => {
			await Promise.all(
				[...this.tasks.values()].map(async (t) => {
					const adapter = getAdapter(t.adapterKey);
					if (!adapter) return;
					const res = await adapter.poll(t.taskId);
					this.onProgress(t.nodeId, res.progress, res.status, res.resultUri);
					if (res.status === "success" || res.status === "failed")
						this.tasks.delete(t.taskId);
				}),
			);
			this.timer = this.tasks.size ? setTimeout(tick, this.intervalMs) : null;
		};
		this.timer = setTimeout(tick, this.intervalMs);
	}
}
