/**
 * taskCenter —— 全应用单例任务中心（阶段3 收口：TaskTracker 升单例统一调度）。
 *
 * 此前画布(nodeTaskTracker)与表格(purposeRunner)各持一个 TaskTracker。收口后：
 * 二者都经唯一一条提交路径 runPurpose → 本中心。所有进行中的单任务共用一个定时器、
 * 一份超时/抖动策略；每个任务注册自己的 onUpdate 回调（画布→写节点运行态+落资产，
 * 表格→resolve Promise），按 taskId 分发。
 *
 * （批量路径 nodes/batchExecutor 仍为独立的批量协调器，不走此中心。）
 */

import { TaskTracker } from "./taskTracker";

export type TaskUpdate = (
	progress: number,
	status: string,
	resultUri?: string,
	error?: string,
	assetId?: string,
	partialText?: string,
) => void;

/** taskId → 该任务的更新回调 */
const handlers = new Map<string, TaskUpdate>();

let _tracker: TaskTracker | null = null;

function getTracker(): TaskTracker {
	if (_tracker) return _tracker;
	// TaskTracker 的 nodeId 形参在此用作关联 id（= taskId），用于回查 handler
	_tracker = new TaskTracker((corrId, progress, status, resultUri, error, assetId, partialText) => {
		const h = handlers.get(corrId);
		if (!h) return;
		h(progress, status, resultUri, error, assetId, partialText);
		if (status === "success" || status === "failed") handlers.delete(corrId);
	});
	return _tracker;
}

/** 注册并开始跟踪一个单任务；到达 success/failed 后自动注销 handler */
export function trackTask(opts: {
	taskId: string;
	adapterKey: string;
	onUpdate: TaskUpdate;
	/** 轮询超时（ms）；长文本(20w字)可传更大值，缺省走 TaskTracker 默认 */
	timeoutMs?: number;
}): void {
	handlers.set(opts.taskId, opts.onUpdate);
	getTracker().track({
		taskId: opts.taskId,
		nodeId: opts.taskId, // 关联 id = taskId
		adapterKey: opts.adapterKey,
		timeoutMs: opts.timeoutMs,
	});
}
