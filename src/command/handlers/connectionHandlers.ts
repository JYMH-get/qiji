import { useCanvasStore } from "@/store/canvasStore";
import { commandBus } from "../commandBus";
import { genId } from "@/lib/id";
import { getPlugin } from "@/nodes/pluginRegistry";
import { upstreamTextSources } from "@/canvas/nodeMaterials";
import { placeUpstreamCapsules } from "@/lib/promptCompose";
import { stripUpstreamCapsules } from "@/lib/upstreamText";
import { PRESET_TAG_RE } from "@/lib/presetSchemes";
import { stripLegend } from "@/lib/shotMaterials";
import type { CanvasGroup, CanvasNode } from "@/types";

const store = () => useCanvasStore.getState();

/** 连入上游文本后，在目标节点提示词补「上游文本」胶囊（明示文本入参）——仅当该节点还没有用户正文时。 */
function addUpstreamCapsuleToNode(nodeId: string): void {
  const s = store();
  const node = s.nodes[nodeId];
  if (!node) return;
  const cur = typeof node.data.params.prompt === "string" ? (node.data.params.prompt as string) : "";
  const n = upstreamTextSources(nodeId).length;
  if (n <= 0) return;
  // 有用户正文（剥掉 图例+上游胶囊+预设胶囊后非空）→ 不动
  const bare = stripLegend(stripUpstreamCapsules(cur)).replace(new RegExp(PRESET_TAG_RE.source, "g"), "").trim();
  if (bare !== "") return;
  const next = placeUpstreamCapsules(cur, n);
  if (next === cur) return;
  useCanvasStore.setState({ nodes: { ...s.nodes, [nodeId]: { ...node, data: { ...node.data, params: { ...node.data.params, prompt: next } } } } });
}

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
    if (c.type !== "connect") return;
    const s = store();
    s.addEdge(c.edge);
    // 连入上游文本 → 明示：在目标节点补「上游文本」胶囊（取消旧的「自动匹配资产」，匹配改为手动点「匹配资产」）。
    const target = s.nodes[c.edge.target];
    const source = s.nodes[c.edge.source];
    const tp = target ? getPlugin(target.type) : null;
    const sp = source ? getPlugin(source.type) : null;
    const isTextSrc = sp?.displayKind === "text" || sp?.displayKind === "chat" || sp?.nodeKind === "seed";
    const tk = tp?.nodeKind ?? "";
    if (target && isTextSrc && tk !== "seed" && tk !== "chat") {
      addUpstreamCapsuleToNode(c.edge.target);
    }
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