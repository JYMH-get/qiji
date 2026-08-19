import { describe, it, expect } from "vitest";
import { mindmapLayout } from "./mindmapLayout";
import { makeNode } from "@/canvas/nodeFactory";
import type { CanvasEdge } from "@/types";

const node = (id: string, x = 0, y = 0) => ({ ...makeNode("text.seed", x, y), id });
const img = (id: string, x = 0, y = 0) => ({ ...makeNode("image.gen", x, y), id });
const edge = (s: string, t: string) => ({ source: s, target: t } as unknown as CanvasEdge);

describe("mindmapLayout（思维导图布局）", () => {
	it("空 → []", () => expect(mindmapLayout([], [])).toEqual([]));

	it("单链 A→B→C：同一水平线(主干居中) + x 按列递增", () => {
		const r = mindmapLayout([node("A"), node("B"), node("C")], [edge("A", "B"), edge("B", "C")]);
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		expect(by.A.y).toBe(by.B.y);
		expect(by.B.y).toBe(by.C.y);
		expect(by.B.x).toBeGreaterThan(by.A.x);
		expect(by.C.x).toBeGreaterThan(by.B.x);
	});

	it("分叉 R→{A,B,C}：子节点右移一列 + 纵向散开 + 父居中其间", () => {
		const ns = [node("R"), node("A", 0, 0), node("B", 0, 100), node("C", 0, 200)];
		const r = mindmapLayout(ns, [edge("R", "A"), edge("R", "B"), edge("R", "C")]);
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		expect(by.A.x).toBeGreaterThan(by.R.x);
		expect(by.A.x).toBe(by.B.x);
		expect(by.B.x).toBe(by.C.x);
		const ys = [by.A.y, by.B.y, by.C.y].sort((a, b) => a - b);
		expect(ys[0]).toBeLessThan(ys[1]);
		expect(ys[1]).toBeLessThan(ys[2]);
		expect(by.R.y).toBeCloseTo((ys[0] + ys[2]) / 2, 5);
	});

	it("同级图像叶子≥3：排成最多两行的方格(多列、父节点居中两行)", () => {
		const P = node("P");
		const imgs = [img("i0"), img("i1"), img("i2"), img("i3")]; // 4 → 2 列 × 2 行
		const r = mindmapLayout([P, ...imgs], imgs.map((im) => edge("P", im.id)));
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		const ys = [...new Set(imgs.map((im) => by[im.id].y))].sort((a, b) => a - b);
		const xs = new Set(imgs.map((im) => by[im.id].x));
		expect(ys.length).toBe(2); // 最多两行
		expect(xs.size).toBeGreaterThanOrEqual(2); // 多列
		expect(by.P.y).toBeCloseTo((ys[0] + ys[1]) / 2, 5); // 父居中两行
	});

	it("大量同类型孤岛节点(无连线)≥3：排成最多两行的方格", () => {
		const imgs = [img("i0"), img("i1"), img("i2"), img("i3"), img("i4")]; // 5 孤岛 → 3 列 × 2 行
		const r = mindmapLayout(imgs, []); // 无边 = 全孤岛
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		const ys = [...new Set(imgs.map((im) => by[im.id].y))].sort((a, b) => a - b);
		const xs = new Set(imgs.map((im) => by[im.id].x));
		expect(ys.length).toBe(2); // 最多两行
		expect(xs.size).toBeGreaterThanOrEqual(2); // 多列
	});

	it("不同类型孤岛分组：各自成簇、互不重叠（偏高时允许横向铺开，不再强制竖排）", () => {
		const imgs = [img("i0"), img("i1"), img("i2")]; // 图片孤岛
		const txts = [node("t0"), node("t1"), node("t2")]; // 文本孤岛
		const r = mindmapLayout([...imgs, ...txts], []);
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		// 任意两节点矩形（240×200）不相交
		const rects = r.map((p) => ({ x: p.x, y: p.y, w: 240, h: 200 }));
		for (let a = 0; a < rects.length; a++) {
			for (let b = a + 1; b < rects.length; b++) {
				const A = rects[a], B = rects[b];
				const overlap = A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
				expect(overlap).toBe(false);
			}
		}
		// 同簇仍聚在一起（图片簇内 y 跨度 ≤ 两行）
		const imgYs = imgs.map((im) => by[im.id].y);
		expect(Math.max(...imgYs) - Math.min(...imgYs)).toBeLessThanOrEqual(248);
	});

	it("孤岛多簇不再一路竖排：列高超限后向右另起一列（整体不偏高）", () => {
		const imgs = [img("i0"), img("i1"), img("i2")];
		const txts = [node("t0", 0, 300), node("t1", 0, 310), node("t2", 0, 320)];
		const vids = [0, 1, 2].map((i) => ({ ...makeNode("video.gen", 0, 600 + i), id: `v${i}` }));
		const r = mindmapLayout([...imgs, ...txts, ...vids], []); // 三个方格簇（各 620×448）
		const bottom = Math.max(...r.map((p) => p.y + 200));
		const right = Math.max(...r.map((p) => p.x + 240));
		// 旧行为三簇纵向堆叠 ≈ 1440 高；新行为放不下即右移一列 → 整体高度受 targetH 约束、横向出现第二列
		expect(bottom).toBeLessThan(1200);
		expect(right).toBeGreaterThan(700);
	});

	it("两个根：各自子树纵向不重叠堆叠", () => {
		const ns = [node("R1", 0, 0), node("a", 0, 10), node("R2", 0, 500), node("b", 0, 510)];
		const r = mindmapLayout(ns, [edge("R1", "a"), edge("R2", "b")]);
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		// R1 子树 与 R2 子树 纵向分开
		const tree1 = [by.R1.y, by.a.y];
		const tree2 = [by.R2.y, by.b.y];
		expect(Math.max(...tree1)).toBeLessThan(Math.min(...tree2));
	});

	it("高矮不一不重叠：高节点按实际高度占位（左上/右下坐标，非固定行距）", () => {
		const tall = { ...node("A", 0, 0), h: 600 };
		const ns = [node("R"), tall, node("B", 0, 700)];
		const r = mindmapLayout(ns, [edge("R", "A"), edge("R", "B")]);
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		// B 必须排在 A 的底边之下（600 高），而不是固定 248 行距造成重叠
		expect(by.B.y).toBeGreaterThanOrEqual(by.A.y + 600);
	});

	it("变体连主体（主体→变体 且共享同一父）：不改分层——仍按同级图片进方格、变体紧跟主体之后", () => {
		const P = node("P");
		const A = img("A", 0, 0);
		const B = img("B", 0, 100);
		const V = img("V", 0, 200); // V 是 A 的变体（P→V 与 A→V 并存）
		const r = mindmapLayout([P, A, B, V], [edge("P", "A"), edge("P", "B"), edge("P", "V"), edge("A", "V")]);
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		// 3 个图片叶子仍进方格（V 不因 A→V 边右移成 A 的下游列）：
		// 排序 [A, V, B] → 行优先 2 列：A(行0列0) V(行0列1) B(行1列0)
		expect(by.V.y).toBe(by.A.y); // 变体与主体同行、紧跟其后
		expect(by.V.x).toBeGreaterThan(by.A.x);
		expect(by.B.x).toBe(by.A.x);
		expect(by.B.y).toBeGreaterThan(by.A.y);
	});

	it("处理链（图→图、无共同父）不受变体规则影响：仍按下游分列", () => {
		const A = img("A");
		const U = img("U", 0, 10); // A 的超分结果节点：仅 A→U 一条边
		const r = mindmapLayout([A, U], [edge("A", "U")]);
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		expect(by.U.x).toBeGreaterThan(by.A.x); // 正常分层到下一列
	});

	it("级别逆向传导：无上游素材源贴到其下游左侧一列（不甩到第 0 列）", () => {
		// R→A→B→C 主链（C 级别 4）+ S 直连 C（S 无上游）→ S 属级别 3 = 与 B 同列
		const ns = [node("R"), node("A"), node("B"), node("C"), node("S", 0, 900)];
		const r = mindmapLayout(ns, [edge("R", "A"), edge("A", "B"), edge("B", "C"), edge("S", "C")]);
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		expect(by.S.x).toBe(by.B.x); // 列 = C 列 - 1
		expect(by.S.x).toBeGreaterThan(by.R.x); // 不在第 0 列
		// 纵向附着贴近 C（与 B 同列碰撞由同列扫描下推，仍在邻近一行内）
		expect(Math.abs(by.S.y - by.C.y)).toBeLessThanOrEqual(200 + 48);
	});

	it("纯源支流整体右贴：B→C→X 且主链使 X 在级别 5 → C 贴 X 左一列、B 再左一列", () => {
		const ns = [node("R"), node("a1"), node("a2"), node("a3"), node("X"), node("B", 0, 900), node("C", 0, 900)];
		const r = mindmapLayout(ns, [
			edge("R", "a1"), edge("a1", "a2"), edge("a2", "a3"), edge("a3", "X"),
			edge("B", "C"), edge("C", "X"),
		]);
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		expect(by.C.x).toBe(by.a3.x); // C 级别 = X-1
		expect(by.B.x).toBe(by.a2.x); // B 级别 = C-1（逆推沿链传导）
	});

	it("10 个 1 级连 1 个 2 级 = 一个族群内同列：首节点走树、其余源附着，无重叠", () => {
		const srcs = [0, 1, 2, 3, 4].map((i) => node(`s${i}`, 0, i * 10));
		const X = node("X", 400, 0);
		const r = mindmapLayout([...srcs, X], srcs.map((s) => edge(s.id, "X")));
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		const xs = new Set(srcs.map((s) => by[s.id].x));
		expect(xs.size).toBe(1); // 全部源同列（级别 1）
		expect(by.X.x).toBeGreaterThan(by.s0.x);
		// 两两不重叠
		const rects = r.map((p) => ({ x: p.x, y: p.y, w: 240, h: 200 }));
		for (let a = 0; a < rects.length; a++) {
			for (let b = a + 1; b < rects.length; b++) {
				const A = rects[a], B = rects[b];
				const overlap = A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
				expect(overlap).toBe(false);
			}
		}
	});

	it("宽节点不探入下一列：列宽 = 该列最大节点宽度", () => {
		const wide = { ...node("A", 0, 0), w: 600 };
		const r = mindmapLayout([wide, node("B", 0, 10)], [edge("A", "B")]);
		const by = Object.fromEntries(r.map((x) => [x.id, x]));
		expect(by.B.x).toBeGreaterThanOrEqual(by.A.x + 600);
	});
});
