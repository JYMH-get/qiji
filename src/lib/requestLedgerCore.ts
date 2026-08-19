/**
 * requestLedgerCore —— 请求台账的纯逻辑层（零依赖可单测）。
 *
 * 背景（第204轮）：请求状态此前只有两种存活形态——内存轮询（taskCenter，关软件即丢）与
 * node.data.task（随项目落盘，但找回只扫**当前激活画布**）。切画布/切项目/删节点后请求
 * 「失去目标」：服务端已成功，客户端却永远收不到，界面停在进行中/初始态。
 *
 * 台账（requestLedger）给每个画布生成请求补上**身份**（项目路径 + 画布 key + 节点 id），
 * 并在应用级（localStorage，独立于任何项目文件）持久化——重启客户端、切换项目、切换画布
 * 都不打断「向服务端取结果」；结果到手后按身份投递：
 *   - 目标节点在激活画布 → 既有断连找回路径（resumeCanvasNodeTasks）完整落盘；
 *   - 目标节点在同项目的非激活画布 → 直写 canvases 快照（媒体落资产 / 文本写正文）；
 *   - 项目未打开 → 结果缓存在台账，待该项目下次加载时投递；
 *   - 项目/画布/节点已被删除 → 转「找回通知」：告知用户任务已完成 + 给出结果链接。
 *
 * 本文件只有纯函数与类型；真正的轮询/投递/持久化在 store/requestLedgerStore.ts。
 */

/** 台账条目状态：pending=在途（还在等服务端终态）；done=已拿到成功结果、等待投递；
 *  orphaned=投递目标已被删除，转为找回通知（用户关闭通知即销账）。
 *  失败/丢失的任务不留台账（无可找回，服务端失败自动退款）。 */
export type LedgerStatus = "pending" | "done" | "orphaned";

export interface LedgerResult {
	/** 服务端资产 id（有则「id 是真理」，投递时按它下载/登记三元映射） */
	assetId?: string;
	/** 媒体结果公网直链（图/视频/音频） */
	url?: string;
	/** 文本类结果正文（截断存储，防 localStorage 膨胀） */
	text?: string;
	/** 服务端未转存的原始时效直链（meta.rehosted=false）——投递时需客户端接力转存 OSS（第158轮） */
	rawLink?: boolean;
}

export interface LedgerEntry {
	/** 服务端任务 id（台账唯一键） */
	taskId: string;
	adapterKey: string;
	/** 项目身份=项目文件绝对路径（项目无稳定 id，savePath 即身份；""=提交时项目尚未落盘） */
	projectPath: string;
	projectName: string;
	/** 画布身份=分集 id（resolveCanvasKey 语义：项目至少一集，激活画布恒有 key） */
	canvasKey: string;
	nodeId: string;
	nodeTitle: string;
	nodeType: string;
	/** 节点显示类型（image/video/audio/text/chat/…）——决定投递方式与通知文案 */
	displayKind: string;
	purpose?: string;
	/** 资产名/前缀（媒体投递时写回项目资产用，与 defaultNodeExecute 同语义） */
	assetName?: string;
	idPrefix?: string;
	submittedAt: number;
	status: LedgerStatus;
	result?: LedgerResult;
	finishedAt?: number;
	/** 孤儿原因：node=节点被删 / canvas=画布（分集）被删 / project=项目被删 */
	orphanReason?: "node" | "canvas" | "project";
}

/** 台账容量上限（超出丢最旧的；正常流转下远达不到） */
export const LEDGER_MAX_ENTRIES = 150;
/** 在途条目寿命：服务端任务终态只留 48h，超过 72h 仍 pending 的条目无从找回，清掉 */
export const LEDGER_PENDING_TTL_MS = 72 * 3600 * 1000;
/** 已完成/孤儿条目寿命（等待投递/等待用户看通知）：30 天 */
export const LEDGER_DONE_TTL_MS = 30 * 24 * 3600 * 1000;
/** 文本结果截断长度（localStorage 友好；超长文本找回以「前 N 字」为准） */
export const LEDGER_TEXT_CAP = 50_000;

