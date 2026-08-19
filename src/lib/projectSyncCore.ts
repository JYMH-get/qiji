/**
 * projectSyncCore —— 多窗口实时同步的纯逻辑层（零依赖可单测）。
 *
 * 背景（第205轮）：客户端多开此前是完全独立的进程——同项目在两个窗口打开时不但互不同步，
 * 还会**整文件互相覆盖**（两边都对 project.Qiji 做原子保存，last-writer-wins，后保存的窗口
 * 会把对方的改动从磁盘上抹掉）。用户定稿：档2 实时同步——单实例多窗口 + 状态广播；
 * 同设备单人操作、**按分集画布分工**（一块画布同一时刻只有一个窗口在编辑，其它窗口实时看）。
 *
 * 同步模型（快照广播，非命令重放——契合「各编各的画布」的归属假设）：
 *   - 每个窗口只广播**自己激活画布**的快照（它的归属域）+ 自己改动过的项目级共享字段；
 *   - 接收方：该画布正是我的激活画布 → 直写 canvasStore（实时可见，含节点运行态 runtime）；
 *     否则写进 projectStore.canvases 快照（切过去即最新）；
 *   - 写盘收敛「单写者」：同项目多窗口时只有写者窗口落盘（状态已镜像到写者，根治互相覆盖）。
 *
 * 本文件：共享字段清单 / 引用级 diff / 写者选举 / 在场清理 / 画布清理 / 台账合并写盘规则。
 */

/** 项目级共享字段（projectStore 顶层键）：任一窗口改动即广播、接收方 setState 镜像。
 *  刻意不含：savePath（身份）、canvasEpisodeId（每窗口各看各的画布）、canvases（按画布单独同步）、
 *  uiSnapshot（每窗口自己的停留页）、recentProjects/isDirty/isSaving 等窗口本地态。 */
export const SHARED_PROJECT_FIELDS = [
	"name",
	"scriptText",
	"visualStyle",
	"visualStyleId",
	"visualBible",
	"coverImage",
	"characters",
	"scenes",
	"items",
	"organisms",
	"crowds",
	"isAnalyzed",
	"analysisTime",
	"libtvCanvasUuid",
	"episodes",
	"pendingGens",
	"inferTasks",
	"analysisTask",
	"assetBlobs",
	"genMeta",
	"assetRefImages",
	"projectModelConfig",
	"mediaSettings",
	// 实时剪辑分集档位表（整表镜像；rtcEpisodeId 是窗口本地态刻意不共享——两窗口可各看各的分集。
	// ⚠ 边界：两窗口**同时编辑不同分集**时整表 last-writer-wins（250ms 去抖窗口内可能互覆），
	// 与画布「一块画布同一时刻一个窗口在编」同一分工假设）
	"rtcDocs",
] as const;

export type SharedProjectField = (typeof SHARED_PROJECT_FIELDS)[number];

/** 引用级 diff：zustand 不可变更新惯例下，字段引用变了=内容变了（同引用绝不深比较，零开销） */
export function diffByRef<T extends Record<string, unknown>>(
	prev: T,
	next: T,
	keys: readonly string[],
): string[] {
	const changed: string[] = [];
	for (const k of keys) {
		if (prev[k] !== next[k]) changed.push(k);
	}
	return changed;
}

/** 窗口在场信息（心跳广播；presence 表按 lastSeen 清理） */
export interface PeerInfo {
	windowId: string;
	/** 窗口启动时间戳（选举排序主键：先开的窗口当写者/主窗口） */
	openedAt: number;
	/** 该窗口当前打开的项目路径（""=无已落盘项目） */
	projectPath: string;
	/** 该窗口当前激活画布 key */
	activeCanvasKey: string;
	lastSeen: number;
}

/** 心跳周期 / 掉线判定（3 个心跳周期没消息=窗口已关/假死，从在场表剔除） */
export const PEER_HEARTBEAT_MS = 5_000;
export const PEER_TTL_MS = PEER_HEARTBEAT_MS * 3;

/** 剔除超时窗口 */
export function prunePeers(peers: PeerInfo[], now: number): PeerInfo[] {
	return peers.filter((p) => now - p.lastSeen <= PEER_TTL_MS);
}

