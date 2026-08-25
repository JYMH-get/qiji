/**
 * 任务存储（内存索引 + tasks.json 落盘）。
 *
 * 同步任务（真文本翻译器）直接在 /generate 返回结果、不入表。
 * 异步任务（图/视频/音频，本阶段为桩）入表，按时间推进四态：queued→running→success。
 *
 * 持久化：结构性变更（创建/计费/续轮询信息/终态）即落盘；流式字段（partialText/进度）不落盘。
 * 重启后任务表原样恢复——终态任务客户端仍可轮询到结果；待办任务交由启动对账
 * （reconcile.ts）处理：视频有上游 task_id 的续轮询，其余判失败并凭落盘的计费信息退款。
 */
import { loadJson, scheduleSave } from "./db.ts";
import { scrubChannelInfo } from "../errorScrub.ts";
import type { Capability, TaskState, TaskStatus, AssetOut } from "../contract.ts";

/** 视频续轮询信息：重启后凭此恢复对上游的轮询（不重提交、不重扣费） */
export interface TaskResume {
	kind: "video";
	/** 协议 id（内置 jianmeng-video/openai-video/volc-mediakit 或自定义协议 id），决定用哪套 poll 驱动 */
	protocol: string;
	/** 上游返回的任务 id */
	upstreamTaskId: string;
	/** 逻辑模型 id（重启后重新解析上游地址/密钥，密钥不落盘） */
	model: string;
	purpose?: string;
	params?: Record<string, unknown>;
	/** 结果能力（视频=转存 OSS；图/音=下载落资产）。缺省视频，兼容旧落盘记录 */
	capability?: Capability;
}

export interface TaskRecord {
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
	/** 排队位次（1 基）+ 同队总数（第251轮，仅服务端自有队列=奇迹云实例池）。
	 *  ⚠ 瞬时态**不落盘**（persist 里与 partialText/partialProgress 一并剔除）。 */
	queuePosition?: number;
	queueTotal?: number;
	/** 服务端阶段文案（通用通道）：同为瞬时态不落盘 */
	stageText?: string;
	/** 排队毫秒（第251轮）：派单那刻定格，**要落盘**——终态收尾写进请求记录（「实际生成（排队）」） */
	queuedMs?: number;
	/** 计费信息：异步任务受理时预扣的积分；后台失败时据此退款（一次性，refunded 防重复退）。
	 *  agents：归属链各级渠道商的结算侧扣款（第124轮层级，直属商→上级商，失败逐级退回积分池）；
	 *  agentId/agentCost：第124轮前的单商旧字段，仅为读回存量落盘任务保留（退款兼容两种形态）；
	 *  payerId（第172轮团队共享积分）：实际扣款人（共享模式=团长），退款退给它；缺省=userId 本人。
	 *  userId 恒为实际发起请求的用户（「本人任务」校验/消耗统计归属都按它）。 */
	billing?: { userId: string; payerId?: string; cost: number; refunded: boolean; agents?: { id: string; cost: number }[]; agentId?: string; agentCost?: number };
	/** 对应的请求日志 id：重启对账时收尾日志用 */
	logId?: string;
	/** 终态时间（epoch ms）：落盘裁剪与 finishedAt 回显用 */
	finishedAt?: number;
	/** 视频续轮询信息（提交上游成功后写入；终态后无用但保留无害） */
	resume?: TaskResume;
}

let _seq = 0;
const tasks = new Map<string, TaskRecord>();

// ── 持久化 ──
const FILE = "tasks.json";
const KEEP_TERMINAL_MS = 48 * 3600 * 1000; // 终态记录保留 48 小时（供客户端重启后补取结果）
const MAX_TERMINAL = 1000; // 终态记录条数上限（防文件无限膨胀）

const isPending = (t: TaskRecord): boolean => !!t.awaitingReal && !t.doneStatus;

