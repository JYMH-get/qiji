/**
 * tidyLayout —— 画布「整理」总入口：拼图式整理（纯函数，第121轮用户定稿）。
 *
 * 规则：
 * - **族群** = 互相连接在一起的一片节点（无向连通分量，含经分组容器映射的连线），
 *   抽象为一个刚性方块（取内部布局后的包围盒）；孤立单节点也是一个小方块。
 * - **首节点开辟族群**：族群划分完全按连通性——无上游的额外素材节点凭「级别逆向传导」
 *   归属其下游所在族群（10 个 1 级连 1 个 2 级 = 一个族群，第一个 1 级为首节点），
 *   绝不因"入度 0"另开方块；层级/贴近逻辑在 mindmapLayout 内部实现。
 * - **族群内部**照常整理（mindmapLayout：最短连线 + 同类型多分支两行方格例外）。
 * - **族群之间**按最优拼图贪心打包：整体趋向 1:1 方形、方块间隙 = 1.5×rowGap；
 *   按原始位置排序放置、候选点取「长边最小 → 离原方位最近」——尽可能不打乱用户
 *   原有相对方位（仅收紧方块间的空隙）。
 * - **分组容器**：对外有连线（组内子节点的连线映射到容器）→ 作为普通大节点跟随族群
 *   内布局（无 1.5×间隔）；孤立 → 独立方块参与拼图。
 */
import type { CanvasNode, CanvasEdge } from "@/types";
import { mindmapLayout, type MindmapResult } from "./mindmapLayout";

const DEFAULT_W = 240;
const DEFAULT_H = 200;

/**
 * 把原始连线映射到布局单元：组内子节点的对外连线归到组容器名下（组对外有连线=跟随族群），
 * 端点解析不到布局单元（节点已删等）或映射后成自环（组内部连线）的边丢弃。
 * ownerOf：顶层节点 → 自身 id；组内子节点 → 容器 id；未知 → undefined。
 */
export function mapEdgesToUnits(
	edges: CanvasEdge[],
	ownerOf: (nodeId: string) => string | undefined,
): CanvasEdge[] {
	const out: CanvasEdge[] = [];
	for (const e of edges) {
		const s = ownerOf(e.source);
		const t = ownerOf(e.target);
		if (!s || !t || s === t) continue;
		out.push(s === e.source && t === e.target ? e : { ...e, source: s, target: t });
	}
	return out;
}

/** 拼图打包的输入方块：id + 尺寸 + 原始位置（保持相对方位用） */
export interface PackBlock {
	id: string;
	w: number;
	h: number;
	x: number;
	y: number;
}

/**
 * 拼图打包（候选点贪心）：按原始位置(y→x)排序逐个放置；候选点=已放方块的右侧/下方角点；
 * 评分 = 放置后整体包围盒长边最小（趋向 1:1 方形）→ 离原方位最近（尽量不打乱用户布局）。
 * 方块间隙 ≥ gap；返回各方块新左上角坐标（原点区域 ≥0）。
 */
export function packBlocks(blocks: PackBlock[], gap: number): Map<string, { x: number; y: number }> {
	const pos = new Map<string, { x: number; y: number }>();
	if (!blocks.length) return pos;
	const order = blocks.slice().sort((a, b) => a.y - b.y || a.x - b.x);
	// 原方位基准：各方块相对原整体左上角的偏移，作为"离原方位距离"的目标
	const ox = Math.min(...blocks.map((b) => b.x));
	const oy = Math.min(...blocks.map((b) => b.y));

	interface Rect { x: number; y: number; w: number; h: number }
	const placed: Rect[] = [];
	let candidates: { x: number; y: number }[] = [{ x: 0, y: 0 }];
	let maxRight = 0;
	let maxBottom = 0;

	const collides = (x: number, y: number, w: number, h: number) => {
		for (const r of placed) {
			if (x < r.x + r.w + gap && r.x < x + w + gap && y < r.y + r.h + gap && r.y < y + h + gap) return true;
		}
		return false;
	};

	for (const b of order) {
		let best: { x: number; y: number; long: number; dist: number; idx: number } | null = null;
		for (let i = 0; i < candidates.length; i++) {
			const p = candidates[i];
			if (collides(p.x, p.y, b.w, b.h)) continue;
			const long = Math.max(Math.max(maxRight, p.x + b.w), Math.max(maxBottom, p.y + b.h));
			const dist = Math.abs(p.x - (b.x - ox)) + Math.abs(p.y - (b.y - oy));
			if (
				!best ||
				long < best.long ||
				(long === best.long && (dist < best.dist || (dist === best.dist && (p.y < best.y || (p.y === best.y && p.x < best.x)))))
			) {
				best = { x: p.x, y: p.y, long, dist, idx: i };
			}
		}
		// 兜底（理论上 (maxRight+gap, 0) 类位置总可放；候选耗尽时直接排右侧）
		const bx = best ? best.x : maxRight + (placed.length ? gap : 0);
		const by = best ? best.y : 0;
		pos.set(b.id, { x: bx, y: by });
		placed.push({ x: bx, y: by, w: b.w, h: b.h });
		maxRight = Math.max(maxRight, bx + b.w);
		maxBottom = Math.max(maxBottom, by + b.h);
		if (best) candidates.splice(best.idx, 1);
		candidates.push({ x: bx + b.w + gap, y: by }, { x: bx, y: by + b.h + gap });
	}
	return pos;
}

