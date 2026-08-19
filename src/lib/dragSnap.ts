/**
 * dragSnap —— 拖动节点时的「节点间吸附对齐」（纯函数，第100轮，AssetPanel「吸附」开关控制）。
 * 拖动中的节点与其它节点比较 左/中/右（x 三线）与 上/中/下（y 三线），
 * 距任一参考线 ≤ threshold（画布坐标）时吸附到对齐位置；x/y 各自独立取最近者。
 * 返回值带 guides（命中的参考线 + 跨度覆盖 拖动节点↔对齐节点），供画布画对齐线标出对齐对象。
 */

export const SNAP_THRESHOLD = 8;

export interface SnapRect {
	id: string;
	type?: string;
	x: number;
	y: number;
	w?: number;
	h?: number;
}

/** 对齐参考线（画布坐标）：axis=x 为竖线（value=x，from/to 为 y 跨度），axis=y 为横线 */
export interface SnapGuide {
	axis: "x" | "y";
	value: number;
	from: number;
	to: number;
}

const DEFAULT_W = 240;
const DEFAULT_H = 200;
const GUIDE_PAD = 48; // 参考线越过节点两端的出头量（太短=沿边对齐时几乎看不出是线）

export function snapPosition(
	drag: { id: string; x: number; y: number; w?: number; h?: number },
	others: SnapRect[],
	threshold: number = SNAP_THRESHOLD,
): { x: number; y: number; guides: SnapGuide[] } {
	const w = drag.w ?? DEFAULT_W;
	const h = drag.h ?? DEFAULT_H;
	let bestX: { d: number; line: number; other: SnapRect } | null = null;
	let bestY: { d: number; line: number; other: SnapRect } | null = null;
	const dragXs = [drag.x, drag.x + w / 2, drag.x + w];
	const dragYs = [drag.y, drag.y + h / 2, drag.y + h];
	for (const o of others) {
		if (o.id === drag.id || o.type === "group") continue;
		const ow = o.w ?? DEFAULT_W;
		const oh = o.h ?? DEFAULT_H;
		for (const ox of [o.x, o.x + ow / 2, o.x + ow]) {
			for (const dx of dragXs) {
				const d = ox - dx;
				if (Math.abs(d) <= threshold && (bestX === null || Math.abs(d) < Math.abs(bestX.d))) {
					bestX = { d, line: ox, other: o };
				}
			}
		}
		for (const oy of [o.y, o.y + oh / 2, o.y + oh]) {
			for (const dy of dragYs) {
				const d = oy - dy;
				if (Math.abs(d) <= threshold && (bestY === null || Math.abs(d) < Math.abs(bestY.d))) {
					bestY = { d, line: oy, other: o };
				}
			}
		}
	}
	const x = drag.x + (bestX?.d ?? 0);
	const y = drag.y + (bestY?.d ?? 0);
	const guides: SnapGuide[] = [];
	if (bestX) {
		const o = bestX.other;
		guides.push({
			axis: "x",
			value: bestX.line,
			from: Math.min(y, o.y) - GUIDE_PAD,
			to: Math.max(y + h, o.y + (o.h ?? DEFAULT_H)) + GUIDE_PAD,
		});
	}
	if (bestY) {
		const o = bestY.other;
		guides.push({
			axis: "y",
			value: bestY.line,
			from: Math.min(x, o.x) - GUIDE_PAD,
			to: Math.max(x + w, o.x + (o.w ?? DEFAULT_W)) + GUIDE_PAD,
		});
	}
	return { x, y, guides };
}
