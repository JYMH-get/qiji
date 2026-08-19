/**
 * MultiConnectionLine —— 批量起线的拖动预览（第88轮）。
 * React Flow 默认连线预览只画「起线那一根」；多选批量起线时用户看不出"松手会连 N 根"。
 * 本组件替换 connectionLineComponent：锚点线照画，其余**选中节点**各补一根半透明虚线
 * 一起跟随鼠标（从各自的输出/输入边缘出发，方向与起线端一致）。
 */
import type { ConnectionLineComponentProps } from "@xyflow/react";
import { useUiStore } from "@/store/uiStore";
import { useCanvasStore } from "@/store/canvasStore";

const NODE_W = 240;
const NODE_H = 200;

function bezier(sx: number, sy: number, tx: number, ty: number): string {
	const mx = sx + (tx - sx) / 2;
	return `M ${sx},${sy} C ${mx},${sy} ${mx},${ty} ${tx},${ty}`;
}

export function MultiConnectionLine({ fromX, fromY, toX, toY, fromNode, fromHandle }: ConnectionLineComponentProps) {
	const selected = useUiStore((s) => s.selectedNodeIds);
	const anchorId = fromNode?.id;
	const isSource = fromHandle?.type !== "target";

	const paths: { d: string; anchor: boolean }[] = [{ d: bezier(fromX, fromY, toX, toY), anchor: true }];
	if (anchorId && selected.length > 1 && selected.includes(anchorId)) {
		// 拖动期间节点不动，直接读快照（不订阅，避免逐帧重渲染放大）
		const nodes = useCanvasStore.getState().nodes;
		for (const id of selected) {
			if (id === anchorId) continue;
			const n = nodes[id];
			if (!n || n.type === "group") continue;
			const sx = isSource ? n.x + (n.w || NODE_W) : n.x;
			const sy = n.y + (n.h || NODE_H) / 2;
			paths.push({ d: bezier(sx, sy, toX, toY), anchor: false });
		}
	}

	return (
		<g>
			{paths.map((p, i) => (
				<path
					key={i}
					d={p.d}
					fill="none"
					stroke="#8b5cf6"
					strokeWidth={p.anchor ? 2 : 1.5}
					strokeDasharray="6 4"
					opacity={p.anchor ? 1 : 0.55}
				/>
			))}
		</g>
	);
}
