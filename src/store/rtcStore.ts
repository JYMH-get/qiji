/**
 * rtcStore.ts — 实时剪辑（第三模式）运行时状态
 *
 * 分工（与 canvasStore ↔ projectStore 同构）：
 *   - 本 store 持有编辑中的 doc 工作副本 + 选区/播放头/缩放等纯 UI 态（不落盘的除 doc 外全部）；
 *   - 持久化归 projectStore：每次 commit/undo/redo 把 doc **引用回写** projectStore.rtcDocs
 *     的归属分集档位（setRtcEpisodeDoc 内部 isDirty + scheduleAutoSave 去抖落盘，多窗口同步走
 *     SHARED_PROJECT_FIELDS 的 rtcDocs 整表）；**一个分集 = 一条独立时间轴**，本 store 恒持有
 *     「当前激活分集」的工作副本（切分集=模块订阅全量重置换档）；
 *   - doc 由 rtcOps 纯函数不可变更新——undo 栈直接存引用快照（无需深拷贝，区别于 canvasStore
 *     的 JSON 克隆：那边 nodes 可能被别处原地改，这边 commit 契约保证 doc 不可变）。
 *
 * ⚠ 红线：doc 里只有 assetId/uri 引用，绝不存 base64/data:/blob:（projectFile 红线）。
 *
 * 项目隔离（用户明令「每个项目独立实时剪辑模式，不要串项目」）：
 *   - loadDoc 记录当时的 projectInstanceId（库内防串台惯例，同 Frame1693/flowActions/assetMerge）；
 *   - commit/undo/redo 回写前比对身份——不一致=用户已切项目，**丢弃该次回写**并改从当前项目
 *     收编 rtcDoc（console.warn 留痕），杜绝旧项目剪辑文档写进新项目落盘；
 *   - 模块级订阅 projectStore：换项目→全量重置；同项目下 rtcDoc 被外部改写（多窗口同步
 *     fields/full 镜像直写）→ 收编新 doc（选区剪枝/播放头钳位/清 undo 栈），自写经
 *     selfWriting 标记防回声（同 projectSync applyingRemote 惯例）。
 */
import { create } from "zustand";
import { createEmptyRtcDoc, type RtcDoc } from "@/types/rtc";
import { docDurationUs, pruneScriptTracks } from "@/lib/rtcOps";
import { activeViewDoc, sanitizeRtcCompound } from "@/lib/rtcCompound";
import { useProjectStore, resolveEpisodeKey } from "./projectStore";

const MAX_HISTORY = 100;

export interface RtcState {
  /** 编辑中的剪辑文档（null=未加载/项目无剪辑文档） */
  doc: RtcDoc | null;
  /** 选中的片段 id 集合 */
  selection: string[];
  /** 播放头位置（微秒） */
  playheadUs: number;
  /** 时间轴缩放：每秒像素数 */
  pxPerSec: number;
  /** 磁吸开关 */
  snapOn: boolean;
  /** 预览窗原文参考条显隐（会话态）。原文非轨道数据——由 rtcScriptLane 从主轨实时派生 */
  scriptTrackVisible: boolean;
  past: RtcDoc[];
  future: RtcDoc[];
  /** loadDoc 时记录的项目身份（projectStore.projectInstanceId）——回写守卫的比对基准 */
  ownerProjectId: string | null;
  /** loadDoc 时记录的分集 key（分集化后 doc 归属哪个分集档位）——回写恒写自己的档位，天然不串集 */
  ownerEpisodeKey: string | null;
  /* ── 第四批：复合片段编辑上下文 ──
   * 正在编辑的子时间轴 id（null=主时间轴）。时间轴/播放器/属性面板的取数口径一律走
   * activeRtcDoc()（主层=doc、子层=子文档视图）；数据变更在子层时走 commitActive。
   * undo/redo 栈全局共享（commit 的 mutator 作用于整个 doc 含 subDocs，天然一体）。 */
  editingSubDocId: string | null;

