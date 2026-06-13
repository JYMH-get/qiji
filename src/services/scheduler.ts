import type { CanvasEdge } from "@/types";

/**
 * 错峰排期闸（Phase 0 雏形）。
 * - 用户设自定义启动时间（不限终止），窗口内 Agent 自动模式只生成、不新建节点。
 * - 依赖感知：continuation 延续边构成强排序，按拓扑序串行；互不依赖者批量并行。
 * - 到窗口后释放进并发队列（见 CreditLedger / 后端并发闸）。
 */
export interface ScheduleWindow {
	startAt: string;
	endAt: string | null;
	interruptible: boolean;
}

/** 对一批待执行节点按 continuation 依赖做拓扑排序，返回可并行的「层」 */
export function topoLayers(
	nodeIds: string[],
	edges: Record<string, CanvasEdge>,
): string[][] {
	const inScope = new Set(nodeIds);
	const indegree = new Map<string, number>();
	const adj = new Map<string, string[]>();
	for (const id of nodeIds) indegree.set(id, 0);
	for (const e of Object.values(edges)) {
		if (e.kind !== "continuation") continue;
		if (!inScope.has(e.source) || !inScope.has(e.target)) continue;
		adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
		indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
	}
	const layers: string[][] = [];
	let frontier = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);
	const seen = new Set<string>();
	while (frontier.length) {
		layers.push(frontier);
		const next: string[] = [];
		for (const id of frontier) {
			seen.add(id);
			for (const m of adj.get(id) ?? []) {
				indegree.set(m, (indegree.get(m) ?? 0) - 1);
				if ((indegree.get(m) ?? 0) === 0 && !seen.has(m)) next.push(m);
			}
		}
		frontier = next;
	}
	return layers;
}