/**
 * 拼图式整理总入口。
 * units：布局单元（顶层节点 + 分组容器；组内子节点不传，随容器平移由调用方处理）；
 * unitEdges：已经 mapEdgesToUnits 映射到单元层的连线；
 * opts.rowGap：族群内部纵向节点间距（族群间隙 = 其 1.5 倍）。
 * 返回：每个布局单元的新坐标。
 */
export function tidyLayout(
	units: CanvasNode[],
	unitEdges: CanvasEdge[],
	opts: { rowGap: number; colGap?: number },
): MindmapResult[] {
	if (!units.length) return [];
	const idSet = new Set(units.map((u) => u.id));
	const wOf = (n: CanvasNode) => n.w ?? DEFAULT_W;
	const hOf = (n: CanvasNode) => n.h ?? DEFAULT_H;

	// ── 无向连通分量 = 族群 ──
	const adj = new Map<string, string[]>();
	for (const u of units) adj.set(u.id, []);
	for (const e of unitEdges) {
		if (!idSet.has(e.source) || !idSet.has(e.target) || e.source === e.target) continue;
		adj.get(e.source)!.push(e.target);
		adj.get(e.target)!.push(e.source);
	}
	const byId = new Map(units.map((u) => [u.id, u] as const));
	const seen = new Set<string>();
	const comps: CanvasNode[][] = [];
	for (const u of units) {
		if (seen.has(u.id)) continue;
		const comp: CanvasNode[] = [];
		const stack = [u.id];
		seen.add(u.id);
		while (stack.length) {
			const id = stack.pop()!;
			comp.push(byId.get(id)!);
			for (const v of adj.get(id) || []) {
				if (!seen.has(v)) {
					seen.add(v);
					stack.push(v);
				}
			}
		}
		comps.push(comp);
	}

	// ── 族群内部布局 + 收集方块 ──
	const blocks: PackBlock[] = [];
	// 分量 id（取首元素 id）→ 归一化到 (0,0) 的内部布局
	const inner = new Map<string, MindmapResult[]>();
	for (const comp of comps) {
		const compId = comp[0].id;
		let layout: MindmapResult[];
		if (comp.length === 1) {
			layout = [{ id: compId, x: 0, y: 0 }];
		} else {
			const compIds = new Set(comp.map((n) => n.id));
			const compEdges = unitEdges.filter((e) => compIds.has(e.source) && compIds.has(e.target));
			layout = mindmapLayout(comp, compEdges, { rowGap: opts.rowGap, colGap: opts.colGap });
		}
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const l of layout) {
			const n = byId.get(l.id)!;
			minX = Math.min(minX, l.x);
			minY = Math.min(minY, l.y);
			maxX = Math.max(maxX, l.x + wOf(n));
			maxY = Math.max(maxY, l.y + hOf(n));
		}
		inner.set(compId, layout.map((l) => ({ id: l.id, x: l.x - minX, y: l.y - minY })));
		blocks.push({
			id: compId,
			w: maxX - minX,
			h: maxY - minY,
			// 原始位置 = 族群当前包围盒左上（拼图保持相对方位的基准）
			x: Math.min(...comp.map((n) => n.x)),
			y: Math.min(...comp.map((n) => n.y)),
		});
	}

	// ── 族群间拼图（间隙 = 1.5×节点间距）──
	const packed = packBlocks(blocks, Math.round(opts.rowGap * 1.5));

	const out: MindmapResult[] = [];
	for (const [compId, layout] of inner) {
		const p = packed.get(compId) ?? { x: 0, y: 0 };
		for (const l of layout) out.push({ id: l.id, x: p.x + l.x, y: p.y + l.y });
	}
	return out;
}
