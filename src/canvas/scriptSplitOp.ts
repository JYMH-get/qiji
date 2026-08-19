/**
 * scriptSplitOp —— 原文节点「拆分」与「重组」落地（互为逆操作）：
 *  - applyScriptSplit：把 ScriptSplitModal 的多段文本牵出多个新「分镜{shotId}-{子号}原文」节点（接在本节点之后）。
 *  - applyMergeTextNodes：多选文本节点按阅读序合并成一个新原文节点，删除源节点（一次撤销）。
 */
import { useCanvasStore } from "@/store/canvasStore";
import { buildScriptSplitRows } from "@/lib/canvasSpawn";
import { nextShotNumber, parentShotId, nextSubIndex, mergedTitle } from "@/lib/scriptSplit";
import { makeNode } from "@/canvas/nodeFactory";
import { getPlugin } from "@/nodes/pluginRegistry";
import { dispatchCommand } from "@/command/dispatch";

/** 节点展示文本（结果文本优先，回退提示词） */
function nodeText(n: { data: { resultText?: unknown; params: Record<string, unknown> } }): string {
	const rt = typeof n.data.resultText === "string" ? n.data.resultText : "";
	const pr = typeof n.data.params.prompt === "string" ? (n.data.params.prompt as string) : "";
	return (rt.trim() ? rt : pr) || "";
}

/** 拆分节点 nodeId：为每段新建一个「分镜{shotId}-{子号}原文」节点、接自本节点。返回新建节点数。 */
export function applyScriptSplit(nodeId: string, segments: string[]): number {
	const s = useCanvasStore.getState();
	const parent = s.nodes[nodeId];
	if (!parent || segments.length < 1) return 0;
	const titles = Object.values(s.nodes).map((n) => String(n.data.title ?? ""));
	// 子号命名：父是「分镜1原文」→ 子为「分镜1-1原文」；父无分镜号则用新顶层号作基
	const shotId = parentShotId(String(parent.data.title ?? ""), nextShotNumber(titles));
	const startSub = nextSubIndex(titles, shotId);
	const { nodes, edges } = buildScriptSplitRows(parent, segments, shotId, startSub);
	if (!nodes.length) return 0;
	dispatchCommand({ type: "spawnNodes", parentId: nodeId, nodes, edges });
	return nodes.length;
}

/** 重组：把多选文本节点按阅读序（上→下、左→右）合并成一个新原文节点，删除源节点。返回被合并节点数（0=不满足）。 */
export function applyMergeTextNodes(nodeIds: string[]): number {
	const s = useCanvasStore.getState();
	const textNodes = nodeIds
		.map((id) => s.nodes[id])
		.filter((n): n is NonNullable<typeof n> => !!n && getPlugin(n.type)?.displayKind === "text");
	if (textNodes.length < 2) return 0;
	// 阅读序：先上后下、同高再左后右
	const sorted = [...textNodes].sort((a, b) => a.y - b.y || a.x - b.x);
	const texts = sorted.map(nodeText).filter((t) => t.trim());
	if (texts.length < 2) return 0;
	const merged = texts.join("\n");
	const allTitles = Object.values(s.nodes).map((n) => String(n.data.title ?? ""));
	const title = mergedTitle(sorted.map((n) => String(n.data.title ?? "")), allTitles);
	const anchor = sorted[0];
	const node = makeNode("smart.infer", anchor.x, anchor.y);
	node.data.title = title;
	node.data.params.prompt = merged;
	node.data.resultText = merged;
	dispatchCommand({ type: "mergeTextNodes", node, deleteSourceIds: sorted.map((n) => n.id) });
	return sorted.length;
}
