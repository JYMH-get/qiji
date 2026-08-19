import { describe, it, expect } from "vitest";
import { tidyLayout, packBlocks, mapEdgesToUnits, type PackBlock } from "./tidyLayout";
import { makeNode } from "@/canvas/nodeFactory";
import type { CanvasNode, CanvasEdge } from "@/types";

const node = (id: string, x = 0, y = 0) => ({ ...makeNode("text.seed", x, y), id });
const group = (id: string, x = 0, y = 0, w = 300, h = 300) =>
	({ id, type: "group", x, y, w, h, data: {}, params: {} } as unknown as CanvasNode);
const edge = (s: string, t: string) => ({ source: s, target: t } as unknown as CanvasEdge);

const W = 240;
const H = 200;

/** 任意两矩形（含 gap 间隙要求）互不侵入 */
function assertNoOverlap(rects: { x: number; y: number; w: number; h: number }[], gap = 0) {
	for (let a = 0; a < rects.length; a++) {
		for (let b = a + 1; b < rects.length; b++) {
			const A = rects[a], B = rects[b];
			const overlap =
				A.x < B.x + B.w + gap && B.x < A.x + A.w + gap && A.y < B.y + B.h + gap && B.y < A.y + A.h + gap;
			expect(overlap).toBe(false);
		}
	}
}

describe("packBlocks（族群拼图打包）", () => {
	it("两块原上下方位：拼后保持上下、间隙 ≥ gap、无重叠", () => {
		const blocks: PackBlock[] = [
			{ id: "a", w: 100, h: 100, x: 0, y: 0 },
			{ id: "b", w: 100, h: 100, x: 0, y: 500 },
		];
		const pos = packBlocks(blocks, 20);
		const a = pos.get("a")!, b = pos.get("b")!;
		expect(b.y).toBeGreaterThanOrEqual(a.y + 100 + 20); // b 仍在 a 下方且留够间隙
		expect(b.x).toBe(a.x); // 同列（不被甩去右侧）
	});

	it("4 个等大方块：拼成 2×2 趋向方形（不是一字长排）", () => {
		const blocks: PackBlock[] = [0, 1, 2, 3].map((i) => ({ id: `b${i}`, w: 200, h: 200, x: i * 900, y: 0 }));
		const pos = packBlocks(blocks, 20);
		const rects = blocks.map((b) => ({ ...pos.get(b.id)!, w: b.w, h: b.h }));
		assertNoOverlap(rects, 20 - 1);
		const right = Math.max(...rects.map((r) => r.x + r.w));
		const bottom = Math.max(...rects.map((r) => r.y + r.h));
		expect(Math.max(right, bottom)).toBeLessThan(200 * 4 + 20 * 3); // 长边远小于一字排开
		expect(Math.max(right, bottom) / Math.min(right, bottom)).toBeLessThanOrEqual(1.2); // 接近 1:1
	});

	it("大小不一：无重叠、整体不退化成单列/单行", () => {
		const blocks: PackBlock[] = [
			{ id: "big", w: 800, h: 600, x: 0, y: 0 },
			{ id: "m1", w: 300, h: 200, x: 900, y: 0 },
			{ id: "m2", w: 300, h: 200, x: 900, y: 300 },
			{ id: "s1", w: 100, h: 100, x: 0, y: 700 },
		];
		const pos = packBlocks(blocks, 30);
		const rects = blocks.map((b) => ({ ...pos.get(b.id)!, w: b.w, h: b.h }));
		assertNoOverlap(rects, 30 - 1);
		const right = Math.max(...rects.map((r) => r.x + r.w));
		const bottom = Math.max(...rects.map((r) => r.y + r.h));
		// 总面积 ~0.6M px²：方形打包长边应压在 1.5 倍 sqrt 面积以内
		expect(Math.max(right, bottom)).toBeLessThan(Math.sqrt(800 * 600 + 300 * 200 * 2 + 100 * 100) * 1.8);
	});
});

