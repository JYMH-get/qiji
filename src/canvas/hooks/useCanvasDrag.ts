import { useCallback, useRef } from "react";
import type { Node, NodeChange } from "@xyflow/react";
import { useCanvasStore } from "@/store/canvasStore";
import { dispatchCommand } from "@/command/dispatch";

interface CanvasNodeLike {
  id: string;
  type: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  parentId: string | null;
}

/** 拖拽期间暂停历史记录写入 */
let _historyPaused = false;
export const isDragHistoryPaused = () => _historyPaused;

/** 组节点关联 ID 收集 */
export const getGroupRelatedNodeIds = (
  nodeId: string,
  nodesMap: Record<string, CanvasNodeLike>,
) => {
  const node = nodesMap[nodeId];
  if (!node) return [nodeId];

  let groupId: string | null = null;
  if (node.type === "group") {
    groupId = node.id;
  } else if (node.parentId) {
    groupId = node.parentId;
  }

  if (!groupId) return [nodeId];

  const related = [groupId];
  for (const n of Object.values(nodesMap)) {
    if (n.parentId === groupId) {
      related.push(n.id);
    }
  }
  return Array.from(new Set(related));
};

/** 重算组节点边界 */
function syncGroupBounds(nodeIds: string[]) {
  const groupsToUpdate = new Set<string>();
  const currentNodes = useCanvasStore.getState().nodes;
  for (const id of nodeIds) {
    const node = currentNodes[id];
    if (node && node.parentId) {
      groupsToUpdate.add(node.parentId);
    }
  }

  if (groupsToUpdate.size > 0) {
    const updatedNodes = { ...currentNodes };
    const updatedGroups = { ...useCanvasStore.getState().groups };

    for (const groupId of groupsToUpdate) {
      const group = updatedGroups[groupId];
      if (!group) continue;

      const remainingNodes = group.childIds
        .map((id) => updatedNodes[id])
        .filter(Boolean);
      if (remainingNodes.length > 0) {
        const xs = remainingNodes.map((n) => n.x);
        const ys = remainingNodes.map((n) => n.y);
        const xMaxs = remainingNodes.map((n) => n.x + (n.w || 240));
        const yMaxs = remainingNodes.map((n) => n.y + (n.h || 200));

        const minX = Math.min(...xs);
        const maxX = Math.max(...xMaxs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...yMaxs);
        const groupX = minX - 20;
        const groupY = minY - 40;
        const groupW = maxX - minX + 40;
        const groupH = maxY - minY + 60;

        if (updatedNodes[groupId]) {
          updatedNodes[groupId] = {
            ...updatedNodes[groupId],
            x: groupX,
            y: groupY,
            w: groupW,
            h: groupH,
          };
        }

        updatedGroups[groupId] = {
          ...group,
          x: groupX,
          y: groupY,
        };
      }
    }

    useCanvasStore.setState({
      nodes: updatedNodes,
      groups: updatedGroups,
    });
  }
}

