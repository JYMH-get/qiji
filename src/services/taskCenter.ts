/**
 * taskCenter —— 全应用单例任务中心（阶段3 收口：TaskTracker 升单例统一调度）。
 *
 * 此前画布(nodeTaskTracker)与表格(purposeRunner)各持一个 TaskTracker。收口后：
 * 二者都经唯一一条提交路径 runPurpose → 本中心。所有进行中的单任务共用一个定时器、
 * 一份超时/抖动策略；每个任务注册自己的 onUpdate 回调（画布→写节点运行态+落资产，
 * 表格→resolve Promise），按 taskId 分发。
 */

import { TaskTracker } from "./taskTracker";
import type { TaskExtra } from "./adapters/types";

export type TaskUpdate = (
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

/** taskId → 该任务的更新回调 */
const handlers = new Map<string, TaskUpdate>();

let _tracker: TaskTracker | null = null;

function getTracker(): TaskTracker {
	if (_tracker) return _tracker;
	// TaskTracker 的 nodeId 形参在此用作关联 id（= taskId），用于回查 handler
	_tracker = new TaskTracker((corrId, progress, status, resultUri, error, assetId, partialText, rawLink, extra) => {
		const h = handlers.get(corrId);
		if (!h) return;
		h(progress, status, resultUri, error, assetId, partialText, rawLink, extra);
		if (status === "success" || status === "failed" || status === "lost") handlers.delete(corrId);
	});
	return _tracker;
}

/**
 * 注册并开始跟踪一个单任务；到达 success/failed 后自动注销 handler。
 * 客户端不做超时——只要任务在跟踪就持续轮询，终态由服务端决定（见 taskTracker）。
 */
export function trackTask(opts: {
	taskId: string;
	adapterKey: string;
	onUpdate: TaskUpdate;
}): void {
	handlers.set(opts.taskId, opts.onUpdate);
	getTracker().track({
		taskId: opts.taskId,
		nodeId: opts.taskId, // 关联 id = taskId
		adapterKey: opts.adapterKey,
	});
}
