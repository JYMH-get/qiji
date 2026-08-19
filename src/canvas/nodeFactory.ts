import { genId } from "@/lib/id";
import type { CanvasNode, NodeType } from "@/types";
import { getNodeSpec } from "@/nodes/nodeSpecs";
import { inheritSharedParams } from "@/lib/sharedNodeParams";

export const NODE_MIME = "application/Qiji-node";
export const NODE_W = 240;
export const NODE_H = 200;

/**
 * 防重合：若新节点 (x,y,w,h) 与任一现有节点（排除分组容器）相距小于 GAP，
 * 则沿对角线错位 STEP 直到落到空位（带 GAP 间距）。返回坐标调整后的节点副本（无重合则原样返回）。
 * 仅用于"新增节点"，分组内子节点/粘贴/裂变/投影各有自己的布局、不走此逻辑。
 */
export function avoidOverlap(node: CanvasNode, existing: RectNode[]): CanvasNode {
	const STEP = 28, MAX = 120;
	const w = node.w || NODE_W, h = node.h || NODE_H;
	const others = existing.filter((n) => n.id !== node.id && n.type !== "group");
	const hits = (x: number, y: number) => others.some((n) => rectsTooClose(x, y, w, h, n));
	let x = node.x, y = node.y;
	for (let i = 0; i < MAX && hits(x, y); i++) { x += STEP; y += STEP; }
	return x === node.x && y === node.y ? node : { ...node, x, y };
}

/** 碰撞检测/避让用的轻量矩形（CanvasNode 兼容）。 */
type RectNode = { id: string; type: string; x: number; y: number; w?: number; h?: number };

const GAP = 16;
/** 两矩形(各加 GAP 间距)是否相交 */
function rectsTooClose(ax: number, ay: number, aw: number, ah: number, b: RectNode): boolean {
	const bw = b.w || NODE_W, bh = b.h || NODE_H;
	return ax < b.x + bw + GAP && b.x < ax + aw + GAP && ay < b.y + bh + GAP && b.y < ay + ah + GAP;
}

/**
 * 移动后避让：节点落点若与任一障碍(排除分组容器/自身)相交，则沿**上/下/左/右**四个方向各自步进到空位、
 * 取位移最小者返回新坐标；不相交返回 null(无需移动)。用于拖拽落子后的"不重合"纠正。
 */
export function resolveCollision(node: RectNode, obstacles: RectNode[]): { x: number; y: number } | null {
	const STEP = 14, MAX = 240;
	const w = node.w || NODE_W, h = node.h || NODE_H;
	const obs = obstacles.filter((n) => n.id !== node.id && n.type !== "group");
	const hits = (x: number, y: number) => obs.some((n) => rectsTooClose(x, y, w, h, n));
	if (!hits(node.x, node.y)) return null;
	const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]]; // 上 / 下 / 左 / 右
	let best: { x: number; y: number; d: number } | null = null;
	for (const [dx, dy] of dirs) {
		let x = node.x, y = node.y, i = 0;
		while (i < MAX && hits(x, y)) { x += dx * STEP; y += dy * STEP; i++; }
		if (i < MAX) {
			const d = Math.abs(x - node.x) + Math.abs(y - node.y);
			if (!best || d < best.d) best = { x, y, d };
		}
	}
	return best ? { x: best.x, y: best.y } : null;
}

/**
 * 创建一个空白节点（按 spec 预填参数默认值）。
 * 同类型节点共享设置（输出一致性）：当前画布已有同类节点时，共享键（比例/分辨率/模型等）
 * 继承其设置覆盖 spec 默认值——新落子/裂变的节点与画布上既有同类节点保持一致。
 * 调用方随后 Object.assign 的显式参数（裂变 purpose/assetName、处理节点配置等）仍然最优先。
 */
export function makeNode(type: NodeType, x: number, y: number): CanvasNode {
	const spec = getNodeSpec(type);
	const params: Record<string, unknown> = { model: "" };
	for (const f of spec?.params ?? []) {
		if (f.default !== undefined) params[f.key] = f.default;
	}
	Object.assign(params, inheritSharedParams(type));
	// AI对话节点要容纳「用户提问 + 回答」两个文本框，默认高一些
	const h = type === "ai.chat" ? 280 : NODE_H;
	return {
		id: genId(type),
		type,
		x,
		y,
		w: NODE_W,
		h,
		parentId: null,
		parentScriptId: null,
		data: {
			input: {},
			params,
			resultAssetId: null,
		},
	};
}
