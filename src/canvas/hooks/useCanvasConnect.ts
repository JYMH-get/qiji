import { useCallback, useEffect, useRef, useState } from "react";
import type { Connection } from "@xyflow/react";
import { useReactFlow } from "@xyflow/react";
import { dispatchCommand } from "@/command/dispatch";
import { genId } from "@/lib/id";
import { makeNode } from "../nodeFactory";
import { getPlugin } from "@/nodes/pluginRegistry";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { wouldCreateCycle } from "@/dag/validate";
import type { CanvasNode, NodeType } from "@/types";

/** 两组格式有交集即可连 */
const fmtMatch = (a?: string[], b?: string[]) => !!a && !!b && a.some((f) => b.includes(f));

/**
 * 连一条 source→target（端口可省略：按格式交集自动选）；已存在同向边/成环/分组节点/端口不兼容则跳过。
 * 单条与**批量起线**（多选节点从任一节点起线 → 全部选中节点连到同一落点）共用。返回是否已连。
 */
function connectPair(
	nodesMap: Record<string, CanvasNode>,
	sourceId: string,
	targetId: string,
	opts?: { sourcePort?: string; targetPort?: string },
): boolean {
	if (sourceId === targetId) return false;
	const sn = nodesMap[sourceId];
	const tn = nodesMap[targetId];
	if (!sn || !tn || sn.type === "group" || tn.type === "group") return false;
	const sp = getPlugin(sn.type);
	const tp = getPlugin(tn.type);
	if (!sp || !tp) return false;
	const out = (opts?.sourcePort ? sp.outputs.find((o) => o.name === opts.sourcePort) : undefined)
		?? sp.outputs.find((o) => {
			const tIn = opts?.targetPort ? tp.inputs.find((i) => i.name === opts.targetPort) : undefined;
			return tIn ? fmtMatch(o.formats, tIn.formats) : tp.inputs.some((i) => fmtMatch(i.formats, o.formats));
		})
		?? sp.outputs[0];
	if (!out) return false;
	const inPort = (opts?.targetPort ? tp.inputs.find((i) => i.name === opts.targetPort) : undefined)
		?? tp.inputs.find((i) => fmtMatch(i.formats, out.formats));
	if (!inPort || !fmtMatch(out.formats, inPort.formats)) return false;
	const edges = useCanvasStore.getState().edges; // 每次取最新（批量循环中上一条已入图）
	if (Object.values(edges).some((e) => e.source === sourceId && e.target === targetId)) return false;
	if (wouldCreateCycle(edges, sourceId, targetId)) return false;
	dispatchCommand({
		type: "connect",
		edge: { id: genId("edge"), kind: "dataflow", source: sourceId, sourcePort: out.name, target: targetId, targetPort: inPort.name },
	});
	return true;
}

/** 批量起线的源集合：起线节点在多选之中 → 全部选中节点一起起线；否则只有它自己 */
function batchIds(anchorId: string): string[] {
	const sel = useUiStore.getState().selectedNodeIds;
	return sel.length > 1 && sel.includes(anchorId) ? sel : [anchorId];
}

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

  // 点击其他区域关闭连线菜单。延一拍再挂监听，避免连线松手的尾随 click 把刚弹出的菜单立刻关掉。
  useEffect(() => {
    if (!connectMenu) return;
    const close = () => setConnectMenu(null);
    const t = setTimeout(() => document.addEventListener("click", close), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("click", close);
    };
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
    // 批量起线：起线节点在多选之中 → 全部选中节点连到同一落点（从输出起线=都作上游；从输入起线=都作下游）
    const startFromSource = connectStartRef.current?.handleType !== "target";
    const anchorId = startFromSource ? conn.source : conn.target;
    for (const id of batchIds(anchorId)) {
      const isAnchor = id === anchorId;
      if (startFromSource) {
        connectPair(nodesMap, id, conn.target, isAnchor ? { sourcePort: conn.sourceHandle ?? "out", targetPort: conn.targetHandle ?? "in" } : { targetPort: conn.targetHandle ?? "in" });
      } else {
        connectPair(nodesMap, conn.source, id, isAnchor ? { sourcePort: conn.sourceHandle ?? "out", targetPort: conn.targetHandle ?? "in" } : { sourcePort: conn.sourceHandle ?? "out" });
      }
    }
  }, [nodesMap]);

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      if (connectionMadeRef.current || !connectStartRef.current) return;
      const start = connectStartRef.current;
      const target = event.target as HTMLElement;

      // 1) 松手落在**某个节点上**（不必精确到连接点）→ 直接连到该节点（降低连线难度）。
      //    起线节点在多选之中 → **批量起线**：全部选中节点一起连到该落点。
      const nodeEl = target.closest(".react-flow__node") as HTMLElement | null;
      const droppedId = nodeEl?.getAttribute("data-id") ?? null;
      if (droppedId && droppedId !== start.nodeId) {
        for (const id of batchIds(start.nodeId)) {
          const isAnchor = id === start.nodeId;
          if (start.handleType === "source") {
            // 起点输出 → 落点输入（格式需兼容）
            connectPair(nodesMap, id, droppedId, isAnchor && start.handleId ? { sourcePort: start.handleId } : undefined);
          } else {
            // 起点输入 ← 落点输出（落点为上游）
            connectPair(nodesMap, droppedId, id, isAnchor && start.handleId ? { targetPort: start.handleId } : undefined);
          }
        }
        connectStartRef.current = null;
        return;
      }

      // 2) 未落在节点上（空白/连线层等）→ 弹「生成上/下游节点」菜单。
      //    不再要求精确命中 .react-flow__pane（松手时 target 常是连线 SVG，命中不到 pane 会漏弹）。
      const touch = "changedTouches" in event ? event.changedTouches?.[0] : undefined;
      const clientX = "clientX" in event ? event.clientX : touch?.clientX;
      const clientY = "clientY" in event ? event.clientY : touch?.clientY;
      if (clientX === undefined || clientY === undefined) return;

      const flowPos = screenToFlowPosition({ x: clientX, y: clientY });
      setConnectMenu({ x: clientX, y: clientY, flowX: flowPos.x, flowY: flowPos.y });
    },
    [screenToFlowPosition, nodesMap],
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

    // 批量起线同样作用于「拖到空白生成新节点」：全部选中节点一起连到新节点。
    // 用 store 最新节点表（含刚 addNode 的新节点；nodesMap 是渲染快照，不含它）。
    const freshNodes = useCanvasStore.getState().nodes;
    for (const id of batchIds(nodeId)) {
      const isAnchor = id === nodeId;
      if (handleType === "source") {
        connectPair(freshNodes, id, newNode.id, isAnchor && handleId ? { sourcePort: handleId } : undefined);
      } else {
        connectPair(freshNodes, newNode.id, id, isAnchor && handleId ? { targetPort: handleId } : undefined);
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