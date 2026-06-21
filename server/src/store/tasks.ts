/**
 * 任务存储（内存版）。
 *
 * 同步任务（真文本翻译器）直接在 /generate 返回结果、不入表。
 * 异步任务（图/视频/音频，本阶段为桩）入表，按时间推进四态：queued→running→success。
 */
import type { Capability, TaskState, TaskStatus, AssetOut } from "../contract.ts";

interface TaskRecord {
	taskId: string;
	clientTaskId?: string;
	capability: Capability;
	submittedAt: number;
	/** 桩：完成后产出的占位资产（创建任务时预生成 id，保证 id 稳定） */
	stubAsset?: AssetOut;
	/** 真实失败信息（如下游报错） */
	error?: string;
	/** 真实成功结果（若由真翻译器异步产出，可直接写入） */
	doneResult?: TaskState["result"];
	doneStatus?: TaskStatus;
	/** 真实异步任务：未完成前一直 running（不走 stub 时间机自动成功） */
	awaitingReal?: boolean;
	/** 流式文本：已累积的部分正文（边流边存，轮询可见） */
	partialText?: string;
	/** 流式进度（0-95，随 token 流入推进） */
	partialProgress?: number;
}

let _seq = 0;
const tasks = new Map<string, TaskRecord>();

export function nextTaskId(): string {
	_seq += 1;
	return `t${String(_seq).padStart(8, "0")}`;
}

export function createTask(rec: Omit<TaskRecord, "taskId" | "submittedAt">): TaskRecord {
	const full: TaskRecord = { ...rec, taskId: nextTaskId(), submittedAt: Date.now() };
	tasks.set(full.taskId, full);
	return full;
}

/** 直接落一个终态任务（批量里同步文本结果也归一成可轮询的 taskId） */
export function createCompletedTask(
	capability: Capability,
	status: TaskStatus,
	result?: TaskState["result"],
	error?: string,
	clientTaskId?: string,
): TaskRecord {
	const full: TaskRecord = {
		taskId: nextTaskId(),
		submittedAt: Date.now(),
		capability,
		clientTaskId,
		doneStatus: status,
		doneResult: result,
		error,
	};
	tasks.set(full.taskId, full);
	return full;
}

/** 真实异步任务：返回 taskId，后台完成后调用 completeTask/failTask 写入终态 */
export function createRunningTask(
	capability: Capability,
	clientTaskId?: string,
): TaskRecord {
	const full: TaskRecord = {
		taskId: nextTaskId(),
		submittedAt: Date.now(),
		capability,
		clientTaskId,
		awaitingReal: true,
	};
	tasks.set(full.taskId, full);
	return full;
}

/** 流式文本：边流边写已累积正文与进度（轮询可见部分文本+进度） */
export function appendTaskText(taskId: string, fullText: string, progress?: number): void {
	const rec = tasks.get(taskId);
	if (!rec) return;
	rec.partialText = fullText;
	rec.partialProgress = progress ?? Math.min(95, (rec.partialProgress ?? 10) + 1);
}

/** 仅更新进度（异步视频轮询用）：终态前显示推进 */
export function setTaskProgress(taskId: string, progress: number): void {
	const rec = tasks.get(taskId);
	if (rec) rec.partialProgress = Math.max(0, Math.min(95, progress));
}

export function completeTask(taskId: string, result: TaskState["result"]): void {
	const rec = tasks.get(taskId);
	if (rec) {
		rec.doneStatus = "success";
		rec.doneResult = result;
	}
}

/** 桩任务的时间推进：0-1.2s queued，1.2-3s running，>3s success */
const QUEUED_MS = 1200;
const RUNNING_MS = 3000;

export function getTaskState(taskId: string): TaskState | undefined {
	const rec = tasks.get(taskId);
	if (!rec) return undefined;

	// 已被真翻译器写入终态
	if (rec.doneStatus) {
		return {
			taskId: rec.taskId,
			clientTaskId: rec.clientTaskId,
			status: rec.doneStatus,
			progress: rec.doneStatus === "success" ? 100 : 100,
			submittedAt: new Date(rec.submittedAt).toISOString(),
			finishedAt: new Date().toISOString(),
			result: rec.doneResult,
			error: rec.error,
		};
	}

	// 真实异步任务：终态前恒为 running，等后台回填（流式文本回传部分正文+进度）
	if (rec.awaitingReal) {
		return {
			taskId: rec.taskId,
			clientTaskId: rec.clientTaskId,
			status: "running",
			progress: rec.partialProgress ?? 50,
			submittedAt: new Date(rec.submittedAt).toISOString(),
			result: rec.partialText ? { text: rec.partialText } : undefined,
		};
	}

	const elapsed = Date.now() - rec.submittedAt;
	let status: TaskStatus;
	let progress: number;
	if (elapsed < QUEUED_MS) {
		status = "queued";
		progress = 5;
	} else if (elapsed < RUNNING_MS) {
		status = "running";
		progress = Math.min(95, Math.round((elapsed / RUNNING_MS) * 100));
	} else {
		status = "success";
		progress = 100;
	}

	return {
		taskId: rec.taskId,
		clientTaskId: rec.clientTaskId,
		status,
		progress,
		submittedAt: new Date(rec.submittedAt).toISOString(),
		finishedAt: status === "success" ? new Date().toISOString() : undefined,
		result: status === "success" && rec.stubAsset ? { assets: [rec.stubAsset] } : undefined,
	};
}

export function failTask(taskId: string, error: string): void {
	const rec = tasks.get(taskId);
	if (rec) {
		rec.doneStatus = "failed";
		rec.error = error;
	}
}
