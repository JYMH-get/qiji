/**
 * debouncedSave.ts — 自动保存节流（2 分钟合并窗口）
 *
 * 背景（勿回退）：旧版按改动去抖（canvas 400ms / history 180ms / viewport 500ms），
 * 编辑时几乎每停顿 0.4s 就把整份项目文件全量重写一遍。配合「原子保存」每次都把
 * 主文件轮换成 .bak，导致**连续两次保存都落在系统写回缓存未刷盘的窗口内**——一旦断电，
 * NTFS 只恢复元数据不恢复数据，主文件与 .bak 会**同时**被清零（实测事故根因）。
 *
 * 现策略：一次改动开启一个 2 分钟窗口，窗口内所有改动合并成末尾一次保存（最多每 2 分钟一次）。
 * 保存间隔拉大后，上一版数据早已刷盘，断电最多丢当前窗口的增量、不会连 .bak 一起零掉。
 *
 * 注意：**重要状态（出图/推理/资产结果、手动 Ctrl+S、关窗）走 save(true) 立即落盘**，
 * 不经此节流；这里只管零散画布编辑（挪节点/改文字/移视口）的后台自动保存。
 *
 * 拖拽/平移期间一律推迟（保存含整项目 JSON.stringify，撞交互帧=卡顿）。
 */
import { isDragHistoryPaused } from "@/canvas/hooks/useCanvasDrag";
import { isCanvasPanning } from "@/canvas/interaction";

/** 保留旧签名以兼容调用方；档位现已合并为单一窗口，参数忽略 */
type SaveTier = "canvas" | "history" | "viewport";

/** 自动保存合并窗口：2 分钟 */
const AUTOSAVE_MS = 2 * 60 * 1000;

/** 交互结束前每 300ms 复查一次，空闲才真正落盘 */
const RETRY_MS = 300;

let timer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

let _saveFn: (() => Promise<void>) | null = null;
let _markDirtyFn: (() => void) | null = null;

/** 注入实际保存函数（在 projectStore 初始化后调用） */
export function initDebouncedSave(
  saveFn: () => Promise<void>,
  markDirtyFn: () => void,
) {
  _saveFn = saveFn;
  _markDirtyFn = markDirtyFn;
}

/** 用户正在与画布交互（拖节点 / 平移缩放视口）？期间保存一律推迟 */
const isInteracting = () => isDragHistoryPaused() || isCanvasPanning();

const fire = async () => {
  timer = null;
  if (!dirty) return;
  if (isInteracting()) {
    // 拖动/平移中：推迟，绝不与交互帧抢主线程
    timer = setTimeout(fire, RETRY_MS);
    return;
  }
  dirty = false;
  if (!_saveFn) return;
  try {
    await _saveFn();
  } catch (err) {
    console.error("[autosave] save failed:", err);
    // 失败：保留脏标记并重新排一个窗口，等下次到点再试
    dirty = true;
    if (!timer) timer = setTimeout(fire, AUTOSAVE_MS);
  }
};

/**
 * 标记有改动、开启（或复用）2 分钟自动保存窗口。
 * 窗口内多次调用只合并成末尾一次保存。tier 参数已废弃，仅为兼容保留。
 */
export function scheduleSave(_tier: SaveTier = "canvas") {
  _markDirtyFn?.();
  dirty = true;
  if (!timer) timer = setTimeout(fire, AUTOSAVE_MS);
}

/**
 * 任意一次成功保存后调用（含手动 save(true) / 出图推理等即时落盘）。
 * 清掉脏标记：若 2 分钟窗口到点时已无新改动，则跳过多余的自动保存。
 */
export function notifySaved() {
  dirty = false;
}

/** 取消未执行的自动保存（切换/关闭项目时用，防迟到的保存写错项目） */
export function cancelAllSaves() {
  if (timer) clearTimeout(timer);
  timer = null;
  dirty = false;
}
