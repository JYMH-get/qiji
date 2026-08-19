/**
 * pasteInternal —— 内部节点剪贴板的粘贴落地（Ctrl+V 原生 paste 事件与改绑快捷键共用）。
 * 语义与第88轮一致：粘贴到视口中心（外接矩形中心平移），全能复制的上游连线仅当
 * 原上游节点仍在当前画布时接回；粘贴后双向清空选区（多选工具栏立即收起）。
 */
import { pasteFromClipboard, cloneNodesWithEdges } from "@/lib/clipboard";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { dispatchCommand } from "@/command/dispatch";

/** 把内部剪贴板的节点粘贴到 center（画布坐标）。返回是否粘贴了内容。 */
export function pasteInternalNodes(center: { x: number; y: number }, unselectRf?: () => void): boolean {
	const clipData = pasteFromClipboard();
	if (!clipData || clipData.nodes.length === 0) return false;
	const xs = clipData.nodes.map((n) => n.x);
	const ys = clipData.nodes.map((n) => n.y);
	const xMaxs = clipData.nodes.map((n) => n.x + (n.w || 240));
	const yMaxs = clipData.nodes.map((n) => n.y + (n.h || 200));
	const bcx = (Math.min(...xs) + Math.max(...xMaxs)) / 2;
	const bcy = (Math.min(...ys) + Math.max(...yMaxs)) / 2;
	const dx = center.x - bcx;
	const dy = center.y - bcy;
	// 全能复制的上游连线：仅当原上游节点仍在当前画布上才接回（跨画布/已删则丢弃）
	const nodesNow = useCanvasStore.getState().nodes;
	const upstream = (clipData.upstreamEdges ?? []).filter((ue) => !!nodesNow[ue.source]);
	const built = cloneNodesWithEdges(clipData.nodes, clipData.edges, upstream, { x: dx, y: dy });

	dispatchCommand({ type: "pasteNodes", nodes: built.nodes, edges: built.edges });
	// 粘贴后自动取消多选：清 React Flow 内部选中 + uiStore（多选工具栏立即收起）
	unselectRf?.();
	const ui = useUiStore.getState();
	ui.setSelection([]);
	ui.setEdgeSelection([]);
	ui.setActiveNodeId(null);
	return true;
}
