/**
 * requestLedgerStore —— 请求台账（第204轮）：请求的独立运行空间。
 *
 * 职责（纯逻辑见 lib/requestLedgerCore）：
 *   1. 登记：画布节点提交确认时写入台账（taskId + 项目路径/画布 key/节点 id 身份），
 *      localStorage 持久化——**独立于项目文件**，重启/切项目/切画布都不丢。
 *   2. 全局轮询：登录后对台账里「无人跟踪」的在途任务重挂集中轮询（taskCenter），
 *      不管其项目/画布是否打开——服务端有成功结果，客户端就能取到。
 *   3. 投递：结果按身份找目标——激活画布节点交给既有找回路径；同项目非激活画布直写
 *      canvases 快照；项目未打开则缓存待加载；目标已删 → 找回通知（含结果链接）。
 *
 * ⚠ 与 pluginRegistry.activeCanvasTaskIds 的分工：正在被画布执行/找回流程跟踪的任务
 * 台账**绝不重复挂轮询**（taskCenter handler 按 taskId 唯一，双挂互相顶掉）；台账只接
 * 「画布流程够不着」的任务（非激活画布/项目未打开/节点已删）。
 */
import { create } from "zustand";
import {
	type LedgerEntry,
	type LedgerResult,
	sanitizeLedger,
	upsertLedgerEntry,
	removeLedgerEntry,
	resolveDeliveryTarget,
	type DeliveryCtx,
	LEDGER_TEXT_CAP,
} from "@/lib/requestLedgerCore";
import { trackTask } from "@/services/taskCenter";
import { mergeLedgerForPersist } from "@/lib/projectSyncCore";
import { isPrimaryWindow, isProjectWriter, peersHaveProject } from "@/services/windowSync";

const STORAGE_KEY = "Qiji:requestLedger";

interface RequestLedgerState {
	entries: LedgerEntry[];
	setEntries: (entries: LedgerEntry[]) => void;
}

export const useRequestLedgerStore = create<RequestLedgerState>((set) => ({
	entries: [],
	setEntries: (entries) => set({ entries }),
}));

/* ────────────────────────── 持久化（去抖 + 多窗口合并写） ────────────────────────── */

/** 本窗口见过的 taskId（第205轮多窗口）：localStorage 在窗口间共享，整体覆盖写会清掉别的窗口
 *  的登记——合并规则见 mergeLedgerForPersist（内存为准 + 保留没见过的外来条目 + 见过且已删的不复活） */
const knownTaskIds = new Set<string>();

function readStored(): LedgerEntry[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return sanitizeLedger(raw ? JSON.parse(raw) : []);
	} catch {
		return [];
	}
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistLedger(): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		try {
			const merged = mergeLedgerForPersist(useRequestLedgerStore.getState().entries, readStored(), knownTaskIds);
			localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
		} catch (e) {
			console.warn("[requestLedger] 持久化失败：", e);
		}
	}, 300);
}

function setEntries(next: LedgerEntry[]): void {
	for (const e of next) knownTaskIds.add(e.taskId);
	useRequestLedgerStore.getState().setEntries(next);
	persistLedger();
}

/** 从共享存储吸收其它窗口的登记/结果（tick 前置步骤；本窗口内存条目优先） */
function mergeFromStorage(): void {
	const mine = useRequestLedgerStore.getState().entries;
	const seen = new Set(mine.map((e) => e.taskId));
	const foreign = readStored().filter((e) => !seen.has(e.taskId) && !knownTaskIds.has(e.taskId));
	if (foreign.length) setEntries([...mine, ...foreign]);
}

/* ────────────────────────── 初始化与周期驱动 ────────────────────────── */

let inited = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;

/** 登录后调用（幂等）：从 localStorage 载入台账 + 启动周期驱动（重挂轮询/尝试投递） */
export function initRequestLedger(): void {
	if (inited) return;
	inited = true;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		useRequestLedgerStore.getState().setEntries(sanitizeLedger(raw ? JSON.parse(raw) : []));
	} catch (e) {
		console.warn("[requestLedger] 载入失败（按空台账继续）：", e);
	}
	// 首次驱动延后 2s：让 App 启动的自动加载项目 + resumeCanvasNodeTasks 先占住激活画布的任务
	setTimeout(() => { void tickLedger(); }, 2000);
	if (!tickTimer) tickTimer = setInterval(() => { void tickLedger(); }, 60_000);
}

