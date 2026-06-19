import { useCallback } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import { getPlugin } from "@/nodes/pluginRegistry";
import { makeNode } from "../nodeFactory";
import type { NodeType } from "@/types";
import { storeDroppedFile } from "@/services/fileStorage";
import { useLibraryStore } from "@/store/libraryStore";
import { dispatchCommand } from "@/command/dispatch";

/** 文件拖放 + 资产库拖拽 + 侧边栏拖拽创建节点 */
export function useCanvasDrop() {
  const { screenToFlowPosition } = useReactFlow();

  const onDragOver = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      e.preventDefault();
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });

      // 1. OS 文件拖入
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const files = Array.from(e.dataTransfer.files);
        let offsetY = 0;
        for (const file of files) {
          let kind: "image" | "video" | "audio" | "script" | null = null;
          if (file.type.startsWith("image/")) {
            kind = "image";
          } else if (file.type.startsWith("video/")) {
            kind = "video";
          } else if (file.type.startsWith("audio/")) {
            kind = "audio";
          } else if (
            file.name.endsWith(".txt") ||
            file.name.endsWith(".doc") ||
            file.name.endsWith(".docx") ||
            file.name.endsWith(".pdf") ||
            file.name.endsWith(".json")
          ) {
            kind = "script";
          }

          if (kind) {
            (async () => {
              const stored = await storeDroppedFile(file);
              if (!stored) return;
              const assetId = stored.fileId;

              useLibraryStore.getState().addAsset({
                id: assetId,
                kind,
                name: stored.fileName,
                uri: stored.fileUri,
                thumbnailUri: null,
                createdAt: new Date().toISOString(),
                deletedByUser: false,
                localPath: stored.localPath,
              });

              const nodeType = `file_${kind === "script" ? "document" : kind}`;
              const newNode = makeNode(nodeType, pos.x, pos.y + offsetY);
              newNode.data.resultAssetId = assetId;

              dispatchCommand({ type: "addNode", node: newNode });
            })();
            offsetY += 240;
          }
        }
        return;
      }

      const dragData = e.dataTransfer.getData("text/plain");
      if (!dragData) return;

      // 2. 资产库拖拽
      try {
        if (dragData.startsWith("{") && dragData.includes("library")) {
          const data = JSON.parse(dragData);
          if (data.source === "library") {
            const kind = data.kind;
            const nodeType = `file_${kind === "script" ? "document" : kind}`;
            if (getPlugin(nodeType)) {
              const newNode = makeNode(nodeType, pos.x, pos.y);
              newNode.data.resultAssetId = data.assetId;
              dispatchCommand({ type: "addNode", node: newNode });
            }
            return;
          }
        }
      } catch (err) {
        console.error("Failed to parse drop JSON data", err);
      }

      // 3. 侧边栏拖拽
      const type = dragData as NodeType;
      if (getPlugin(type)) {
        dispatchCommand({
          type: "addNode",
          node: makeNode(type, pos.x, pos.y),
        });
      }
    },
    [screenToFlowPosition],
  );

  return { onDragOver, onDrop };
}