const STATUS_SET = new Set<string>(["pending", "done", "orphaned"]);

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** 载入清洗：丢弃形状不对/过期的条目，截断超长文本，按提交时间保最新的 N 条 */
export function sanitizeLedger(raw: unknown, now: number = Date.now()): LedgerEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: LedgerEntry[] = [];
	const seen = new Set<string>();
	for (const it of raw) {
		if (!it || typeof it !== "object") continue;
		const e = it as Record<string, unknown>;
		const taskId = str(e.taskId);
		const adapterKey = str(e.adapterKey);
		const nodeId = str(e.nodeId);
		const status = str(e.status);
		if (!taskId || !adapterKey || !nodeId || !STATUS_SET.has(status)) continue;
		if (seen.has(taskId)) continue;
		const submittedAt = typeof e.submittedAt === "number" && e.submittedAt > 0 ? e.submittedAt : 0;
		if (!submittedAt) continue;
		if (status === "pending" && now - submittedAt > LEDGER_PENDING_TTL_MS) continue;
		if (status !== "pending" && now - submittedAt > LEDGER_DONE_TTL_MS) continue;
		let result: LedgerResult | undefined;
		if (e.result && typeof e.result === "object") {
			const r = e.result as Record<string, unknown>;
			result = {};
			if (str(r.assetId)) result.assetId = str(r.assetId);
			if (str(r.url)) result.url = str(r.url);
			if (str(r.text)) result.text = str(r.text).slice(0, LEDGER_TEXT_CAP);
			if (r.rawLink === true) result.rawLink = true;
		}
		// done/orphaned 但没有任何结果载荷=无从投递也无从通知，直接丢弃
		if (status !== "pending" && (!result || (!result.url && !result.text && !result.assetId))) continue;
		const reason = str(e.orphanReason);
		out.push({
			taskId,
			adapterKey,
			projectPath: str(e.projectPath),
			projectName: str(e.projectName),
			canvasKey: str(e.canvasKey),
			nodeId,
			nodeTitle: str(e.nodeTitle),
			nodeType: str(e.nodeType),
			displayKind: str(e.displayKind) || "text",
			purpose: str(e.purpose) || undefined,
			assetName: str(e.assetName) || undefined,
			idPrefix: str(e.idPrefix) || undefined,
			submittedAt,
			status: status as LedgerStatus,
			result,
			finishedAt: typeof e.finishedAt === "number" ? e.finishedAt : undefined,
			orphanReason: reason === "node" || reason === "canvas" || reason === "project" ? reason : undefined,
		});
		seen.add(taskId);
	}
	out.sort((a, b) => b.submittedAt - a.submittedAt);
	return out.slice(0, LEDGER_MAX_ENTRIES);
}

/** 按 taskId 更新插入：已存在则合并（保留原 submittedAt——重挂/找回不刷新提交时间） */
export function upsertLedgerEntry(list: LedgerEntry[], entry: LedgerEntry): LedgerEntry[] {
	const idx = list.findIndex((e) => e.taskId === entry.taskId);
	if (idx < 0) return [entry, ...list].slice(0, LEDGER_MAX_ENTRIES);
	const prev = list[idx];
	const merged: LedgerEntry = { ...prev, ...entry, submittedAt: prev.submittedAt || entry.submittedAt };
	const next = [...list];
	next[idx] = merged;
	return next;
}

export function removeLedgerEntry(list: LedgerEntry[], taskId: string): LedgerEntry[] {
	return list.filter((e) => e.taskId !== taskId);
}

/** 投递上下文：由调用方从 projectStore/canvasStore 快照组装（纯数据，方便单测） */
export interface DeliveryCtx {
	/** 当前已打开项目的文件路径（null=无已落盘项目在打开状态） */
	loadedProjectPath: string | null;
	/** 当前激活画布 key */
	activeCanvasKey: string | null;
	/** 激活画布（canvasStore 实时）里的节点 id 集 */
	activeNodeIds: ReadonlySet<string>;
	/** 项目 canvases 快照里各画布的节点 id 集（key=画布 key；含激活画布旧快照也无妨，激活优先） */
	canvasNodeIds: Readonly<Record<string, ReadonlySet<string>>>;
	/** 该条目的项目文件已确认不存在（Tauri exists()=false）；浏览器/未确认=false */
	projectMissing?: boolean;
}