/**
 * 选举（确定性，无协商）：openedAt 最小者当选；并列按 windowId 字典序。
 * 所有窗口按同一份在场表独立算，结论一致——先开的窗口是写者/主窗口，关掉后自动顺延。
 * candidates 须包含自己；空数组返回 null。
 */
export function pickLeader(candidates: Array<{ windowId: string; openedAt: number }>): string | null {
	if (!candidates.length) return null;
	let best = candidates[0];
	for (const c of candidates.slice(1)) {
		if (c.openedAt < best.openedAt || (c.openedAt === best.openedAt && c.windowId < best.windowId)) best = c;
	}
	return best.windowId;
}

/**
 * 画布快照表清理：分集被删（episodes 同步过来少了 key）时把对应画布数据一并剔除，
 * 防写者把已删分集的画布重新写回文件。activeKey 恒保留（正在看的画布不许被清）。
 */
export function pruneCanvasesToEpisodes<T>(
	canvases: Record<string, T>,
	episodeIds: readonly string[],
	activeKey: string,
): Record<string, T> {
	const keep = new Set<string>(episodeIds);
	keep.add(activeKey);
	let changed = false;
	const out: Record<string, T> = {};
	for (const [k, v] of Object.entries(canvases)) {
		if (keep.has(k)) out[k] = v;
		else changed = true;
	}
	return changed ? out : canvases;
}

/* ────────────────────────── 同步消息（窗口间广播载荷） ────────────────────────── */

export interface SyncMsgBase {
	senderId: string;
	projectPath: string;
}

/** 新窗口打开项目/切换项目：向同项目窗口报到，写者应回 full 全量镜像 */
export interface HelloMsg extends SyncMsgBase { type: "hello" }

/** 项目级共享字段补丁 */
export interface FieldsMsg extends SyncMsgBase { type: "fields"; fields: Record<string, unknown> }

/** 发送方激活画布快照（含节点运行态——另一窗口能看见「生成中」） */
export interface CanvasMsg extends SyncMsgBase {
	type: "canvas";
	canvasKey: string;
	nodes: Record<string, unknown>;
	edges: Record<string, unknown>;
	groups: Record<string, unknown>;
	runtime: Record<string, unknown>;
}

/** 项目媒体库（libraryStore.assets）镜像 */
export interface LibraryMsg extends SyncMsgBase { type: "library"; assets: Record<string, unknown> }

/** 写者对 hello 的全量回执（只有 targetId 应用；新窗口从磁盘载入的可能落后写者内存态） */
export interface FullMsg extends SyncMsgBase {
	type: "full";
	targetId: string;
	fields: Record<string, unknown>;
	canvases: Record<string, unknown>;
	library: Record<string, unknown>;
	/** 发送方激活画布的节点运行态（新窗口切到该画布即可见「生成中」） */
	runtimes: Record<string, Record<string, unknown>>;
}

/** 非写者窗口的手动保存请求：转给写者落盘 */
export interface SaveRequestMsg extends SyncMsgBase { type: "save-request" }

export type SyncMsg = HelloMsg | FieldsMsg | CanvasMsg | LibraryMsg | FullMsg | SaveRequestMsg;

/** 消息是否与本窗口的当前项目相关（projectPath 空=项目未落盘，不参与跨窗口同步） */
export function msgMatchesProject(msg: SyncMsgBase, myProjectPath: string | null): boolean {
	return !!msg.projectPath && !!myProjectPath && msg.projectPath === myProjectPath;
}

/* ────────────────────────── 请求台账多窗口合并写盘 ────────────────────────── */

/**
 * 台账 localStorage 在多窗口间共享（同 WebView2 profile 同源）——各窗口的内存台账独立、
 * 直接整体覆盖写会互相清掉对方的登记。合并规则：
 *   - 本窗口内存里的条目：以内存为准（含新增/更新）；
 *   - 存储里有、但本窗口**从未见过**的 taskId：是其它窗口的登记，保留；
 *   - 本窗口见过（knownIds）而内存里已没有的：是本窗口删除（投递完成/销账），丢弃。
 */
export function mergeLedgerForPersist<T extends { taskId: string }>(
	memory: T[],
	stored: T[],
	knownIds: ReadonlySet<string>,
): T[] {
	const mine = new Set(memory.map((e) => e.taskId));
	const foreign = stored.filter((e) => e?.taskId && !mine.has(e.taskId) && !knownIds.has(e.taskId));
	return [...memory, ...foreign];
}
