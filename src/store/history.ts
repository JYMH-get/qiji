import type { CanvasEdge, CanvasGroup, CanvasNode } from "@/types";

/** 结构快照（仅结构切片入历史；运行态/生成结果不入栈） */
export interface StructuralSnapshot {
	nodes: Record<string, CanvasNode>;
	edges: Record<string, CanvasEdge>;
	groups: Record<string, CanvasGroup>;
	viewport?: { x: number; y: number; zoom: number };
}