export type DeliveryTarget =
	/** 节点在激活画布：优先交给既有 resumeCanvasNodeTasks 完整落盘；台账只兜底直写 */
	| { kind: "active-node" }
	/** 节点在同项目的某块非激活画布（canvasKey=**实际找到**的画布，可能与登记值不同——自愈纠正）：直写 canvases 快照 */
	| { kind: "inactive-node"; canvasKey: string }
	/** 投递目标已删除 → 找回通知 */
	| { kind: "orphan"; reason: "node" | "canvas" | "project" }
	/** 暂无法判定（项目未打开/提交时项目未落盘）：结果留在台账等待 */
	| { kind: "defer"; reason: "project-not-open" | "unsaved-project" };

/** 全画布搜索：激活画布 + 全部画布快照按 nodeId 找（节点 id 全局唯一） */
function findNodeAnywhere(nodeId: string, ctx: DeliveryCtx): DeliveryTarget | null {
	if (ctx.activeNodeIds.has(nodeId)) return { kind: "active-node" };
	for (const key of Object.keys(ctx.canvasNodeIds)) {
		if (key !== ctx.activeCanvasKey && ctx.canvasNodeIds[key].has(nodeId)) return { kind: "inactive-node", canvasKey: key };
	}
	return null;
}

/**
 * 解析投递目标。两条防误判原则（⚠ 第205轮补充2 用户报「换画布被误判删除」后定稿，勿回退）：
 * 1. **只有能证实删除才算孤儿**——项目没打开时无从检查节点存在性，一律 defer；
 * 2. **登记的画布 key 只是线索不是判据**——按 key 找不到时必须**全画布自愈搜索**（激活画布 +
 *    全部画布快照按 nodeId 找）：登记发生时用户可能恰在切换画布/项目导致 key 记错位，
 *    节点本体还在就绝不能报「已删除」；搜到即按真实位置投递（顺带纠正 key）。
 */
export function resolveDeliveryTarget(entry: LedgerEntry, ctx: DeliveryCtx): DeliveryTarget {
	if (ctx.projectMissing) return { kind: "orphan", reason: "project" };

	// 提交时项目尚未落盘（savePath 为空）：只能在当前会话内按节点 id 搜当前项目
	if (!entry.projectPath) {
		return findNodeAnywhere(entry.nodeId, ctx) ?? { kind: "defer", reason: "unsaved-project" };
	}

	if (ctx.loadedProjectPath !== entry.projectPath) return { kind: "defer", reason: "project-not-open" };

	// 项目已打开：先按登记的画布 key 快路径（激活画布以 canvasStore 实时数据为准，其余查快照）
	if (entry.canvasKey && entry.canvasKey === ctx.activeCanvasKey && ctx.activeNodeIds.has(entry.nodeId)) {
		return { kind: "active-node" };
	}
	const snap = entry.canvasKey ? ctx.canvasNodeIds[entry.canvasKey] : undefined;
	if (snap?.has(entry.nodeId) && entry.canvasKey !== ctx.activeCanvasKey) {
		return { kind: "inactive-node", canvasKey: entry.canvasKey };
	}
	// 按 key 没找到：全画布自愈搜索兜底，搜遍仍无才算删除
	const found = findNodeAnywhere(entry.nodeId, ctx);
	if (found) return found;
	return { kind: "orphan", reason: snap || (entry.canvasKey && entry.canvasKey === ctx.activeCanvasKey) ? "node" : "canvas" };
}

/** 孤儿原因 → 用户文案 */
export function orphanReasonLabel(reason: "node" | "canvas" | "project" | undefined): string {
	if (reason === "project") return "项目";
	if (reason === "canvas") return "画布";
	return "节点";
}

/** 结果种类 → 用户文案（通知里「以下是找回的……链接」） */
export function resultKindLabel(displayKind: string): string {
	if (displayKind === "video") return "视频";
	if (displayKind === "image") return "图片";
	if (displayKind === "audio") return "音频";
	return "文本内容";
}

/** 单条孤儿通知正文（措辞按用户定稿） */
export function buildOrphanNoticeText(entry: LedgerEntry): string {
	const what = orphanReasonLabel(entry.orphanReason);
	const kind = resultKindLabel(entry.displayKind);
	const link = entry.result?.url || (entry.result?.text ? "（文本结果见下方，可复制）" : "（结果链接缺失）");
	return `您的任务已完成，但${what}已被您删除，无法找到落盘位置，特此通知。以下是找回的任务/${kind}链接：${link}`;
}
