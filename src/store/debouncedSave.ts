/**
 * debouncedSave.ts — 三档去抖保存策略
 *   viewport: 500ms（视口位置变更，低优先级）
 *   history:  180ms（历史提交，中优先级）
 *   canvas:   400ms（节点/连线结构变更，标准优先级）
 *
 * 拖拽期间 (isDragHistoryPaused) 不触发 history 档。
 */
import { isDragHistoryPaused } from "@/canvas/hooks/useCanvasDrag";

type SaveTier = "canvas" | "history" | "viewport";

const TIER_MS: Record<SaveTier, number> = {
  history: 180,
  canvas: 400,
  viewport: 500,
};

const timers: Record<SaveTier, ReturnType<typeof setTimeout> | null> = {
  canvas: null,
  history: null,
  viewport: null,
};

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

/** 按指定档位调度一次保存 */
export function scheduleSave(tier: SaveTier = "canvas") {
  _markDirtyFn?.();

  if (tier === "history" && isDragHistoryPaused()) return;

  if (timers[tier]) clearTimeout(timers[tier]!);
  timers[tier] = setTimeout(async () => {
    timers[tier] = null;
    if (_saveFn) {
      try {
        await _saveFn();
      } catch (err) {
        console.error(`[debouncedSave:${tier}] save failed:`, err);
      }
    }
  }, TIER_MS[tier]);
}

/** 取消所有未执行的去抖保存 */
export function cancelAllSaves() {
  for (const key of Object.keys(timers) as SaveTier[]) {
    if (timers[key]) {
      clearTimeout(timers[key]!);
      timers[key] = null;
    }
  }
}