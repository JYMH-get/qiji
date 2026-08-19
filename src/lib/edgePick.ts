/**
 * edgePick —— 框选拾取连线（纯函数，第100轮）。
 * 框选范围内**没有节点**时，Canvas 用它按几何拾取框内的连线（连线可多选、受快捷键控制如同节点）。
 * 连线是贝塞尔曲线（源节点右侧中点 → 目标节点左侧中点，水平控制点）：按采样点判定是否落入矩形。
 */

export interface PickRect {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

interface RectNode {
	x: number;
	y: number;
	w?: number;
	h?: number;
}

interface PickEdge {
	id: string;
	source: string;
	target: string;
}

const DEFAULT_W = 240;
const DEFAULT_H = 200;
const SAMPLES = 24;

/** 与 React Flow 默认贝塞尔一致的水平控制点偏移（右出左进；反向时按距离开根收敛） */
function controlOffset(dist: number): number {
	return dist >= 0 ? dist * 0.5 : 0.25 * 25 * Math.sqrt(-dist);
}

export function pickEdgesInRect(
	rect: PickRect,
	nodes: Record<string, RectNode | undefined>,
	edges: PickEdge[],
): string[] {
	const inRect = (x: number, y: number) => x >= rect.x1 && x <= rect.x2 && y >= rect.y1 && y <= rect.y2;
	const hits: string[] = [];
	for (const e of edges) {
		const sn = nodes[e.source];
		const tn = nodes[e.target];
		if (!sn || !tn) continue;
		const sx = sn.x + (sn.w ?? DEFAULT_W);
		const sy = sn.y + (sn.h ?? DEFAULT_H) / 2;
		const tx = tn.x;
		const ty = tn.y + (tn.h ?? DEFAULT_H) / 2;
		const off = controlOffset(tx - sx);
		const c1x = sx + off;
		const c2x = tx - off;
		// 三次贝塞尔采样：P0(sx,sy) P1(c1x,sy) P2(c2x,ty) P3(tx,ty)
		for (let i = 0; i <= SAMPLES; i++) {
			const t = i / SAMPLES;
			const mt = 1 - t;
			const x = mt * mt * mt * sx + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * tx;
			const y = mt * mt * mt * sy + 3 * mt * mt * t * sy + 3 * mt * t * t * ty + t * t * t * ty;
			if (inRect(x, y)) {
				hits.push(e.id);
				break;
			}
		}
	}
	return hits;
}
