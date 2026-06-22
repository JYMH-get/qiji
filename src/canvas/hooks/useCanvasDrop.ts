import { useCallback } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import { getPlugin } from "@/nodes/pluginRegistry";
import { makeNode } from "../nodeFactory";
import type { NodeType } from "@/types";
import { storeDroppedFile } from "@/services/fileStorage";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
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
          // 资产助手原生拖入：文件名 <assetId>.<ext> 命中已登记 blob → 复用 id（粘贴 id，不重复入库字节）
          if (file.type.startsWith("image/")) {
            const base = file.name.replace(/\.[^.]+$/, "");
            const blob = useProjectStore.getState().assetBlobs[base];
            const ref = blob?.localUri || blob?.url;
            if (blob && ref) {
              useLibraryStore.getState().addAsset({
                id: blob.id, kind: "image", name: file.name, uri: ref, thumbnailUri: ref,
                createdAt: new Date().toISOString(), deletedByUser: false, localPath: blob.localPath || null,
              });
              const node = makeNode("file_image", pos.x, pos.y + offsetY);
              node.data.resultAssetId = blob.id;
              dispatchCommand({ type: "addNode", node });
              offsetY += 240;
              continue;
            }
          }
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

      // 2a. 资产助手拖拽（项目/收藏资产）→ 入库 + 新建图片节点
      try {
        if (dragData.startsWith("{") && dragData.includes("qiji-asset")) {
          const data = JSON.parse(dragData);
          const assetUri = data.localUri || data.url || data.uri;
          if (data.source === "qiji-asset" && assetUri) {
            const assetId = `asset-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
            useLibraryStore.getState().addAsset({
              id: assetId,
              kind: "image",
              name: data.name || "资产图片",
              uri: assetUri,
              thumbnailUri: assetUri,
              createdAt: new Date().toISOString(),
              deletedByUser: false,
              localPath: data.localPath || null,
            });
            const newNode = makeNode("file_image", pos.x, pos.y);
            newNode.data.resultAssetId = assetId;
            dispatchCommand({ type: "addNode", node: newNode });
            return;
          }
        }
      } catch (err) {
        console.error("Failed to parse qiji-asset drop", err);
      }

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