import type { CanvasEdge, CanvasGroup, CanvasNode } from "@/types";

/** 结构快照（仅结构切片入历史；运行态/生成结果不入栈） */
export interface StructuralSnapshot {
	nodes: Record<string, CanvasNode>;
	edges: Record<string, CanvasEdge>;
	groups: Record<string, CanvasGroup>;
	viewport?: { x: number; y: number; zoom: number };
}

/**
 * 仅结构撤销：拖动等高频操作应在上层防抖后再 push。
 * Phase 2 接入 canvasStore 的结构切片。
 */
export class HistoryStack {
	private past: StructuralSnapshot[] = [];
	private future: StructuralSnapshot[] = [];
	private limit: number;

	constructor(limit = 100) {
		this.limit = limit;
	}

	push(snapshot: StructuralSnapshot): void {
		this.past.push(snapshot);
		if (this.past.length > this.limit) this.past.shift();
		this.future = [];
	}

	undo(current: StructuralSnapshot): StructuralSnapshot | null {
		const prev = this.past.pop();
		if (!prev) return null;
		this.future.push(current);
		return prev;
	}

	redo(current: StructuralSnapshot): StructuralSnapshot | null {
		const next = this.future.pop();
		if (!next) return null;
		this.past.push(current);
		return next;
	}

	get canUndo(): boolean {
		return this.past.length > 0;
	}
	get canRedo(): boolean {
		return this.future.length > 0;
	}
}
