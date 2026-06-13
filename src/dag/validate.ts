import type { CanvasEdge } from "@/types";
import { useCanvasStore } from "@/store/canvasStore";
import { getPlugin } from "@/nodes/pluginRegistry";

/**
 * 严格单向 DAG：连线前跑 DFS 防环，成环即拒连。
 * DAG 仅表达数据血缘（含 continuation 延续依赖），不表达执行顺序。
 */
export function wouldCreateCycle(
	edges: Record<string, CanvasEdge>,
	source: string,
	target: string,
): boolean {
	if (source === target) return true;
	const adjacency = new Map<string, string[]>();
	for (const edge of Object.values(edges)) {
		const list = adjacency.get(edge.source) ?? [];
		list.push(edge.target);
		adjacency.set(edge.source, list);
	}
	// 新边 source -> target；若 target 已能到达 source，则成环
	const stack = [target];
	const visited = new Set<string>();
	while (stack.length) {
		const cur = stack.pop()!;
		if (cur === source) return true;
		if (visited.has(cur)) continue;
		visited.add(cur);
		for (const next of adjacency.get(cur) ?? []) stack.push(next);
	}
	return false;
}

/** React Flow isValidConnection 适配 */
export function makeIsValidConnection(
	_getEdges: () => Record<string, CanvasEdge>,
) {
	return (conn: any): boolean => {
		if (!conn.source || !conn.target) return false;
		if (conn.source === conn.target) return false;

		const nodes = useCanvasStore.getState().nodes;
		const sourceNode = nodes[conn.source];
		const targetNode = nodes[conn.target];
		if (!sourceNode || !targetNode) return false;

		// Group 节点属于层级定位分组，不作一般连线格式校验
		if (sourceNode.type === "group" || targetNode.type === "group") return true;

		const sourcePlugin = getPlugin(sourceNode.type);
		const targetPlugin = getPlugin(targetNode.type);
		if (!sourcePlugin || !targetPlugin) return false;

		const sourceOutput = sourcePlugin.outputs.find((o) => o.name === conn.sourceHandle);
		const targetInput = targetPlugin.inputs.find((i) => i.name === conn.targetHandle);
		if (!sourceOutput || !targetInput) return false;

		// 格式交集检验：目标的输入格式必须支持源端的输出格式
		return targetInput.formats.some((f) => sourceOutput.formats.includes(f));
	};
}