/** 项目加载/切换画布后调用：目标环境变了，重新认领轮询 + 尝试投递（延后让画布找回先行） */
export function onProjectContextChanged(): void {
	if (!inited) return;
	setTimeout(() => { void tickLedger(); }, 800);
}

async function tickLedger(): Promise<void> {
	try {
		mergeFromStorage(); // 先吸收其它窗口的登记/缓存结果（多窗口共享同一 localStorage）
		await resumeLedgerPolling();
		await attemptDeliverAll();
	} catch (e) {
		console.warn("[requestLedger] tick 失败：", e);
	}
}

/**
 * 多窗口分工（第205轮）：一个条目同一时刻只归一个窗口处理，防重复轮询/重复投递/重复通知。
 * - 条目属于**本窗口打开的项目** → 该项目的「写者」窗口处理（唯一写盘方顺带唯一投递方）；
 * - 条目属于**别的窗口打开的项目** → 让给对方（对方窗口的写者会处理）；
 * - 谁都没打开的项目 → 全局「主窗口」兜底（轮询/项目删除判定/孤儿通知归它）。
 * 单窗口时三个判定全为 true/false 的单窗口语义，行为与第204轮完全一致。
 */
function windowOwnsEntry(e: LedgerEntry): boolean {
	const myPath = lastKnownProjectPath;
	if (e.projectPath && myPath && e.projectPath === myPath) return isProjectWriter();
	if (e.projectPath && peersHaveProject(e.projectPath)) return false;
	if (!e.projectPath) return true; // 未落盘项目的条目只在本会话有意义（第204轮语义不变）
	return isPrimaryWindow();
}

/** 当前项目路径缓存（避免 windowOwnsEntry 里反复动态 import projectStore） */
let lastKnownProjectPath: string | null = null;

/* ────────────────────────── 登记与终态回执（画布流程挂钩） ────────────────────────── */

export interface RegisterLedgerInfo {
	taskId: string;
	adapterKey: string;
	nodeId: string;
	nodeType: string;
	nodeTitle: string;
	displayKind: string;
	purpose?: string;
	assetName?: string;
	idPrefix?: string;
	/**
	 * 请求身份（⚠ 第205轮补充2：必须是**节点执行开始那一刻**捕获的项目/画布——节点必然在
	 * 当时的激活画布上）。缺省回退「登记时刻现读」仅作兼容：提交确认回执到达前用户可能已切换
	 * 画布/项目，现读会把身份记错位 → 完成后误判「节点已被删除」（用户实报的误弹窗根因）。
	 */
	identity?: { projectPath: string; projectName: string; canvasKey: string };
}

/** 提交确认/找回重挂时登记（幂等 upsert）；身份优先用调用方在执行开始时捕获的快照 */
export async function registerCanvasLedgerTask(info: RegisterLedgerInfo): Promise<void> {
	const { useProjectStore } = await import("@/store/projectStore");
	const ps = useProjectStore.getState();
	const canvasKey = info.identity?.canvasKey
		?? (ps.canvasEpisodeId && ps.episodes.some((e) => e.id === ps.canvasEpisodeId)
			? ps.canvasEpisodeId
			: (ps.episodes[0]?.id ?? ""));
	const entry: LedgerEntry = {
		taskId: info.taskId,
		adapterKey: info.adapterKey,
		projectPath: info.identity?.projectPath ?? (ps.savePath ?? ""),
		projectName: info.identity?.projectName ?? ps.name,
		canvasKey,
		nodeId: info.nodeId,
		nodeTitle: info.nodeTitle,
		nodeType: info.nodeType,
		displayKind: info.displayKind,
		purpose: info.purpose,
		assetName: info.assetName,
		idPrefix: info.idPrefix,
		submittedAt: Date.now(),
		status: "pending",
	};
	setEntries(upsertLedgerEntry(useRequestLedgerStore.getState().entries, entry));
}

