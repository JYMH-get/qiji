import { useCallback, useEffect, useRef, useState } from "react";
import type { Connection } from "@xyflow/react";
import { useReactFlow } from "@xyflow/react";
import { dispatchCommand } from "@/command/dispatch";
import { genId } from "@/lib/id";
import { makeNode } from "../nodeFactory";
import { getPlugin } from "@/nodes/pluginRegistry";
import type { CanvasNode, NodeType } from "@/types";

interface ConnectStartParams {
  nodeId: string | null;
  handleId: string | null;
  handleType: "source" | "target" | null;
}

/** 连线创建：onConnectStart / onConnect / onConnectEnd + 连线菜单状态 */
export function useCanvasConnect(
  nodesMap: Record<string, CanvasNode>,
) {
  const { screenToFlowPosition } = useReactFlow();

  const connectStartRef = useRef<{
    nodeId: string;
    handleId: string | null;
    handleType: "source" | "target";
  } | null>(null);
  const connectionMadeRef = useRef(false);

  const [connectMenu, setConnectMenu] = useState<{
    x: number;
    y: number;
    flowX: number;
    flowY: number;
  } | null>(null);

  // 点击其他区域关闭连线菜单
  useEffect(() => {
    if (!connectMenu) return;
    const close = () => setConnectMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [connectMenu]);

  const onConnectStart = useCallback((_event: unknown, params: ConnectStartParams) => {
    connectStartRef.current = {
      nodeId: params.nodeId ?? "",
      handleId: params.handleId,
      handleType: params.handleType ?? "source",
    };
    connectionMadeRef.current = false;
  }, []);

  const onConnect = useCallback((conn: Connection) => {
    connectionMadeRef.current = true;
    if (!conn.source || !conn.target) return;
    dispatchCommand({
      type: "connect",
      edge: {
        id: genId("edge"),
        kind: "dataflow",
        source: conn.source,
        sourcePort: conn.sourceHandle ?? "out",
        target: conn.target,
        targetPort: conn.targetHandle ?? "in",
      },
    });
  }, []);

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      if (connectionMadeRef.current || !connectStartRef.current) return;

      const target = event.target as HTMLElement;
      const isPane =
        target.classList.contains("react-flow__pane") ||
        target.closest("react-flow__pane");
      if (!isPane) return;

      const clientX =
        "clientX" in event ? event.clientX : (event.touches?.[0]?.clientX);
      const clientY =
        "clientY" in event ? event.clientY : (event.touches?.[0]?.clientY);

      if (clientX === undefined || clientY === undefined) return;

      const flowPos = screenToFlowPosition({ x: clientX, y: clientY });

      setConnectMenu({
        x: clientX,
        y: clientY,
        flowX: flowPos.x,
        flowY: flowPos.y,
      });
    },
    [screenToFlowPosition],
  );

  const onSelectConnectType = (type: NodeType) => {
    if (!connectStartRef.current || !connectMenu) return;

    const { nodeId, handleId, handleType } = connectStartRef.current;
    const newNode = makeNode(type, connectMenu.flowX, connectMenu.flowY);

    const sourceNode = nodesMap[nodeId];
    if (sourceNode?.parentId) {
      newNode.parentId = sourceNode.parentId;
    }

    dispatchCommand({ type: "addNode", node: newNode });

    const def = getPlugin(type);
    if (def) {
      if (handleType === "source") {
        const targetPort = def.inputs[0]?.name;
        if (targetPort) {
          dispatchCommand({
            type: "connect",
            edge: {
              id: genId("edge"),
              kind: "dataflow",
              source: nodeId,
              sourcePort: handleId ?? "out",
              target: newNode.id,
              targetPort,
            },
          });
        }
      } else {
        const sourcePort = def.outputs[0]?.name;
        if (sourcePort) {
          dispatchCommand({
            type: "connect",
            edge: {
              id: genId("edge"),
              kind: "dataflow",
              source: newNode.id,
              sourcePort,
              target: nodeId,
              targetPort: handleId ?? "in",
            },
          });
        }
      }
    }

    setConnectMenu(null);
    connectStartRef.current = null;
  };

  return {
    connectMenu,
    setConnectMenu,
    connectStartRef,
    onConnectStart,
    onConnect,
    onConnectEnd,
    onSelectConnectType,
  };
}