/** 节点拖拽：rAF 节流 + 组边界同步 + historyPaused */
export function useCanvasDrag() {
  const dragStartPositions = useRef<Record<string, { x: number; y: number }>>(
    {},
  );
  const rafId = useRef<number>(0);
  const pendingUpdates = useRef<Record<string, { x: number; y: number }>>({});

  /** rAF 节流：合并同一帧内的多次 moveNode 调用 */
  const flushDragUpdates = useCallback(() => {
    rafId.current = 0;
    const batch = pendingUpdates.current;
    pendingUpdates.current = {};
    const ids = Object.keys(batch);
    if (ids.length === 0) return;

    const store = useCanvasStore.getState();
    for (const id of ids) {
      store.moveNode(id, batch[id].x, batch[id].y);
    }
    syncGroupBounds(ids);
  }, []);

  /** 将一次 moveNode 调用排入 rAF 批次 */
  const scheduleDragUpdate = useCallback(
    (id: string, x: number, y: number) => {
      pendingUpdates.current[id] = { x, y };
      if (!rafId.current) {
        rafId.current = requestAnimationFrame(flushDragUpdates);
      }
    },
    [flushDragUpdates],
  );

  const onNodeDragStart = useCallback(
    (_event: unknown, _node: Node, nodes: Node[]) => {
      _historyPaused = true;

      const storeNodes = useCanvasStore.getState().nodes;
      for (const n of nodes) {
        const sNode = storeNodes[n.id];
        if (sNode) {
          if (sNode.type === "group") {
            const relatedIds = getGroupRelatedNodeIds(n.id, storeNodes);
            for (const rid of relatedIds) {
              const current = storeNodes[rid];
              if (current) {
                dragStartPositions.current[rid] = {
                  x: current.x,
                  y: current.y,
                };
              }
            }
          } else {
            dragStartPositions.current[n.id] = { x: sNode.x, y: sNode.y };
          }
        }
      }
    },
    [],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const store = useCanvasStore.getState();
      let hasDragEnd = false;

      const dragUpdates: Record<string, { x: number; y: number }> = {};

      for (const ch of changes) {
        if (ch.type === "position" && ch.position) {
          if (ch.dragging) {
            const startPos = dragStartPositions.current[ch.id];
            if (startPos) {
              const dx = ch.position.x - startPos.x;
              const dy = ch.position.y - startPos.y;

              const sNode = store.nodes[ch.id];
              if (sNode && sNode.type === "group") {
                const relatedIds = getGroupRelatedNodeIds(ch.id, store.nodes);
                for (const rid of relatedIds) {
                  const rStart = dragStartPositions.current[rid];
                  if (rStart) {
                    dragUpdates[rid] = {
                      x: rStart.x + dx,
                      y: rStart.y + dy,
                    };
                  }
                }
              } else {
                dragUpdates[ch.id] = {
                  x: startPos.x + dx,
                  y: startPos.y + dy,
                };
              }
            } else {
              dragUpdates[ch.id] = { x: ch.position.x, y: ch.position.y };
            }
          } else {
            hasDragEnd = true;
          }
        }
      }

      // 拖拽中走 rAF 批量更新，避免逐帧 setState 触发大量重渲染
      for (const [id, pos] of Object.entries(dragUpdates)) {
        scheduleDragUpdate(id, pos.x, pos.y);
      }

      if (hasDragEnd) {
        // 确保剩余 rAF 中的更新已 flush
        if (rafId.current) {
          cancelAnimationFrame(rafId.current);
          rafId.current = 0;
        }
        flushDragUpdates();

        _historyPaused = false;

        const dragEnds: {
          id: string;
          x: number;
          y: number;
          startX: number;
          startY: number;
        }[] = [];
        for (const ch of changes) {
          if (
            ch.type === "position" &&
            ch.position &&
            ch.dragging === false
          ) {
            const startPos = dragStartPositions.current[ch.id];
            if (startPos) {
              const dx = ch.position.x - startPos.x;
              const dy = ch.position.y - startPos.y;

              const sNode = store.nodes[ch.id];
              if (sNode && sNode.type === "group") {
                const relatedIds = getGroupRelatedNodeIds(ch.id, store.nodes);
                for (const rid of relatedIds) {
                  const rStart = dragStartPositions.current[rid];
                  if (rStart) {
                    dragEnds.push({
                      id: rid,
                      x: rStart.x + dx,
                      y: rStart.y + dy,
                      startX: rStart.x,
                      startY: rStart.y,
                    });
                  }
                }
              } else {
                dragEnds.push({
                  id: ch.id,
                  x: startPos.x + dx,
                  y: startPos.y + dy,
                  startX: startPos.x,
                  startY: startPos.y,
                });
              }
            }
          }
        }

        if (dragEnds.length > 0) {
          const uniqueEndsMap: Record<string, (typeof dragEnds)[0]> = {};
          for (const item of dragEnds) {
            uniqueEndsMap[item.id] = item;
          }
          const uniqueEnds = Object.values(uniqueEndsMap);

          // 还原到拖拽前坐标，以确保 pushHistory 时存入拖拽前的状态
          for (const item of uniqueEnds) {
            store.moveNode(item.id, item.startX, item.startY);
          }
          syncGroupBounds(uniqueEnds.map((item) => item.id));

          // 派发正式的批量位置更新指令
          dispatchCommand({
            type: "updateNodePosition",
            updates: uniqueEnds.map((item) => ({
              id: item.id,
              x: item.x,
              y: item.y,
            })),
          });

          for (const item of uniqueEnds) {
            delete dragStartPositions.current[item.id];
          }
        }
      }
    },
    [scheduleDragUpdate, flushDragUpdates],
  );

  return { dragStartPositions, onNodeDragStart, onNodesChange };
}