  /** 载入文档（打开项目/新建剪辑时调用）：重置选区/播放头/撤销栈，不回写 projectStore */
  loadDoc: (doc: RtcDoc | null) => void;
  /** 提交一次不可变变更（rtcOps 纯函数）：推 undo 栈、清 future、回写 projectStore 触发去抖落盘。
   *  mutator 返回原引用视为 no-op（不进栈不落盘）。 */
  commit: (mutator: (doc: RtcDoc) => RtcDoc) => void;
  /**
   * **静默写入**（不推 undo 栈）：机器产生的高频状态回填专用——AI 生成占位片段的
   * `status`/`progress` 每秒可能刷新数次，走 commit 会把撤销栈冲成废物（Ctrl+Z 全是进度帧）。
   *
   * 与 commit 的唯一区别是**不动 past/future**；项目身份守卫、回写 projectStore（去抖落盘）、
   * 选区剪枝一律照旧，mutator 返回原引用同样视为 no-op。
   *
   * ⚠ 分工（勿混用）：
   *   - **用户动作**（含「开始生成」这类用户点出来的状态变更）与**终态落笔**（占位→media / 转失败）
   *     一律走 `commit`——它们必须进撤销栈，否则一次 Ctrl+Z 会把已落地的结果连同快照一起回退掉；
   *   - **进度帧/在途状态镜像**走 `patchSilent`——即便被别的 undo 顺带回退，下一次回填/下一轮
   *     台账镜像会自动补回（自愈），丢了也无损。
   */
  patchSilent: (mutator: (doc: RtcDoc) => RtcDoc) => void;
  undo: () => void;
  redo: () => void;
  /* ── 第四批：复合片段 ── */
  /** 进入复合片段编辑（子文档不存在则 no-op）；选中与播放头各自重置 */
  enterCompound: (subDocId: string) => void;
  /** 退出复合片段编辑回主时间轴；选中与播放头各自重置 */
  exitCompound: () => void;
  /**
   * **编辑层感知**的 commit：主层 = 直接 commit；子层 = mutator 作用于子文档视图
   * （activeViewDoc），改动写回 doc.subDocs——undo 栈/落盘/项目守卫全部复用 commit 一条路。
   * ⚠ 时间轴/播放器等「在当前编辑层上做手势」的调用方一律用它；直接操作主 doc 结构的
   * （创建/解散复合、占位符替换等）仍走 commit。
   */
  commitActive: (mutator: (doc: RtcDoc) => RtcDoc) => void;
  setSelection: (ids: string[]) => void;
  setPlayhead: (us: number) => void;
  setZoom: (pxPerSec: number) => void;
  toggleSnap: () => void;
  /** 原文轨道显隐开关（工具条按钮 / 快捷键 O） */
  toggleScriptTrackVisible: () => void;
}

/** 自写标记：syncToProject 期间置位，模块级订阅据此跳过（防回声，同 projectSync applyingRemote 惯例） */
let selfWriting = false;

/** doc 回写 projectStore（isDirty + 去抖落盘由 setRtcEpisodeDoc 内部处理）。
 *  ⚠ 恒写 **doc 归属的分集档位**（ownerEpisodeKey）——即便用户已切分集，旧分集的 doc 写回旧分集
 *  档位仍是正确落点（绝不会写进新分集）；分集已删时 setRtcEpisodeDoc 内部丢弃。 */
function syncToProject(doc: RtcDoc) {
  const epKey = useRtcStore.getState().ownerEpisodeKey;
  if (!epKey) return; // 无分集归属（项目未载入等）：不落盘
  selfWriting = true;
  try {
    useProjectStore.getState().setRtcEpisodeDoc(epKey, doc);
  } finally {
    selfWriting = false;
  }
}

/** doc 变更后收敛选区：剔除已不存在的片段 id（引用不变则原样返回）。导出仅供单测。
 *  第四批：子文档里的片段也算存活——子层编辑中的选中不被主层视角误剪。 */
export function pruneSelection(selection: string[], doc: RtcDoc): string[] {
  if (selection.length === 0) return selection;
  const alive = new Set<string>();
  for (const t of doc.tracks) for (const s of t.segments) alive.add(s.id);
  for (const sub of Object.values(doc.subDocs ?? {})) {
    for (const t of sub.tracks) for (const s of t.segments) alive.add(s.id);
  }
  const next = selection.filter((id) => alive.has(id));
  return next.length === selection.length ? selection : next;
}

/**
 * 当前编辑层的文档视图（第四批）：主层 = doc；子层 = 子文档视图（fps/画幅随主文档）。
 * 引用稳定（activeViewDoc 内部 WeakMap 缓存），可直接作 zustand selector：
 * `useRtcStore(activeRtcDoc)`；回调里用 `activeRtcDoc(useRtcStore.getState())`。
 */
export function activeRtcDoc(s: Pick<RtcState, "doc" | "editingSubDocId">): RtcDoc | null {
  return activeViewDoc(s.doc, s.editingSubDocId);
}

/** 播放头钳到文档时长内（doc 为空=归零）。导出仅供单测。 */
export function clampPlayheadUs(us: number, doc: RtcDoc | null): number {
  if (!doc) return 0;
  return Math.min(Math.max(0, us), docDurationUs(doc));
}