export interface CanvasTerminalArgs {
	taskId: string;
	success: boolean;
	/** 成功且终态时节点仍在激活画布（随后的落盘代码会写进节点）=正常投递 */
	delivered: boolean;
	resultUri?: string;
	assetId?: string;
	rawLink?: boolean;
}

/**
 * 画布执行/找回流程的终态回执（defaultNodeExecute 终态处调用）：
 * - 成功且已正常落盘 → 销账；
 * - 成功但节点不在激活画布（切画布/被删）→ 结果缓存进台账，立即按身份投递；
 * - 失败 → 销账（无可找回；服务端失败自动退款，节点在则界面已显示错误）。
 */
export async function ledgerOnCanvasTerminal(args: CanvasTerminalArgs): Promise<void> {
	const list = useRequestLedgerStore.getState().entries;
	const entry = list.find((e) => e.taskId === args.taskId);
	if (!entry) return;
	if (!args.success || (args.success && args.delivered)) {
		setEntries(removeLedgerEntry(list, args.taskId));
		return;
	}
	// 成功但画布流程没接住：缓存结果 → 立即投递（切画布=直写快照；被删=找回通知）。
	// 多窗口下本条强制由本窗口投递（force）——结果就在手上，不等写者窗口的周期 tick。
	cacheLedgerResult(args.taskId, buildResult(entry, args.resultUri, args.assetId, args.rawLink));
	await attemptDeliverAll(args.taskId);
}

function buildResult(entry: LedgerEntry, resultUri?: string, assetId?: string, rawLink?: boolean): LedgerResult {
	const isText = entry.displayKind === "text" || entry.displayKind === "chat";
	const r: LedgerResult = {};
	if (assetId) r.assetId = assetId;
	if (isText) r.text = (resultUri ?? "").slice(0, LEDGER_TEXT_CAP);
	else if (resultUri) r.url = resultUri;
	if (rawLink) r.rawLink = true;
	return r;
}

function cacheLedgerResult(taskId: string, result: LedgerResult): void {
	const list = useRequestLedgerStore.getState().entries;
	const entry = list.find((e) => e.taskId === taskId);
	if (!entry) return;
	setEntries(upsertLedgerEntry(list, { ...entry, status: "done", result, finishedAt: Date.now() }));
}

/* ────────────────────────── 全局轮询（画布流程够不着的任务） ────────────────────────── */

/** 台账正在轮询的任务 id（防重复挂；终态释放） */
const ledgerPollingIds = new Set<string>();

async function resumeLedgerPolling(): Promise<void> {
	const pending = useRequestLedgerStore.getState().entries.filter((e) => e.status === "pending");
	if (!pending.length) return;
	// 未配置管理端连接时不挂轮询（poll 必然失败空转）
	const { useConnectionStore } = await import("@/store/connectionStore");
	if (!useConnectionStore.getState().isConfigured()) return;
	// 画布流程正在跟踪的任务绝不双挂（taskCenter handler 按 taskId 唯一）
	const { isCanvasTaskTracked } = await import("@/nodes/pluginRegistry");
	// 先按缓存 catalog 注册适配器（与 resumeCanvasNodeTasks 同款：网络同步未回也能立刻挂上）
	try {
		const { syncManagedAdapters } = await import("@/services/adapters/managedAdapter");
		syncManagedAdapters();
	} catch { /* 无缓存 catalog：适配器缺失由轮询层报错 */ }
	const ctx = await buildDeliveryCtx();
	for (const e of pending) {
		if (!windowOwnsEntry(e)) continue; // 多窗口分工：别的窗口负责的条目不挂轮询
		if (ledgerPollingIds.has(e.taskId) || isCanvasTaskTracked(e.taskId)) continue;
		// 目标在激活画布的在途任务归画布找回流程管（node.data.task 仍在，resumeCanvasNodeTasks 会挂）
		const target = resolveDeliveryTarget(e, { ...ctx, projectMissing: false });
		if (target.kind === "active-node") continue;
		ledgerPollingIds.add(e.taskId);
		trackTask({
			taskId: e.taskId,
			adapterKey: e.adapterKey,
			onUpdate: (_progress, status, resultUri, error, assetId, _partial, rawLink) => {
				if (status !== "success" && status !== "failed" && status !== "lost") return;
				ledgerPollingIds.delete(e.taskId);
				if (status === "success") {
					cacheLedgerResult(e.taskId, buildResult(e, resultUri, assetId, rawLink));
					void attemptDeliverAll();
				} else {
					// 失败/服务端丢任务：无可找回（失败已自动退款），销账
					if (status === "lost") console.warn(`[requestLedger] 任务 ${e.taskId} 服务端已过期，无从找回`);
					else console.warn(`[requestLedger] 任务 ${e.taskId} 失败：${error ?? ""}`);
					setEntries(removeLedgerEntry(useRequestLedgerStore.getState().entries, e.taskId));
				}
			},
		});
	}
}

