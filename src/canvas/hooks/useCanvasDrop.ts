import { useCallback } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import { getPlugin } from "@/nodes/pluginRegistry";
import { makeNode } from "../nodeFactory";
import type { NodeType } from "@/types";
import { importFilesToCanvas } from "../canvasFileImport";
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

      // 1. OS 文件拖入（与粘贴同一实现：canvasFileImport.importFilesToCanvas）
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        importFilesToCanvas(Array.from(e.dataTransfer.files), pos);
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
            // 复用资产已有的全局 id（有则不另起 asset-*，避免重复入库同一图片）
            const assetId = data.assetId || `asset-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
            useLibraryStore.getState().addAsset({
              id: assetId,
              kind: "image",
              name: data.name || "资产图片",
              uri: assetUri,
              serverAssetId: data.assetId || null,
              thumbnailUri: assetUri,
              createdAt: new Date().toISOString(),
              deletedByUser: false,
              localPath: data.localPath || null,
              origin: "generated", // 资产助手派生 → 不进「本地素材库」
            });
            // 资产助手图片拖到画布 → 新建「生成图片」节点，把该图作为节点结果显示
            const newNode = makeNode("image.gen", pos.x, pos.y);
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
            const newNode = makeNode("upload", pos.x, pos.y);
            newNode.data.resultAssetId = data.assetId;
            dispatchCommand({ type: "addNode", node: newNode });
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