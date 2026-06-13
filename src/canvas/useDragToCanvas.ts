import { useReactFlow } from "@xyflow/react";
import { useCanvasStore } from "@/store/canvasStore";
import { dispatchCommand } from "@/command/dispatch";
import { makeNode, NODE_W, NODE_H } from "./nodeFactory";
import type { NodeType } from "@/types";
import { useCallback } from "react";

export type DragItem =
  | { type: "sidebar"; nodeType: NodeType }
  | { type: "asset"; assetId: string; kind: "image" | "video" | "audio" | "script"; name: string };

export function useDragToCanvas() {
  const { screenToFlowPosition } = useReactFlow();

  const startDragToCanvas = useCallback((
    e: React.MouseEvent,
    item: DragItem,
    onFinishClick?: () => void
  ) => {
    // Only handle left click
    if (e.button !== 0) return;

    // Prevent default browser dragging and selecting behavior
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    let hasStartedDragging = false;
    let createdNodeId: string | null = null;
    let tempNode: any = null;

    // Trigger dragging if held for >= 200ms
    let holdTimer = setTimeout(() => {
      triggerDrag(startX, startY);
    }, 200);

    function triggerDrag(clientX: number, clientY: number) {
      if (hasStartedDragging) return;
      hasStartedDragging = true;
      if (holdTimer) clearTimeout(holdTimer);

      const flowPos = screenToFlowPosition({ x: clientX, y: clientY });
      const nodeX = flowPos.x - NODE_W / 2;
      const nodeY = flowPos.y - NODE_H / 2;

      // Create node
      if (item.type === "sidebar") {
        tempNode = makeNode(item.nodeType, nodeX, nodeY);
      } else {
        const nodeType = `file_${item.kind === "script" ? "document" : item.kind}`;
        tempNode = makeNode(nodeType, nodeX, nodeY);
        tempNode.data.resultAssetId = item.assetId;
      }
      createdNodeId = tempNode.id;

      // Add to store directly (no history entry)
      useCanvasStore.getState().addNode(tempNode);
    }

    const handleMouseMove = (ev: MouseEvent) => {
      if (!hasStartedDragging) {
        const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (dist > 3) {
          if (holdTimer) clearTimeout(holdTimer);
          triggerDrag(ev.clientX, ev.clientY);
        }
      }

      if (hasStartedDragging && createdNodeId) {
        const flowPos = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
        useCanvasStore.getState().moveNode(
          createdNodeId,
          flowPos.x - NODE_W / 2,
          flowPos.y - NODE_H / 2
        );
      }
    };

    const handleMouseUp = (_ev: MouseEvent) => {
      if (holdTimer) clearTimeout(holdTimer);
      window.removeEventListener("mousemove", handleMouseMove, true);
      window.removeEventListener("mouseup", handleMouseUp, true);

      if (hasStartedDragging && createdNodeId && tempNode) {
        // Drag finished! Find the final position in store
        const finalNodeState = useCanvasStore.getState().nodes[createdNodeId];
        const finalX = finalNodeState ? finalNodeState.x : tempNode.x;
        const finalY = finalNodeState ? finalNodeState.y : tempNode.y;

        // Temporarily remove from store
        const store = useCanvasStore.getState();
        const nodes = { ...store.nodes };
        delete nodes[createdNodeId];
        const runtime = { ...store.runtime };
        delete runtime[createdNodeId];
        useCanvasStore.setState({ nodes, runtime });

        // Dispatch command to add it at the final position with history tracking
        dispatchCommand({
          type: "addNode",
          node: { ...tempNode, x: finalX, y: finalY }
        });
      } else {
        // Just a click!
        if (onFinishClick) {
          onFinishClick();
        } else if (item.type === "asset") {
          // Add asset node to the center of the viewport
          const screenCenterX = window.innerWidth / 2;
          const screenCenterY = window.innerHeight / 2;
          const flowPos = screenToFlowPosition({ x: screenCenterX, y: screenCenterY });
          const nodeType = `file_${item.kind === "script" ? "document" : item.kind}`;
          const newNode = makeNode(nodeType, flowPos.x - NODE_W / 2, flowPos.y - NODE_H / 2);
          newNode.data.resultAssetId = item.assetId;
          dispatchCommand({ type: "addNode", node: newNode });
        }
      }
    };

    window.addEventListener("mousemove", handleMouseMove, true);
    window.addEventListener("mouseup", handleMouseUp, true);
  }, [screenToFlowPosition]);

  return startDragToCanvas;
}