/** 结构性变更后落盘（顺带按时限/条数裁剪终态记录，内存与文件同尺；流式字段不落盘） */
function persist(): void {
	const now = Date.now();
	const terminal = [...tasks.values()]
		.filter((t) => !isPending(t))
		.sort((a, b) => (b.finishedAt ?? b.submittedAt) - (a.finishedAt ?? a.submittedAt));
	const keep = new Set(
		terminal
			.filter((t) => now - (t.finishedAt ?? t.submittedAt) < KEEP_TERMINAL_MS)
			.slice(0, MAX_TERMINAL)
			.map((t) => t.taskId),
	);
	for (const t of terminal) if (!keep.has(t.taskId)) tasks.delete(t.taskId);
	// 裁剪（内存 Map 操作）同步完成；stringify + 写盘防抖异步化，不阻塞 event loop。
	// serialize 在落盘时才跑，读取当时最新的内存状态。
	scheduleSave(FILE, () => {
		// ⚠ 瞬时态一律不落盘：partialText/partialProgress（流式）+ queuePosition/queueTotal/stageText
		//   （排队位次每拍都变，落了只会污染 tasks.json）。queuedMs 是要留的——终态记录取它。
		const rows = [...tasks.values()].map(({ partialText, partialProgress, queuePosition, queueTotal, stageText, ...rest }) => rest);
		return JSON.stringify({ seq: _seq, tasks: rows });
	});
}

// 启动加载：恢复任务表与 id 序号（待办任务的续轮询/失败退款由 reconcileOnStartup 处理）
{
	const saved = loadJson<{ seq?: number; tasks?: TaskRecord[] }>(FILE, {});
	let scrubbed = false;
	if (Array.isArray(saved.tasks)) {
		for (const t of saved.tasks) {
			if (!t?.taskId) continue;
			// 第168轮：存量错误文案补擦渠道识别信息（幂等；终态仅留 48h、量小，每次启动过一遍即可）
			if (t.error) {
				const s = scrubChannelInfo(t.error);
				if (s !== t.error) { t.error = s; scrubbed = true; }
			}
			tasks.set(t.taskId, t);
		}
	}
	const maxId = Math.max(0, ...[...tasks.keys()].map((k) => Number(k.replace(/^t/, "")) || 0));
	_seq = Math.max(saved.seq ?? 0, maxId);
	if (scrubbed) persist();
}

/** 待办任务（在途异步）：启动对账用 */
export function listPendingTasks(): TaskRecord[] {
	return [...tasks.values()].filter(isPending);
}

/** 视频提交上游成功后登记续轮询信息（随任务落盘） */
export function setTaskResume(taskId: string, resume: TaskResume): void {
	const rec = tasks.get(taskId);
	if (!rec) return;
	rec.resume = resume;
	persist();
}

/**
 * 退款钩子：异步任务后台失败时退回预扣积分。
 * 用注册钩子而非直接 import users，避免 tasks → users 的循环依赖（启动时由 routes 注册）。
 *
 * ⚠ 第183轮：由原先「用户钩子 + 渠道商钩子」两把分开的尺，合成**一把**——退款必须
 * 「用户侧 + 归属链各级」同进同出，分两次调用等于把原子性在退款侧又漏了一遍。
 * 实现在 store/credits.ts settle()，一次结算一条流水。
 */
type ReverseFn = (b: { userId: string; payerId?: string; cost: number; agents: { id: string; cost: number }[]; ref?: string }) => void;
let reverseHook: ReverseFn | null = null;
export function setBillingReverseHook(fn: ReverseFn): void {
	reverseHook = fn;
}

/**
 * 按计费信息执行一次性退款（用户 + 归属链各级渠道商；refunded 随盘防重复退）。
 * failTask（失败在计费之后）与 setTaskBilling（失败抢在计费之前，见下）共用同一把尺。
 */
