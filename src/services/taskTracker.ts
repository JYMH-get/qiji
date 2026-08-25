import { getAdapter } from "./modelAdapter";
import type { TaskExtra } from "./adapters/types";

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
}

export type ProgressCallback = (
	nodeId: string,
	progress: number,
	status: string,
	resultUri?: string,
	error?: string,
	assetId?: string,
	partialText?: string,
	/** 服务端未转存的原始时效直链结果（meta.rehosted=false）——调用方需本机下载+上传转存（第158轮） */
	rawLink?: boolean,
	/** 排队/阶段情报（第251轮）：⚠ 统一以**尾部可选对象**追加，勿再往后加位置参数 */
	extra?: TaskExtra,
) => void;

export class TaskTracker {
	private tasks = new Map<string, TrackedTask>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	// 常规 5s 轮询：减轻管理端轮询压力。
	private intervalMs = 5000;
	// 文本流式快轮询：某任务仍 running 且已返回部分正文（partialText）时，下一轮用此更短间隔，
	// 让智能推理 / 智能拆分等文本流式「边出边填」更顺滑；图片/视频任务无 partialText，仍走 5s。
	private streamIntervalMs = 1500;
	constructor(private onProgress: ProgressCallback) {}

	track(task: TrackedTask): void {
		this.tasks.set(task.taskId, { ...task });
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
			let streaming = false; // 本轮是否有「仍在 running 且已出部分正文」的文本任务 → 下轮快轮询
			await Promise.all(
				[...this.tasks.values()].map(async (t) => {
					// 客户端**不做超时**：超时是服务端的职责（服务端对图/视频等有自己的超时，
					// 到点会把任务置为 failed）。客户端只要任务还在跟踪，就持续向服务端取结果，
					// 只认服务端的 success/failed 两个终态；网络/网关抖动当作仍在进行、下轮重试。
					const adapter = getAdapter(t.adapterKey);
					if (!adapter) {
						this.finish(t.taskId);
						this.onProgress(t.nodeId, 100, "failed", undefined, `未找到适配器「${t.adapterKey}」`);
						return;
					}
					try {
						const res = await adapter.poll(t.taskId);
						// success/failed/lost 均为终态：停止轮询（lost=服务端丢任务，由上层提示+提供重连）
						if (res.status === "success" || res.status === "failed" || res.status === "lost") this.finish(t.taskId);
						else if (res.status === "running" && res.partialText) streaming = true; // 文本流式中 → 下轮快轮询
						this.onProgress(t.nodeId, res.progress, res.status, res.resultUri, res.error, res.assetId, res.partialText, res.rawLink, {
							queuePosition: res.queuePosition,
							queueTotal: res.queueTotal,
							stageText: res.stageText,
						});
					} catch (err) {
						// 网络/网关抖动：保留任务，下一轮继续（不立即失败）
						this.onProgress(t.nodeId, 50, "running", undefined, (err as Error).message);
					}
				}),
			);
			// 有文本流式任务在跑 → 下轮快轮询(1.5s) 让部分正文更顺滑；否则常规 5s
			if (this.tasks.size) this.timer = setTimeout(tick, streaming ? this.streamIntervalMs : this.intervalMs);
		};
		// 首轮 2s 触发，之后按是否流式自适应（1.5s / 5s）
		this.timer = setTimeout(tick, 2000);
	}
}
