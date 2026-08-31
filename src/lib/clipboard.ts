import { useRef } from "react";
import type { CanvasEdge, CanvasNode, NodeRuntime } from "@/types";
import { genId } from "./id";

/**
 * 模块级剪贴板：跨组件共享复制数据。
 * 两种复制语义（第88轮）：
 *  - 精准复制（Ctrl+C/V）：只带选中节点 + 选中集内部连线，不带上游；
 *  - 全能复制（右键菜单）：额外记录 upstreamEdges（上游在选中集外的入边）——粘贴时自动把
 *    画布上仍存在的原上游节点接到克隆体上（节点和连线一起复制）。
 */
interface ClipboardData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** 全能复制：上游连线（source=画布上现存的上游节点原 id，target=被复制节点原 id） */
  upstreamEdges?: CanvasEdge[];
}

let clipboardRef: ClipboardData | null = null;
let copiedAt = 0;

/**
 * Alt 拖动时，手势中的原节点会成为被拖走的“副本”，原位克隆继续承接旧结果与下游连线。
 * 这里把被拖走节点收敛为空白抽卡节点，并显式给出待命运行态。
 */
export function prepareAltDragDuplicate(source: CanvasNode): { node: CanvasNode; runtime: NodeRuntime } {
  const node = structuredClone(source);
  const runtime: NodeRuntime = {
    status: "idle",
    progress: 0,
    taskId: null,
    scheduledAt: null,
    error: null,
  };
  // 从资产面板拖入的 upload 节点本身就是结果容器；剥掉结果会只剩一个无意义空壳。
  if (node.type === "upload") return { node, runtime };
  const data = node.data;
  data.resultAssetId = null;
  delete data.resultHistory;
  delete data.resultMetaByAssetId;
  delete data.resultText;
  delete data.shotAssets;
  delete data.fileUri;
  delete data.fileName;
  delete data.fileMime;
  delete data.messages;
  delete data.task;
  delete data.annotation;
  delete data.stage3d;
  return { node, runtime };
}

export function copyToClipboard(nodes: CanvasNode[], edges: CanvasEdge[], upstreamEdges?: CanvasEdge[]): void {
  clipboardRef = { nodes, edges, upstreamEdges };
  copiedAt = Date.now();
}

/** 最近一次内部节点复制的时间戳（0=从未复制）——画布粘贴分流的兜底判据（系统剪贴板标记写失败时用） */
export function lastCopiedAt(): number {
  return copiedAt;
}

export function pasteFromClipboard(): ClipboardData | null {
  return clipboardRef ? structuredClone(clipboardRef) : null;
}

export function hasClipboardData(): boolean {
  return clipboardRef !== null && clipboardRef.nodes.length > 0;
}

/**
 * 克隆一组节点：新 id、位置平移 offset；内部连线随克隆重映射两端；
 * upstreamEdges 的 source 保持指向画布上的**原上游节点**、target 重映射到克隆体（全能复制/ALT 拖动复制用）。
 * 克隆体剥掉 parentId（不悄悄入组）、sourceRef（防被投影同步当残留清理/去重顶掉）
 * 与 task（在途任务标记：一个任务只归一个节点找回，随克隆复制会双挂轮询/双落结果）。
 */
export function cloneNodesWithEdges(
  nodes: CanvasNode[],
  internalEdges: CanvasEdge[],
  upstreamEdges: CanvasEdge[],
  offset: { x: number; y: number } = { x: 0, y: 0 },
): { nodes: CanvasNode[]; edges: CanvasEdge[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const outNodes = nodes.map((n) => {
    const c = structuredClone(n);
    const nid = genId(n.type);
    idMap.set(n.id, nid);
    c.id = nid;
    c.x += offset.x;
    c.y += offset.y;
    c.parentId = null;
    if (c.data) {
      const d = c.data as { sourceRef?: string; task?: unknown };
      delete d.sourceRef;
      delete d.task;
    }
    return c;
  });
  const outEdges: CanvasEdge[] = [];
  for (const e of internalEdges) {
    if (!idMap.has(e.source) || !idMap.has(e.target)) continue;
    outEdges.push({ ...e, id: genId("edge"), source: idMap.get(e.source)!, target: idMap.get(e.target)! });
  }
  for (const e of upstreamEdges) {
    if (!idMap.has(e.target) || idMap.has(e.source)) continue;
    outEdges.push({ ...e, id: genId("edge"), target: idMap.get(e.target)! }); // source 仍指向原上游节点
  }
  return { nodes: outNodes, edges: outEdges, idMap };
}

/** 按选中集收集 内部连线（两端都在集内）与 上游连线（目标在集内、来源在集外） */
export function splitEdgesForCopy(
  nodeIds: Set<string>,
  allEdges: Record<string, CanvasEdge>,
): { internal: CanvasEdge[]; upstream: CanvasEdge[] } {
  const internal: CanvasEdge[] = [];
  const upstream: CanvasEdge[] = [];
  for (const e of Object.values(allEdges)) {
    if (nodeIds.has(e.target) && nodeIds.has(e.source)) internal.push(e);
    else if (nodeIds.has(e.target) && !nodeIds.has(e.source)) upstream.push(e);
  }
  return { internal, upstream };
}

/**
 * React hook：对外暴露剪贴板操作（方便组件内使用）。
 */
export function useClipboardStore() {
  const ref = useRef({ copyToClipboard, pasteFromClipboard, hasClipboardData });
  return ref.current;
}