function refundBilling(rec: TaskRecord): void {
	if (!rec.billing || rec.billing.refunded || !reverseHook) return;
	const agents = (rec.billing.agents ?? []).filter((a) => a.id && a.cost > 0);
	// 存量落盘任务的单商旧字段（第124轮前）兼容退回
	if (rec.billing.agentId && rec.billing.agentCost) {
		agents.push({ id: rec.billing.agentId, cost: rec.billing.agentCost });
	}
	reverseHook({
		userId: rec.billing.userId,
		payerId: rec.billing.payerId,
		cost: rec.billing.cost > 0 ? rec.billing.cost : 0,
		agents,
		ref: rec.taskId,
	});
	rec.billing.refunded = true;
}

/** 受理异步任务并扣费后调用：记录计费信息（落盘，重启后退款不丢），供失败时退款。
 *  agents=归属链各级渠道商的实扣（仅记 >0 的级）；payerId=实际扣款人（团队共享模式=团长，缺省=本人） */
export function setTaskBilling(taskId: string, userId: string, cost: number, agents?: { id: string; cost: number }[], payerId?: string): void {
	const rec = tasks.get(taskId);
	const charged = (agents ?? []).filter((a) => a.cost > 0);
	if (rec && (cost > 0 || charged.length > 0)) {
		rec.billing = { userId, cost, refunded: false, agents: charged.length ? charged : undefined, payerId: payerId && payerId !== userId ? payerId : undefined };
		// ⚠ 快失败竞态补退（2026-07-23 实锤，勿回退）：翻译器**同步守卫**失败（未配上游密钥/素材守卫/
		// 缺 Base URL 等不经 await 直接返回的错误）时，failTask 以微任务身份抢在 routes 的 applyBilling/
		// 本函数之前执行——那一刻 billing 还没挂上、退款空转，随后这里才把用户+渠道商链的钱扣实，
		// 且再无人回头退（启动对账只管待办任务）。故计费登记发现任务已是失败终态 → 当场补退。
		if (rec.doneStatus === "failed") refundBilling(rec);
		persist();
	}
}

export function nextTaskId(): string {
	_seq += 1;
	return `t${String(_seq).padStart(8, "0")}`;
}

export function createTask(rec: Omit<TaskRecord, "taskId" | "submittedAt">): TaskRecord {
	const full: TaskRecord = { ...rec, taskId: nextTaskId(), submittedAt: Date.now() };
	tasks.set(full.taskId, full);
	persist();
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
		finishedAt: Date.now(),
		capability,
		clientTaskId,
		doneStatus: status,
		doneResult: result,
		// 第168轮：错误文案落盘前擦除渠道识别信息（会经 /v1/tasks 下发给用户）
		error: error ? scrubChannelInfo(error) : error,
	};
	tasks.set(full.taskId, full);
	persist();
	return full;
}

/** 真实异步任务：返回 taskId，后台完成后调用 completeTask/failTask 写入终态 */
export function createRunningTask(
	capability: Capability,
	clientTaskId?: string,
	logId?: string,
): TaskRecord {
	const full: TaskRecord = {
		taskId: nextTaskId(),
		submittedAt: Date.now(),
		capability,
		clientTaskId,
		awaitingReal: true,
		logId,
	};
	tasks.set(full.taskId, full);
	persist();
	return full;
}

/** 流式文本：边流边写已累积正文与进度（轮询可见部分文本+进度） */
export function appendTaskText(taskId: string, fullText: string, progress?: number): void {
	const rec = tasks.get(taskId);
	if (!rec) return;
	rec.partialText = fullText;
	rec.partialProgress = progress ?? Math.min(95, (rec.partialProgress ?? 10) + 1);
}

/**
 * 仅更新进度（异步视频轮询用）：终态前显示推进。
 * 第251轮：可选第三参带排队情报/阶段文案/排队毫秒（其余 23 个视频驱动不传，签名前两参未动=零改动）。
 * ⚠ 位次字段一律「有则写、无则清」——任务从排队进入生成后必须把上一拍的位次抹掉，否则客户端一直显示排队。
 */
