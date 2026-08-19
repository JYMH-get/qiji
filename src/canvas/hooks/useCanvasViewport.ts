import { useCallback, useEffect } from "react";
import { useReactFlow } from "@xyflow/react";
import { useCanvasStore } from "@/store/canvasStore";
import { useProjectStore } from "@/store/projectStore";
import { setCanvasPanning } from "@/canvas/interaction";

/** 视口同步 + 项目加载后恢复 */
export function useCanvasViewport() {
  const { getViewport, setViewport, fitView } = useReactFlow();
  const isProjectLoading = useProjectStore((s) => s.isProjectLoading);
  const savePath = useProjectStore((s) => s.savePath);

  const onMoveStart = useCallback(() => {
    setCanvasPanning(true); // 平移/缩放中：去抖保存推迟执行（保存大活撞交互=掉帧）
  }, []);

  const onMoveEnd = useCallback(() => {
    setCanvasPanning(false);
    useCanvasStore.getState().setViewport(getViewport());
    useProjectStore.getState().scheduleAutoSave("viewport");
  }, [getViewport]);

  const onMove = useCallback((_event: unknown, viewport: { x: number; y: number; zoom: number }) => {
    useCanvasStore.getState().setViewport(viewport);
  }, []);

  useEffect(() => {
    if (!isProjectLoading) {
      const storeVp = useCanvasStore.getState().viewport;
      const currentVp = getViewport();

      const hasSavedViewport =
        storeVp &&
        (storeVp.x !== 0 || storeVp.y !== 0 || storeVp.zoom !== 0.7);

      if (hasSavedViewport) {
        if (
          Math.abs(storeVp.x - currentVp.x) > 0.1 ||
          Math.abs(storeVp.y - currentVp.y) > 0.1 ||
          Math.abs(storeVp.zoom - currentVp.zoom) > 0.01
        ) {
          setViewport(storeVp);
        }
      } else {
        setViewport({ x: 0, y: 0, zoom: 0.7 });
      }
    }
  }, [isProjectLoading, savePath, setViewport, getViewport, fitView]);

  return { onMoveStart, onMoveEnd, onMove };
}