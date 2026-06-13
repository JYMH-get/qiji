import { create } from "zustand";
import type { CanvasEdge, CanvasGroup, CanvasNode, NodeRuntime } from "@/types";
import type { StructuralSnapshot } from "./history";

/**
 * 画布状态：节点 / 连线 / 分组一律用扁平 Map（id 为键），
 * 所有变更走细粒度 action，严禁整数组替换 —— CRDT 友好，将来包 Yjs 即可。
 * runtime 为临时态，不入库。
 */
export interface CanvasState {
  nodes: Record<string, CanvasNode>;
  edges: Record<string, CanvasEdge>;
  groups: Record<string, CanvasGroup>;
  viewport: { x: number; y: number; zoom: number };
  runtime: Record<string, NodeRuntime>;
  past: StructuralSnapshot[];
  future: StructuralSnapshot[];

  addNode: (node: CanvasNode) => void;
  moveNode: (id: string, x: number, y: number) => void;
  resizeNode: (id: string, w: number, h: number) => void;
  updateNodeParams: (id: string, params: Record<string, unknown>) => void;
  removeNode: (id: string) => void;
  addEdge: (edge: CanvasEdge) => void;
  removeEdge: (id: string) => void;
  setRuntime: (id: string, patch: Partial<NodeRuntime>) => void;
  setStructure: (snapshot: StructuralSnapshot) => void;
  setViewport: (viewport: { x: number; y: number; zoom: number }) => void;
  setGroups: (groups: Record<string, CanvasGroup>) => void;
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
}

const DEFAULT_RUNTIME: NodeRuntime = {
  status: "idle",
  progress: 0,
  taskId: null,
  scheduledAt: null,
  error: null,
};

export const useCanvasStore = create<CanvasState>((set) => ({
  nodes: {},
  edges: {},
  groups: {},
  viewport: { x: 0, y: 0, zoom: 0.7 },
  runtime: {},
  past: [],
  future: [],

  addNode: (node) =>
    set((s) => ({
      nodes: { ...s.nodes, [node.id]: node },
      runtime: { ...s.runtime, [node.id]: { ...DEFAULT_RUNTIME } },
    })),
  moveNode: (id, x, y) =>
    set((s) =>
      s.nodes[id]
        ? { nodes: { ...s.nodes, [id]: { ...s.nodes[id], x, y } } }
        : s,
    ),
  resizeNode: (id, w, h) =>
    set((s) =>
      s.nodes[id]
        ? { nodes: { ...s.nodes, [id]: { ...s.nodes[id], w, h } } }
        : s,
    ),
  updateNodeParams: (id, params) =>
    set((s) => {
      const node = s.nodes[id];
      if (!node) return s;
      return {
        nodes: {
          ...s.nodes,
          [id]: {
            ...node,
            data: {
              ...node.data,
              params: { ...node.data.params, ...params },
            },
          },
        },
      };
    }),
  removeNode: (id) =>
    set((s) => {
      const nodes = { ...s.nodes };
      const runtime = { ...s.runtime };
      delete nodes[id];
      delete runtime[id];

      // 级联处理分组：如果被删除节点属于某个分组，从分组中剔除
      const groups = { ...s.groups };
      for (const gid of Object.keys(groups)) {
        const g = groups[gid];
        if (g.childIds.includes(id)) {
          groups[gid] = {
            ...g,
            childIds: g.childIds.filter((cid) => cid !== id),
          };
        }
      }

      // 如果被删除节点是分组节点，释放所有子节点为绝对定位
      if (s.nodes[id]?.type === "group" || s.groups[id]) {
        for (const nid of Object.keys(nodes)) {
          if (nodes[nid].parentId === id) {
            nodes[nid] = {
              ...nodes[nid],
              parentId: null,
            };
          }
        }
        delete groups[id];
      }

      // 级联删除与该节点相连的边
      const edges = { ...s.edges };
      for (const eid of Object.keys(edges)) {
        const e = edges[eid];
        if (e.source === id || e.target === id) delete edges[eid];
      }
      return { nodes, runtime, edges, groups };
    }),
  addEdge: (edge) => set((s) => ({ edges: { ...s.edges, [edge.id]: edge } })),
  removeEdge: (id) =>
    set((s) => {
      const edges = { ...s.edges };
      delete edges[id];
      return { edges };
    }),
  setRuntime: (id, patch) =>
    set((s) => ({
      runtime: {
        ...s.runtime,
        [id]: { ...(s.runtime[id] ?? DEFAULT_RUNTIME), ...patch },
      },
    })),
  setStructure: (snapshot) =>
    set(() => ({
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      groups: snapshot.groups,
      viewport: snapshot.viewport ?? { x: 0, y: 0, zoom: 0.7 },
    })),
  setViewport: (viewport) => set({ viewport }),
  setGroups: (groups) => set({ groups }),
  pushHistory: () =>
    set((s) => {
      const snapshot: StructuralSnapshot = {
        nodes: JSON.parse(JSON.stringify(s.nodes)),
        edges: JSON.parse(JSON.stringify(s.edges)),
        groups: JSON.parse(JSON.stringify(s.groups)),
        viewport: { ...s.viewport },
      };
      const past = [...s.past, snapshot];
      if (past.length > 100) past.shift();
      return { past, future: [] };
    }),
  undo: () =>
    set((s) => {
      const past = [...s.past];
      const prev = past.pop();
      if (!prev) return s;
      const current: StructuralSnapshot = {
        nodes: JSON.parse(JSON.stringify(s.nodes)),
        edges: JSON.parse(JSON.stringify(s.edges)),
        groups: JSON.parse(JSON.stringify(s.groups)),
        viewport: { ...s.viewport },
      };
      return {
        nodes: prev.nodes,
        edges: prev.edges,
        groups: prev.groups,
        viewport: prev.viewport ?? { x: 0, y: 0, zoom: 0.7 },
        past,
        future: [...s.future, current],
      };
    }),
  redo: () =>
    set((s) => {
      const future = [...s.future];
      const next = future.pop();
      if (!next) return s;
      const current: StructuralSnapshot = {
        nodes: JSON.parse(JSON.stringify(s.nodes)),
        edges: JSON.parse(JSON.stringify(s.edges)),
        groups: JSON.parse(JSON.stringify(s.groups)),
        viewport: { ...s.viewport },
      };
      return {
        nodes: next.nodes,
        edges: next.edges,
        groups: next.groups,
        viewport: next.viewport ?? { x: 0, y: 0, zoom: 0.7 },
        past: [...s.past, current],
        future,
      };
    }),
}));
