import { useEffect, useState } from "react";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { dispatchCommand } from "@/command/dispatch";
import { genId } from "@/lib/id";
import { copyToClipboard, pasteFromClipboard } from "@/lib/clipboard";

/** 键盘快捷键：Ctrl+Z 撤销，Ctrl+Y 重做，Ctrl+G 打组，Ctrl+C 复制，Ctrl+V 粘贴 */
export function useCanvasKeyboard() {
  const [isSpacePressed, setIsSpacePressed] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      if (isCtrl && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatchCommand({ type: "undo" });
      } else if (isCtrl && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatchCommand({ type: "redo" });
      } else if (isCtrl && e.key.toLowerCase() === "g") {
        const selectedIds = useUiStore.getState().selectedNodeIds;
        if (selectedIds.length > 1) {
          e.preventDefault();
          dispatchCommand({ type: "group", nodeIds: selectedIds });
        }
      } else if (isCtrl && e.key.toLowerCase() === "c") {
        const selectedIds = useUiStore.getState().selectedNodeIds;
        if (selectedIds.length > 0) {
          e.preventDefault();
          const state = useCanvasStore.getState();
          const selectedNodes = selectedIds
            .map((id) => state.nodes[id])
            .filter(Boolean);
          const selectedSet = new Set(selectedIds);
          const selectedEdges = Object.values(state.edges).filter(
            (edge) =>
              selectedSet.has(edge.source) && selectedSet.has(edge.target),
          );
          copyToClipboard(selectedNodes, selectedEdges);
        }
      } else if (isCtrl && e.key.toLowerCase() === "v") {
        const clipData = pasteFromClipboard();
        if (clipData && clipData.nodes.length > 0) {
          e.preventDefault();
          const offset = 40;
          const idMap = new Map<string, string>();

          const newNodes = clipData.nodes.map((node) => {
            const newId = genId(node.type);
            idMap.set(node.id, newId);
            return {
              ...node,
              id: newId,
              x: node.x + offset,
              y: node.y + offset,
            };
          });

          const newEdges = clipData.edges
            .filter((edge) => idMap.has(edge.source) && idMap.has(edge.target))
            .map((edge) => ({
              ...edge,
              id: genId("edge"),
              source: idMap.get(edge.source)!,
              target: idMap.get(edge.target)!,
            }));

          dispatchCommand({
            type: "pasteNodes",
            nodes: newNodes,
            edges: newEdges,
          });

          useUiStore.getState().setSelection(newNodes.map((n) => n.id));
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 空格长按拖动画布
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        const activeEl = document.activeElement;
        const isInput =
          activeEl &&
          (activeEl.tagName === "INPUT" ||
            activeEl.tagName === "TEXTAREA" ||
            activeEl.getAttribute("contenteditable") === "true");
        if (!isInput) {
          e.preventDefault();
          setIsSpacePressed(true);
        }
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setIsSpacePressed(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  return { isSpacePressed };
}