export function setTaskProgress(
	taskId: string,
	progress: number,
	extra?: { queuePosition?: number; queueTotal?: number; stageText?: string; queuedMs?: number },
): void {
	const rec = tasks.get(taskId);
	if (!rec) return;
	rec.partialProgress = Math.max(0, Math.min(95, progress));
	rec.queuePosition = extra?.queuePosition;
	rec.queueTotal = extra?.queueTotal;
	rec.stageText = extra?.stageText;
	// queuedMs 一旦定格就不再变（后续拍次没带也别抹掉）
	if (extra?.queuedMs !== undefined) rec.queuedMs = extra.queuedMs;
}

export function completeTask(taskId: string, result: TaskState["result"]): void {
	const rec = tasks.get(taskId);
	if (rec) {
		rec.doneStatus = "success";
		rec.doneResult = result;
		rec.finishedAt = Date.now();
		persist();
	}
}

/**
 * 第158轮：客户端接力转存完成后改写任务响应体——把 rehosted:false 的「上游原始时效直链」结果
 * 替换为客户端经 POST /v1/assets 传回的真 OSS 台账资产（rehosted→true，url/id 就地更新并落盘）。
 * 意义：①断连找回/重连原任务再取结果拿到的是永久直链（客户端见 rehosted≠false 走正常路径，
 * 不再重复「下载+上传」产出重复资产）；②任务落盘记录与请求日志从此指向有效链接。
 * 仅允许：本人任务（billing.userId 匹配；无计费信息的任务不校验）+ 终态 success + 首资产 rehosted===false。
 */
export function rewriteTaskRawResult(
	taskId: string,
	userId: string,
	asset: { id: string; url: string },
): { ok: true; logId?: string; result: TaskState["result"] } | { ok: false; reason: "not_found" | "forbidden" | "not_rewritable" } {
	const rec = tasks.get(taskId);
	if (!rec) return { ok: false, reason: "not_found" };
	if (rec.billing?.userId && rec.billing.userId !== userId) return { ok: false, reason: "forbidden" };
	const a0 = rec.doneResult?.assets?.[0];
	if (rec.doneStatus !== "success" || !a0 || (a0.meta as { rehosted?: unknown } | undefined)?.rehosted !== false) {
		return { ok: false, reason: "not_rewritable" };
	}
	rec.doneResult!.assets![0] = {
		...a0,
		id: asset.id,
		url: asset.url,
		meta: { ...(a0.meta ?? {}), rehosted: true, transcodedBy: "client" },
	};
	persist();
	return { ok: true, logId: rec.logId, result: rec.doneResult };
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
			finishedAt: new Date(rec.finishedAt ?? Date.now()).toISOString(),
			result: rec.doneResult,
			error: rec.error,
		};
	}

	// 真实异步任务：终态前恒为 running，等后台回填（流式文本回传部分正文+进度）
	// ⚠ 排队中也维持 status="running"（不改成 "queued"）：客户端按 queuePosition 有无切文案，
	//   动 status 会牵动一堆在途/终态判定，风险不对等（第251轮定稿）。
	if (rec.awaitingReal) {
		return {
			taskId: rec.taskId,
			clientTaskId: rec.clientTaskId,
			status: "running",
			progress: rec.partialProgress ?? 50,
			submittedAt: new Date(rec.submittedAt).toISOString(),
			result: rec.partialText ? { text: rec.partialText } : undefined,
			queuePosition: rec.queuePosition,
			queueTotal: rec.queueTotal,
			stageText: rec.stageText,
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
	if (!rec) return;
	rec.doneStatus = "failed";
	// 第168轮：错误文案落盘前擦除渠道识别信息（会经 /v1/tasks 下发给用户/渠道商）
	rec.error = scrubChannelInfo(error);
	rec.finishedAt = Date.now();
	// 失败退款：异步任务受理时已预扣，后台失败则退回（一次性；refunded 随盘防重启后重复退）。
	// 渠道商用户链式扣费（第124轮）：用户积分与归属链各级渠道商的结算积分同退。
	// 快失败竞态（billing 尚未挂上就走到这里）由 setTaskBilling 侧补退，两处共用 refundBilling 一把尺。
	refundBilling(rec);
	persist();
}