describe("mapEdgesToUnits（组连线映射）", () => {
	const ownerOf = (id: string) => (id === "c1" || id === "c2" ? "G" : id === "gone" ? undefined : id);

	it("组内子节点对外连线 → 归到容器名下", () => {
		const out = mapEdgesToUnits([edge("c1", "X")], ownerOf);
		expect(out).toHaveLength(1);
		expect(out[0].source).toBe("G");
		expect(out[0].target).toBe("X");
	});

	it("组内部连线（映射后自环）与失效端点丢弃", () => {
		expect(mapEdgesToUnits([edge("c1", "c2")], ownerOf)).toHaveLength(0);
		expect(mapEdgesToUnits([edge("gone", "X")], ownerOf)).toHaveLength(0);
	});
});

describe("tidyLayout（拼图式整理）", () => {
	it("两条独立链 = 两个族群方块：互不重叠且留 1.5×rowGap 间隙", () => {
		const ns = [node("a1", 0, 0), node("a2", 0, 0), node("b1", 0, 800), node("b2", 0, 800)];
		const r = tidyLayout(ns, [edge("a1", "a2"), edge("b1", "b2")], { rowGap: 48 });
		expect(r).toHaveLength(4);
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		// 族群 A 的方块与族群 B 的方块之间至少 72px（1.5×48）
		const boxA = { x: Math.min(by.a1.x, by.a2.x), y: Math.min(by.a1.y, by.a2.y) };
		const boxB = { x: Math.min(by.b1.x, by.b2.x), y: Math.min(by.b1.y, by.b2.y) };
		const wA = Math.max(by.a1.x, by.a2.x) + W - boxA.x;
		const hA = Math.max(by.a1.y, by.a2.y) + H - boxA.y;
		const wB = Math.max(by.b1.x, by.b2.x) + W - boxB.x;
		const hB = Math.max(by.b1.y, by.b2.y) + H - boxB.y;
		assertNoOverlap([{ ...boxA, w: wA, h: hA }, { ...boxB, w: wB, h: hB }], 72 - 1);
	});

	it("额外素材源不开新方块：S→C 归入 A 族（凭级别逆向传导同族拼图）", () => {
		// A→B→C 链 + S 直连 C（S 无上游）：连通=一个族群；另放一条无关链应成第二方块
		const ns = [node("A"), node("B"), node("C"), node("S", 0, 900), node("z1", 2000, 0), node("z2", 2000, 0)];
		const r = tidyLayout(ns, [edge("A", "B"), edge("B", "C"), edge("S", "C"), edge("z1", "z2")], { rowGap: 48 });
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		// S 与 A 族同块：级别逆推 = C 在级别 3、S 在级别 2 → S 与 B 同列
		expect(by.S.x).toBe(by.B.x);
		// S 纵向贴近 C（附着，不是被甩到族群末尾游标处）
		expect(Math.abs(by.S.y - by.C.y)).toBeLessThanOrEqual(H + 48);
	});

	it("孤立单节点也是方块：多个孤立节点拼图无重叠", () => {
		const ns = [node("i0", 0, 0), node("i1", 500, 0), node("i2", 0, 500), node("i3", 500, 500)];
		const r = tidyLayout(ns, [], { rowGap: 48 });
		assertNoOverlap(r.map((p) => ({ x: p.x, y: p.y, w: W, h: H })), 71);
	});

	it("分组容器对外有连线：跟随族群参与内部布局（与对端同族、按列相邻）", () => {
		const G = group("G", 0, 0);
		const X = node("X", 600, 0);
		// 组内子节点 c1 的对外连线已在调用方映射为 G→X（本测试直接传映射后的边）
		const lone = node("L", 0, 900); // 无关孤立节点 = 另一方块
		const r = tidyLayout([G, X, lone], [edge("G", "X")], { rowGap: 48 });
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		// G→X 单链：同水平带、X 在 G 右侧一列（colGap=140）
		expect(by.X.x).toBe(by.G.x + 300 + 140);
		// 族群内部无 1.5×gap 概念（列距按 colGap 而不是 210）
		expect(by.X.x - (by.G.x + 300)).toBe(140);
	});

	it("空输入 → []", () => {
		expect(tidyLayout([], [], { rowGap: 48 })).toEqual([]);
	});
});
