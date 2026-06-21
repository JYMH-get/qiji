/**
 * 请求记录（JSONL 持久化）。
 *
 * 记录每次 /generate：请求时间、完成时间、用户、purpose（在哪一步，如 script.analyze）、
 * 完整请求、完整响应/结果、状态。base64 会被截断以防膨胀。
 */
import { appendJsonl, readJsonl, writeJsonl, genId, truncateBase64 } from "./db.ts";
import type { GenerateRequest } from "../contract.ts";

const FILE = "logs.jsonl";
const MAX_KEEP = 5000; // 超过则裁剪最旧

export interface LogEntry {
	id: string;
	clientTaskId?: string;
	taskId?: string;
	userId?: string;
	userName?: string;
	purpose?: string; // 请求方式 / 在哪一步
	model?: string;
	status: "running" | "success" | "failed";
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	request: unknown; // 完整请求（截断 base64）
	response?: unknown; // 完整响应 / 结果（截断 base64）
	error?: string;
}

// 内存索引（启动加载），写时同步 append；裁剪时整体重写
let logs: LogEntry[] = readJsonl<LogEntry>(FILE);

export function startLog(input: {
	req: GenerateRequest;
	userId?: string;
	userName?: string;
}): LogEntry {
	const entry: LogEntry = {
		id: genId("log"),
		clientTaskId: input.req.clientTaskId,
		userId: input.userId,
		userName: input.userName,
		purpose: input.req.purpose,
		model: input.req.model,
		status: "running",
		startedAt: new Date().toISOString(),
		request: truncateBase64(input.req),
	};
	logs.push(entry);
	appendJsonl(FILE, entry);
	return entry;
}

/** 完成一条日志（更新内存 + 整体重写文件，保证 finishedAt 落盘） */
export function finishLog(
	id: string,
	patch: { status: "success" | "failed"; response?: unknown; error?: string; taskId?: string },
): void {
	const e = logs.find((x) => x.id === id);
	if (!e) return;
	e.status = patch.status;
	e.finishedAt = new Date().toISOString();
	e.durationMs = new Date(e.finishedAt).getTime() - new Date(e.startedAt).getTime();
	if (patch.response !== undefined) e.response = truncateBase64(patch.response);
	if (patch.error) e.error = patch.error;
	if (patch.taskId) e.taskId = patch.taskId;
	if (logs.length > MAX_KEEP) logs = logs.slice(-MAX_KEEP);
	writeJsonl(FILE, logs);
}

export function listLogs(opts?: { limit?: number; offset?: number }): { total: number; items: LogEntry[] } {
	const limit = opts?.limit ?? 50;
	const offset = opts?.offset ?? 0;
	const sorted = [...logs].reverse(); // 最新在前
	return { total: logs.length, items: sorted.slice(offset, offset + limit) };
}

export function getLog(id: string): LogEntry | undefined {
	return logs.find((x) => x.id === id);
}