/** 当前激活分集 key（projectStore.rtcEpisodeId 经 resolveEpisodeKey 收敛；无分集=""） */
function activeEpisodeKey(): string {
  const ps = useProjectStore.getState();
  return resolveEpisodeKey(ps.rtcEpisodeId, ps.episodes);
}

/** 从当前项目收编**当前激活分集**的剪辑文档：该集无档位则建空文档（首次 commit 才落盘） */
function adoptCurrentDoc(): void {
  const ps = useProjectStore.getState();
  useRtcStore.getState().loadDoc(ps.rtcDocs[activeEpisodeKey()] ?? createEmptyRtcDoc());
}

/**
 * 项目身份守卫：commit/undo/redo 回写前比对「doc 归属项目」与「当前项目」。
 * 不一致=用户已切项目而本次变更仍基于旧项目 doc → 丢弃该次回写（绝不污染新项目 rtcDoc），
 * 并改从当前项目收编剪辑文档。返回 true=身份一致可放行。
 */
function guardOwner(op: string): boolean {
  const owner = useRtcStore.getState().ownerProjectId;
  const ps = useProjectStore.getState();
  if (owner === ps.projectInstanceId) return true;
  console.warn(
    `[rtc] ${op} 丢弃：项目已切换（doc 归属 ${owner ?? "(未载入)"}，当前 ${ps.projectInstanceId}），改从当前项目收编剪辑文档`,
  );
  adoptCurrentDoc();
  return false;
}

export const useRtcStore = create<RtcState>((set, get) => ({
  doc: null,
  selection: [],
  playheadUs: 0,
  pxPerSec: 100,
  snapOn: true,
  scriptTrackVisible: true,
  past: [],
  future: [],
  ownerProjectId: null,
  ownerEpisodeKey: null,
  editingSubDocId: null,

  loadDoc: (doc) =>
    set({
      // 载入清洗（第四批）：复合片段引用缺失/嵌套/孤儿子文档在此收口（无复合内容时返回原引用零开销）
      // + 补充10：旧形态 role:"script" 原文轨整轨清除（原文改由 rtcScriptLane 派生，不再是片段数据）
      doc: doc ? sanitizeRtcCompound(pruneScriptTracks(doc)) : doc,
      ownerProjectId: useProjectStore.getState().projectInstanceId,
      ownerEpisodeKey: activeEpisodeKey() || null,
      selection: [],
      playheadUs: 0,
      past: [],
      future: [],
      editingSubDocId: null,
    }),

  commit: (mutator) => {
    const s = get();
    if (!s.doc) return;
    if (!guardOwner("commit")) return; // 项目已切换：丢弃本次变更，绝不写进新项目
    const next = mutator(s.doc);
    if (next === s.doc) return; // no-op：不进栈不落盘
    const past = [...s.past, s.doc];
    if (past.length > MAX_HISTORY) past.shift();
    set({ doc: next, past, future: [], selection: pruneSelection(s.selection, next) });
    syncToProject(next);
  },

  patchSilent: (mutator) => {
    const s = get();
    if (!s.doc) return;
    // 守卫与 commit 完全一致：项目已切换 → 丢弃本次回填（旧项目的进度绝不写进新项目），并收编当前项目文档
    if (!guardOwner("patchSilent")) return;
    const next = mutator(s.doc);
    if (next === s.doc) return; // no-op：不落盘（片段已删/值未变时 mutator 应返回原引用）
    // ⚠ past/future 一律不动——这正是与 commit 的唯一区别（进度帧不进撤销栈）
    set({ doc: next, selection: pruneSelection(s.selection, next) });
    syncToProject(next);
  },

  undo: () => {
    const s = get();
    const past = [...s.past];
    const prev = past.pop();
    if (!prev || !s.doc) return;
    if (!guardOwner("undo")) return; // 项目已切换：旧项目 undo 栈作废
    set({ doc: prev, past, future: [...s.future, s.doc], selection: pruneSelection(s.selection, prev) });
    syncToProject(prev);
  },

  redo: () => {
    const s = get();
    const future = [...s.future];
    const next = future.pop();
    if (!next || !s.doc) return;
    if (!guardOwner("redo")) return; // 项目已切换：旧项目 redo 栈作废
    set({ doc: next, future, past: [...s.past, s.doc], selection: pruneSelection(s.selection, next) });
    syncToProject(next);
  },

  /* ── 第四批：复合片段编辑上下文 ── */
  enterCompound: (subDocId) => {
    const s = get();
    if (!s.doc?.subDocs?.[subDocId]) return; // 子文档不存在（已解散等）→ no-op
    // 选中/播放头进出各自重置（子层与主层是两个时间坐标系）
    set({ editingSubDocId: subDocId, selection: [], playheadUs: 0 });
  },
  exitCompound: () => {
    if (!get().editingSubDocId) return;
    set({ editingSubDocId: null, selection: [], playheadUs: 0 });
  },
  commitActive: (mutator) => {
    const { editingSubDocId, commit } = get();
    if (!editingSubDocId) return commit(mutator);
    commit((d) => {
      const sub = d.subDocs?.[editingSubDocId];
      if (!sub) return mutator(d); // 子文档已不存在=已回主层语义（activeViewDoc 同口径回退）
      const view = activeViewDoc(d, editingSubDocId);
      if (!view || view === d) return mutator(d);
      const nextView = mutator(view);
      if (nextView === view) return d; // no-op 透传（不进栈不落盘）
      return { ...d, subDocs: { ...d.subDocs, [editingSubDocId]: { ...sub, tracks: nextView.tracks } } };
    });
  },

  setSelection: (ids) => set({ selection: ids }),
  setPlayhead: (us) => set({ playheadUs: Math.max(0, us) }),
  setZoom: (pxPerSec) => set({ pxPerSec: Math.min(1000, Math.max(1, pxPerSec)) }),
  toggleSnap: () => set((s) => ({ snapOn: !s.snapOn })),
  toggleScriptTrackVisible: () => set((s) => ({ scriptTrackVisible: !s.scriptTrackVisible })),
}));