/* ────────────────────────── 投递 ────────────────────────── */

/** 项目文件存在性检查节流（路径 → 上次检查时间戳；10 分钟一查） */
const projectCheckAt = new Map<string, number>();
const PROJECT_CHECK_INTERVAL = 10 * 60 * 1000;

function isTauri(): boolean {
	return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function projectFileMissing(path: string): Promise<boolean> {
	if (!path || !isTauri()) return false;
	const last = projectCheckAt.get(path);
	if (last && Date.now() - last < PROJECT_CHECK_INTERVAL) return false; // 节流期内按「未确认」处理
	projectCheckAt.set(path, Date.now());
	try {
		const { exists } = await import("@tauri-apps/plugin-fs");
		return !(await exists(path));
	} catch {
		return false; // 检查失败=未确认，不误判删除
	}
}

async function buildDeliveryCtx(): Promise<Omit<DeliveryCtx, "projectMissing">> {
	const { useProjectStore } = await import("@/store/projectStore");
	const { useCanvasStore } = await import("@/store/canvasStore");
	const ps = useProjectStore.getState();
	const cs = useCanvasStore.getState();
	lastKnownProjectPath = ps.savePath;
	const activeCanvasKey = ps.canvasEpisodeId && ps.episodes.some((e) => e.id === ps.canvasEpisodeId)
		? ps.canvasEpisodeId
		: (ps.episodes[0]?.id ?? "");
	const canvasNodeIds: Record<string, ReadonlySet<string>> = {};
	for (const [key, cv] of Object.entries(ps.canvases)) {
		canvasNodeIds[key] = new Set(Object.keys(cv?.nodes ?? {}));
	}
	return {
		loadedProjectPath: ps.savePath,
		activeCanvasKey,
		activeNodeIds: new Set(Object.keys(cs.nodes)),
		canvasNodeIds,
	};
}

let delivering = false;

/**
 * 对所有已完成条目按身份尝试投递（并发保护：一次只跑一轮）。
 * forceTaskId：强制处理该条（多窗口下终态回执的窗口结果在手，不等写者周期 tick）。
 */
export async function attemptDeliverAll(forceTaskId?: string): Promise<void> {
	if (delivering) return;
	delivering = true;
	try {
		const done = useRequestLedgerStore.getState().entries.filter((e) => e.status === "done");
		if (!done.length) return;
		const baseCtx = await buildDeliveryCtx();
		for (const entry of done) {
			if (entry.taskId !== forceTaskId && !windowOwnsEntry(entry)) continue; // 多窗口分工
			try {
				let target = resolveDeliveryTarget(entry, { ...baseCtx, projectMissing: false });
				// 项目未打开：查项目文件是否已被删除（能证实删除才转孤儿）
				if (target.kind === "defer" && target.reason === "project-not-open") {
					if (await projectFileMissing(entry.projectPath)) target = { kind: "orphan", reason: "project" };
				}
				if (target.kind === "defer") continue;
				if (target.kind === "orphan") {
					markOrphanConfirmed(entry, target.reason);
					continue;
				}
				orphanStrikes.delete(entry.taskId); // 找到目标：清孤儿嫌疑
				await deliverToNode(entry, target);
			} catch (e) {
				console.warn(`[requestLedger] 投递失败（下轮重试）task=${entry.taskId}：`, e);
			}
		}
	} finally {
		delivering = false;
	}
}

/** 孤儿嫌疑记录：taskId → 首次判定时间戳（⚠ 两次确认防误报，第205轮补充2 定稿勿回退） */
const orphanStrikes = new Map<string, number>();
const ORPHAN_CONFIRM_MS = 5_000;

/**
 * 孤儿「两次确认」：单次判定绝不弹通知——切画布/切项目的瞬态窗口里（store 正在换血）
 * 一次搜索落空不代表删除；间隔 ≥5s 的第二次判定仍搜不到（含全画布自愈搜索）才转找回通知。
 * 真删除的通知最多晚一个 tick（≤60s），误报归零。
 */
function markOrphanConfirmed(entry: LedgerEntry, reason: "node" | "canvas" | "project"): void {
	const first = orphanStrikes.get(entry.taskId);
	if (!first) {
		orphanStrikes.set(entry.taskId, Date.now());
		return;
	}
	if (Date.now() - first < ORPHAN_CONFIRM_MS) return;
	orphanStrikes.delete(entry.taskId);
	const list = useRequestLedgerStore.getState().entries;
	setEntries(upsertLedgerEntry(list, { ...entry, status: "orphaned", orphanReason: reason }));
}

/** 用户关闭找回通知（或复制完链接）：销账 */
export function dismissLedgerNotice(taskId: string): void {
	setEntries(removeLedgerEntry(useRequestLedgerStore.getState().entries, taskId));
}

/**
 * 把缓存结果直写进目标节点（激活画布=canvasStore；非激活画布=projectStore.canvases 快照）。
 * 幂等防重：节点已被同 id 结果占位（resultAssetId/history 含它）→ 视为已投递只销账；
 * 节点已被重新提交（task.taskId 换人）→ 旧结果作废销账（新任务拥有该节点）。
 */
async function deliverToNode(
	entry: LedgerEntry,
	target: { kind: "active-node" } | { kind: "inactive-node"; canvasKey: string },
): Promise<void> {
	const activeCanvas = target.kind === "active-node";
	// 投递画布 key 以**实际找到节点**的画布为准（登记 key 可能因切换竞态记错位，自愈搜索已纠正）
	const targetKey = target.kind === "inactive-node" ? target.canvasKey : entry.canvasKey;
	// 激活画布且画布流程正在跟踪 → 让画布流程完整落盘（含裂变），台账等它的终态回执
	if (activeCanvas) {
		const { isCanvasTaskTracked } = await import("@/nodes/pluginRegistry");
		if (isCanvasTaskTracked(entry.taskId)) return;
	}
	const node = await readTargetNode(entry, activeCanvas, targetKey);
	if (!node) return; // 环境刚变化（如正在切画布），下轮重试
	const marker = node.data.task;
	if (marker && marker.taskId !== entry.taskId) {
		// 节点已被重新提交：旧结果不再回写（新任务拥有节点），销账
		setEntries(removeLedgerEntry(useRequestLedgerStore.getState().entries, entry.taskId));
		return;
	}

	const isText = entry.displayKind === "text" || entry.displayKind === "chat";
	let written: boolean;
	if (isText) {
		written = await patchTargetNode(entry, targetKey, (data) => {
			const next = { ...data, resultText: entry.result?.text ?? "" };
			delete (next as Record<string, unknown>).task;
			return next;
		});
	} else {
		const assetId = `asset-${entry.taskId}`;
		const already = node.data.resultAssetId === assetId || (node.data.resultHistory ?? []).includes(assetId);
		if (!already) await persistLedgerMediaAsset(entry, assetId);
		written = await patchTargetNode(entry, targetKey, (data) => {
			const hist = [...(data.resultHistory ?? [])];
			if (!already) {
				if (data.resultAssetId && data.resultAssetId !== assetId && !hist.includes(data.resultAssetId)) hist.push(data.resultAssetId);
				if (!hist.includes(assetId)) hist.push(assetId);
			}
			const next = already ? { ...data } : { ...data, resultAssetId: assetId, resultHistory: hist };
			delete (next as Record<string, unknown>).task;
			return next;
		});
	}
	// 写入失败（投递瞬间节点/画布恰好变化）：不销账，留待下一轮重新判定（可能转孤儿通知）
	if (!written) return;
	if (activeCanvas) {
		const { useCanvasStore } = await import("@/store/canvasStore");
		if (useCanvasStore.getState().nodes[entry.nodeId]) {
			useCanvasStore.getState().setRuntime(entry.nodeId, { status: "success", progress: 100, error: null });
		}
	} else {
		// 多窗口（第205轮）：投递写进了非激活画布快照——把该画布广播给其它窗口收敛，
		// 防别的窗口日后切到这块画布时用陈旧快照把投递结果盖掉（激活画布路径由画布订阅自动广播）
		void import("@/services/projectSync").then((m) => m.broadcastCanvasSnapshot(targetKey)).catch(() => {});
	}
	setEntries(removeLedgerEntry(useRequestLedgerStore.getState().entries, entry.taskId));
	const { useProjectStore } = await import("@/store/projectStore");
	useProjectStore.getState().scheduleAutoSave("canvas");
}

type NodeDataShape = import("@/types").NodeData;

async function readTargetNode(entry: LedgerEntry, activeCanvas: boolean, canvasKey: string): Promise<import("@/types").CanvasNode | null> {
	if (activeCanvas) {
		const { useCanvasStore } = await import("@/store/canvasStore");
		return useCanvasStore.getState().nodes[entry.nodeId] ?? null;
	}
	const { useProjectStore } = await import("@/store/projectStore");
	const cv = useProjectStore.getState().canvases[canvasKey];
	return cv?.nodes?.[entry.nodeId] ?? null;
}

/**
 * 目标节点数据补丁（返回是否写入成功）：写入时**现查**——投递期间用户可能恰好切换画布。
 * 节点 id 全局唯一：激活画布（canvasStore 实时层）里有它就写实时层，否则写 canvasKey 指定的
 * 快照。两处都找不到=失败（不销账，下轮重判——可能转孤儿两次确认）。
 */
async function patchTargetNode(
	entry: LedgerEntry,
	canvasKey: string,
	mutate: (data: NodeDataShape) => NodeDataShape,
): Promise<boolean> {
	const { useProjectStore } = await import("@/store/projectStore");
	const { useCanvasStore } = await import("@/store/canvasStore");
	const cs = useCanvasStore.getState();
	const live = cs.nodes[entry.nodeId];
	if (live) {
		useCanvasStore.setState({ nodes: { ...cs.nodes, [entry.nodeId]: { ...live, data: mutate(live.data) } } });
		return true;
	}
	const ps = useProjectStore.getState();
	const cv = ps.canvases[canvasKey];
	const n = cv?.nodes?.[entry.nodeId];
	if (!n) return false;
	useProjectStore.setState({
		canvases: {
			...ps.canvases,
			[canvasKey]: { ...cv, nodes: { ...cv.nodes, [entry.nodeId]: { ...n, data: mutate(n.data) } } },
		},
		isDirty: true,
	});
	return true;
}

/**
 * 媒体结果落地（与 defaultNodeExecute 媒体完成分支同语义）：本地副本 → rawLink 接力转存 OSS →
 * rehost 兜底 → 三元映射登记 → 项目媒体库登记 → 资产名写回项目资产（主图/变体）。
 * 返回显示 uri（全部失败时回退远程 url——与既有路径同规）。
 */
async function persistLedgerMediaAsset(entry: LedgerEntry, assetId: string): Promise<string> {
	const remoteUrl = entry.result?.url ?? "";
	const rawLink = !!entry.result?.rawLink;
	let displayUri = remoteUrl;
	let localPath: string | null = null;
	let serverAssetId: string | null = entry.result?.assetId ?? null;
	try {
		const { saveRemoteAsset, uploadBlobToOss } = await import("@/services/assetPersist");
		const { useProjectStore } = await import("@/store/projectStore");
		// 已有活映射（如同会话内在途路径已下载过）→ 直接复用，不重复下载
		const known = serverAssetId ? useProjectStore.getState().assetBlobs[serverAssetId] : undefined;
		let blob = known?.localUri ? known : null;
		if (!blob && remoteUrl) {
			const dl = rawLink
				? (entry.displayKind === "video" ? { attempts: 2, timeoutSecs: 120 } : { attempts: 3, timeoutSecs: 30 })
				: undefined;
			blob = await saveRemoteAsset(serverAssetId || assetId, remoteUrl, dl);
			if (blob && rawLink) {
				const upPrefix = entry.idPrefix || (entry.displayKind === "video" ? "video" : "TP");
				const upName = entry.assetName || `${entry.nodeType}_output`;
				const beforeId = blob.id;
				blob = await uploadBlobToOss(blob, upName, upPrefix, entry.taskId);
				if (blob.id !== beforeId) serverAssetId = blob.id;
			}
			if (!blob && /^https?:\/\//i.test(remoteUrl)) {
				const { managedClient } = await import("@/services/managedClient");
				const re = await managedClient.rehost(remoteUrl, undefined, `${entry.nodeType}_output`);
				if (re?.url) blob = await saveRemoteAsset(re.id, re.url);
			}
		}
		if (blob) {
			useProjectStore.getState().registerAssetBlob(blob);
			displayUri = blob.localUri || remoteUrl;
			localPath = blob.localPath || null;
		}
	} catch (e) {
		console.warn(`[requestLedger] 结果落盘失败（按远程链接投递）task=${entry.taskId}：`, e);
	}
	const { useLibraryStore } = await import("@/store/libraryStore");
	useLibraryStore.getState().addAsset({
		id: assetId,
		kind: (entry.displayKind as "image" | "video" | "audio") || "image",
		name: entry.assetName || `${entry.nodeType}_output_${Date.now()}`,
		uri: displayUri,
		serverAssetId,
		thumbnailUri: null,
		createdAt: new Date().toISOString(),
		deletedByUser: false,
		localPath,
		origin: "generated",
		// 分集归属（三模同步）：台账身份里的画布 key 即分集 id（实时剪辑素材页按分集过滤）
		episodeId: entry.canvasKey || null,
	});
	// 资产名写回项目资产（与 defaultNodeExecute 同规则：变体「父名 · 造型名」找不到造型则不写）
	if (entry.assetName && entry.displayKind === "image") {
		try {
			const { useProjectStore } = await import("@/store/projectStore");
			const PREFIX_CAT: Record<string, "characters" | "crowds" | "scenes" | "organisms" | "items"> = {
				C: "characters", A: "characters", G: "crowds", S: "scenes", M: "organisms", P: "items",
			};
			const cat = PREFIX_CAT[entry.idPrefix ?? ""] ?? "characters";
			const ps2 = useProjectStore.getState();
			const arr = (ps2[cat] || []) as Array<{ id: string; name: string; variants?: Array<{ id: string; label?: string; name?: string }> }>;
			const [baseName, variantLabel] = entry.assetName.split(" · ").map((s) => s.trim());
			const parent = arr.find((a) => String(a.name).trim() === baseName);
			if (parent) {
				let variantId: string | null = null;
				let variantOk = true;
				if (variantLabel) {
					const v = (parent.variants || []).find(
						(x) => String(x.label || "").trim() === variantLabel || String(x.name || "").trim() === variantLabel || String(x.name || "").trim() === entry.assetName,
					);
					if (v) variantId = v.id;
					else variantOk = false;
				}
				if (variantOk) ps2.addAssetImage(cat, parent.id, variantId, displayUri, true);
			}
		} catch (e) {
			console.warn(`[requestLedger] 结果写回项目资产失败 task=${entry.taskId}：`, e);
		}
	}
	return displayUri;
}
