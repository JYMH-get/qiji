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

/** 步骤 purpose 的中文代称（与客户端 purposeRegistry / admin PURPOSE_LABELS 对应） */
export const PURPOSE_LABELS: Record<string, string> = {
	"script.toScenes": "小说转剧本",
	"script.analyze": "剧本分析",
	"storyboard.split": "剧本分镜",
	"storyboard.toVideoPrompt": "视频提示词",
	"asset.character.image": "角色出图",
	"asset.character.variant": "角色变体",
	"asset.scene.image": "场景出图",
	"asset.scene.variant": "场景变体",
	"asset.creature.image": "生物出图",
	"asset.creature.variant": "生物变体",
	"asset.prop.image": "物品出图",
	"asset.prop.variant": "物品变体",
	"video.generate": "视频生成",
	"audio.tts": "语音合成",
};
const purposeLabel = (p?: string) => (p ? PURPOSE_LABELS[p] || p : "");

export interface LogEntry {
	id: string;
	clientTaskId?: string;
	taskId?: string;
	userId?: string;
	userName?: string;
	purpose?: string; // 请求方式 / 在哪一步
	model?: string;
	cost?: number; // 本次消耗积分（model.cost）
	status: "running" | "success" | "failed";
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	request: unknown; // ① 用户 → 管理端 的完整请求（截断 base64）
	response?: unknown; // ② 管理端 → 用户 的完整响应 / 结果（截断 base64）
	upstreamRequest?: unknown; // ③ 管理端 → 上游(网关/第三方) 的请求体
	upstreamResponse?: unknown; // ④ 上游 → 管理端 的原始响应
	error?: string;
}

// 内存索引（启动加载），写时同步 append；裁剪时整体重写
let logs: LogEntry[] = readJsonl<LogEntry>(FILE);

export function startLog(input: {
	req: GenerateRequest;
	userId?: string;
	userName?: string;
	cost?: number;
}): LogEntry {
	const entry: LogEntry = {
		id: genId("log"),
		clientTaskId: input.req.clientTaskId,
		userId: input.userId,
		userName: input.userName,
		purpose: input.req.purpose,
		model: input.req.model,
		cost: input.cost,
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

/** 记录上游(管理端↔网关/第三方)的请求体与原始响应；可多次调用（合并）。 */
export function attachUpstream(id: string, rec: { request?: unknown; response?: unknown }): void {
	const e = logs.find((x) => x.id === id);
	if (!e) return;
	if (rec.request !== undefined) e.upstreamRequest = truncateBase64(rec.request);
	if (rec.response !== undefined) e.upstreamResponse = truncateBase64(rec.response);
	writeJsonl(FILE, logs);
}

export function listLogs(opts?: {
	limit?: number;
	offset?: number;
	from?: number; // startedAt ≥ from（epoch ms）
	to?: number; // startedAt < to（epoch ms）
	userName?: string;
	purpose?: string;
	model?: string;
}): { total: number; items: LogEntry[] } {
	const limit = opts?.limit ?? 50;
	const offset = opts?.offset ?? 0;
	// 文本筛选一律「不区分大小写的包含」；步骤同时匹配中文代称与原 purpose
	const has = (hay: string, needle?: string) => !needle || hay.toLowerCase().includes(needle.toLowerCase());
	let arr = logs;
	if (opts?.from != null) arr = arr.filter((l) => new Date(l.startedAt).getTime() >= opts.from!);
	if (opts?.to != null) arr = arr.filter((l) => new Date(l.startedAt).getTime() < opts.to!);
	if (opts?.userName) arr = arr.filter((l) => has(l.userName || "", opts.userName));
	if (opts?.purpose) arr = arr.filter((l) => has((l.purpose || "") + " " + purposeLabel(l.purpose), opts.purpose));
	if (opts?.model) arr = arr.filter((l) => has(l.model || "", opts.model));
	const sorted = [...arr].reverse(); // 最新在前
	return { total: arr.length, items: sorted.slice(offset, offset + limit) };
}

/** 筛选下拉的可选值（去重，取全量日志） */
export function logFacets(): { users: string[]; purposes: string[]; models: string[] } {
	const u = new Set<string>();
	const p = new Set<string>();
	const m = new Set<string>();
	for (const l of logs) {
		if (l.userName) u.add(l.userName);
		if (l.purpose) p.add(l.purpose);
		if (l.model) m.add(l.model);
	}
	return { users: [...u].sort(), purposes: [...p].sort(), models: [...m].sort() };
}

export function getLog(id: string): LogEntry | undefined {
	return logs.find((x) => x.id === id);
}
