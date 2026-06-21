import { getAdapter } from "./modelAdapter";

/**
 * 集中式批量轮询管理器（取代每节点各自的 setTimeout/setInterval 轮询）。
 *
 * 所有进行中的任务共用一个定时器统一轮询；任一任务到达 success/failed 即移除。
 * 抽象边界稳定，阶段后期升级 SSE/WebSocket 只换内部实现，调用方无感。
 */
export interface TrackedTask {
	taskId: string;
	nodeId: string;
	adapterKey: string;
	/** 入队时间戳（ms）；用于超时判定 */
	startedAt: number;
	/** 超时阈值（ms）；超过则置为 failed */
	timeoutMs: number;
}

export type ProgressCallback = (
	nodeId: string,
	progress: number,
	status: string,
	resultUri?: string,
	error?: string,
) => void;

const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

export class TaskTracker {
	private tasks = new Map<string, TrackedTask>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private intervalMs = 2000;
	constructor(private onProgress: ProgressCallback) {}

	track(task: Omit<TrackedTask, "startedAt" | "timeoutMs"> & { timeoutMs?: number }): void {
		this.tasks.set(task.taskId, {
			...task,
			startedAt: Date.now(),
			timeoutMs: task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		});
		this.ensureRunning();
	}

	/** 主动取消跟踪（节点删除/重跑时） */
	untrack(taskId: string): void {
		this.tasks.delete(taskId);
	}

	private finish(taskId: string): void {
		this.tasks.delete(taskId);
	}

	private ensureRunning(): void {
		if (this.timer || this.tasks.size === 0) return;
		const tick = async () => {
			this.timer = null;
			await Promise.all(
				[...this.tasks.values()].map(async (t) => {
					// 超时保护
					if (Date.now() - t.startedAt > t.timeoutMs) {
						this.finish(t.taskId);
						this.onProgress(t.nodeId, 100, "failed", undefined, "生成超时，已取消");
						return;
					}
					const adapter = getAdapter(t.adapterKey);
					if (!adapter) {
						this.finish(t.taskId);
						this.onProgress(t.nodeId, 100, "failed", undefined, `未找到适配器「${t.adapterKey}」`);
						return;
					}
					try {
						const res = await adapter.poll(t.taskId);
						if (res.status === "success" || res.status === "failed") this.finish(t.taskId);
						this.onProgress(t.nodeId, res.progress, res.status, res.resultUri, res.error);
					} catch (err) {
						// 网络/网关抖动：保留任务，下一轮继续（不立即失败）
						this.onProgress(t.nodeId, 50, "running", undefined, (err as Error).message);
					}
				}),
			);
			if (this.tasks.size) this.timer = setTimeout(tick, this.intervalMs);
		};
		// 首轮稍快触发，改善同步结果的呈现延迟
		this.timer = setTimeout(tick, 400);
	}
}