/* ── 项目 → rtc 自动收编（模块级订阅，随首次 import 常驻）──────────────────────
 * 分集化（一个分集=一条独立时间轴，rtcDocs[epKey]）后的三分派：
 * ⑴ projectInstanceId 变化（新建/加载/导入项目）→ 全量重置为当前激活分集的 doc（无则建空文档，
 *    勿传 null——时间轴引导 effect 只在 projectRtcDoc 变化时重跑，null→null 切换会卡「正在载入」）；
 * ⑵ **激活分集 key 变化**（switchRtcEpisode / 激活集被删回退）→ 同样全量重置（换时间轴=换坐标系：
 *    选区/播放头/undo 栈全清，各分集时间轴互不串）；
 * ⑶ 同项目同分集下本档位 doc 引用变化且非 rtcStore 自写（多窗口同步 fields/full 镜像经 setState
 *    直写、找回投递等外部写入）→ 收编新 doc：选区剪枝、播放头钳位、**清空 past/future**
 *    （基座变了，旧 undo 会覆盖外部变更）。不回写 projectStore（收编非创作）。 */
let prevInstanceId = useProjectStore.getState().projectInstanceId;
let prevEpKey = resolveEpisodeKey(useProjectStore.getState().rtcEpisodeId, useProjectStore.getState().episodes);
let prevSlotDoc = useProjectStore.getState().rtcDocs[prevEpKey] ?? null;
useProjectStore.subscribe((ps) => {
  const epKey = resolveEpisodeKey(ps.rtcEpisodeId, ps.episodes);
  const slotDoc = ps.rtcDocs[epKey] ?? null;
  const instChanged = ps.projectInstanceId !== prevInstanceId;
  const keyChanged = epKey !== prevEpKey;
  const docChanged = slotDoc !== prevSlotDoc;
  prevInstanceId = ps.projectInstanceId;
  prevEpKey = epKey;
  prevSlotDoc = slotDoc;
  if (instChanged || keyChanged) {
    adoptCurrentDoc(); // 换项目/换分集：全量重置（loadDoc 内记录新的 owner 身份）
    return;
  }
  if (docChanged && !selfWriting) {
    if (!slotDoc) {
      adoptCurrentDoc(); // 外部把本分集档位清空（写者镜像无剪辑文档等）→ 等同重新收编
      return;
    }
    const s = useRtcStore.getState();
    // 外部镜像也过一遍复合清洗+旧原文轨剪除（无相应内容返回原引用零开销）；正编辑的子文档被外部改没了 → 退回主层
    const adopted = sanitizeRtcCompound(pruneScriptTracks(slotDoc));
    useRtcStore.setState({
      doc: adopted,
      ownerProjectId: ps.projectInstanceId,
      ownerEpisodeKey: epKey,
      selection: pruneSelection(s.selection, adopted),
      playheadUs: clampPlayheadUs(s.playheadUs, adopted),
      past: [],
      future: [],
      editingSubDocId: s.editingSubDocId && adopted.subDocs?.[s.editingSubDocId] ? s.editingSubDocId : null,
    });
  }
});
