/**
 * useScrollSnapshot — 滚动位置快照（恢复「上次滑到哪里」）
 *
 * 用法：把返回的 ref/onScroll 挂到 overflow:auto 的滚动容器上。
 *  - saved：上次保存的 scrollTop（从 projectStore.uiSnapshot 读取，挂载时取一次即可）
 *  - onCapture：滚动停止后（去抖 300ms）写回快照
 *  - restoreDeps：影响内容高度的依赖（如列表数据长度）；内容渲染出高度后再尝试恢复一次
 *
 * 设计要点：
 *  - 只成功恢复一次（restoredRef），避免用户手动滚动后被反复拽回。
 *  - 内容异步加载（资产/分集从磁盘 hydrate）时，restoreDeps 变化会重试恢复，直到容器可滚动。
 *  - 捕获走去抖 + projectStore 的 viewport 档落盘，避免逐像素写盘。
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

export function useScrollSnapshot(
  saved: number | undefined,
  onCapture: (top: number) => void,
  restoreDeps: unknown[],
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const restoredRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 用 ref 持有最新 onCapture，使 onScroll 句柄保持稳定（不随每次渲染变化）
  const cbRef = useRef(onCapture);
  cbRef.current = onCapture;

  // 恢复：等内容撑出可滚动高度后再设置一次
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || restoredRef.current) return;
    if (saved && saved > 0 && el.scrollHeight > el.clientHeight) {
      el.scrollTop = saved;
      restoredRef.current = true;
    }
    // saved 在挂载后稳定；restoreDeps 由调用方给出
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, restoreDeps);

  // 捕获：滚动停止 300ms 后写回（去抖）
  const onScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    const top = e.currentTarget.scrollTop;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => cbRef.current(top), 300);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { ref, onScroll };
}
