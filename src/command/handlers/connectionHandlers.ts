import { useCanvasStore } from "@/store/canvasStore";
import { commandBus } from "../commandBus";
import { genId } from "@/lib/id";
import { getPlugin } from "@/nodes/pluginRegistry";
import type { CanvasGroup, CanvasNode } from "@/types";

const store = () => useCanvasStore.getState();

/** 计算一组节点的外接矩形 */
function calcGroupBounds(nodes: { x: number; y: number; w: number; h: number }[]) {
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const xMaxs = nodes.map((n) => n.x + n.w);
  const yMaxs = nodes.map((n) => n.y + n.h);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xMaxs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...yMaxs);
  return {
    groupX: minX - 20,
    groupY: minY - 40,
    groupW: maxX - minX + 40,
    groupH: maxY - minY + 60,
  };
}

export function registerConnectionHandlers(): void {
  commandBus.register("connect", (c) => {
    if (c.type === "connect") store().addEdge(c.edge);
  });

  commandBus.register("disconnect", (c) => {
    if (c.type === "disconnect") store().removeEdge(c.edgeId);
  });

  commandBus.register("insertOnEdge", (c) => {
    if (c.type !== "insertOnEdge") return;
    const s = store();
    const oldEdge = s.edges[c.edgeId];
    if (!oldEdge) return;

    s.addNode(c.node);
    s.removeEdge(c.edgeId);

    const nodeTypeDef = getPlugin(c.nodeType);
    if (nodeTypeDef && nodeTypeDef.inputs.length > 0) {
      s.addEdge({
        id: genId("edge"),
        kind: "dataflow",
        source: oldEdge.source,
        sourcePort: oldEdge.sourcePort,
        target: c.node.id,
        targetPort: nodeTypeDef.inputs[0].name,
      });
    }
    if (nodeTypeDef && nodeTypeDef.outputs.length > 0) {
      s.addEdge({
        id: genId("edge"),
        kind: "dataflow",
        source: c.node.id,
        sourcePort: nodeTypeDef.outputs[0].name,
        target: oldEdge.target,
        targetPort: oldEdge.targetPort,
      });
    }
  });
}

export function registerGroupHandlers(): void {
  commandBus.register("group", (c) => {
    if (c.type !== "group" || c.nodeIds.length < 2) return;
    const s = store();
    const nodes = c.nodeIds.map((id) => s.nodes[id]).filter(Boolean);
    if (nodes.length < 2) return;

    const { groupX, groupY, groupW, groupH } = calcGroupBounds(nodes);
    const groupId = genId("group");

    const groupNode: CanvasNode = {
      id: groupId,
      type: "group",
      x: groupX, y: groupY, w: groupW, h: groupH,
      parentId: null,
      parentScriptId: null,
      data: { input: {}, params: {}, resultAssetId: null },
    };
    s.addNode(groupNode);

    const updatedNodes = { ...store().nodes };
    for (const node of nodes) {
      updatedNodes[node.id] = { ...node, parentId: groupId };
    }
    useCanvasStore.setState({ nodes: updatedNodes });

    const newGroup: CanvasGroup = {
      id: groupId,
      childIds: c.nodeIds,
      x: groupX,
      y: groupY,
    };
    s.setGroups({ ...s.groups, [groupId]: newGroup });
  });

  commandBus.register("ungroup", (c) => {
    if (c.type !== "ungroup") return;
    const s = store();

    if (c.nodeId) {
      const targetNodeId = c.nodeId;
      const groupId = c.groupId;
      const group = s.groups[groupId];
      if (!group) return;

      const remainingNodeIds = group.childIds.filter((id) => id !== targetNodeId);
      if (remainingNodeIds.length < 2) {
        s.removeNode(groupId);
      } else {
        const remainingNodes = remainingNodeIds.map((id) => s.nodes[id]).filter(Boolean);
        if (remainingNodes.length > 0) {
          const { groupX, groupY, groupW, groupH } = calcGroupBounds(remainingNodes);
          const updatedNodes = { ...s.nodes };
          if (updatedNodes[targetNodeId]) {
            updatedNodes[targetNodeId] = { ...updatedNodes[targetNodeId], parentId: null };
          }
          if (updatedNodes[groupId]) {
            updatedNodes[groupId] = { ...updatedNodes[groupId], x: groupX, y: groupY, w: groupW, h: groupH };
          }
          const updatedGroups = { ...s.groups };
          updatedGroups[groupId] = { ...updatedGroups[groupId], childIds: remainingNodeIds, x: groupX, y: groupY };
          useCanvasStore.setState({ nodes: updatedNodes, groups: updatedGroups });
        } else {
          s.removeNode(groupId);
        }
      }
    } else {
      s.removeNode(c.groupId);
    }
  });

  commandBus.register("pasteNodes", (c) => {
    if (c.type !== "pasteNodes") return;
    const s = store();
    for (const node of c.nodes) s.addNode(node);
    for (const edge of c.edges) s.addEdge(edge);
  });
}