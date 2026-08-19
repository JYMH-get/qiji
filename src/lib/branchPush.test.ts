import { describe, it, expect } from "vitest";
import { collectBranch, computeBranchPush, enforceNoOverlap, type PushRect, type PushEdge } from "./branchPush";

const rect = (id: string, x: number, y: number, w = 240, h = 200, type = "text.seed"): PushRect => ({
	id,
	type,
	x,
	y,
	w,
	h,
	parentId: null,
});
const edge = (source: string, target: string): PushEdge => ({ source, target });

describe("collectBranch（同枝干收集：下游子树 + 独占上游链）", () => {
	it("流水线 t→i→v：从中间节点收集 = 整行（独占上游 t 纳入）", () => {
		const set = collectBranch("i", [edge("t", "i"), edge("i", "v")]);
		expect([...set].sort()).toEqual(["i", "t", "v"]);
	});

	it("共享上游不纳入：R→{a,b}，a→a2，收 a 的枝干不含 R（R 还有别的分支）", () => {
		const set = collectBranch("a", [edge("R", "a"), edge("R", "b"), edge("a", "a2")]);
		expect(set.has("R")).toBe(false);
		expect([...set].sort()).toEqual(["a", "a2"]);
	});
});

describe("computeBranchPush（拖动压住 → 枝干让位）", () => {
	it("未压住任何节点 → null", () => {
		const res = computeBranchPush([{ id: "A", x: 0, y: 0, w: 240, h: 200 }], [rect("B", 1000, 1000)], []);
		expect(res).toBeNull();
	});

	it("压住 B（A 中心在上方）→ B 下移让位（带 16px 间距）", () => {
		const res = computeBranchPush([{ id: "A", x: 0, y: 0, w: 240, h: 200 }], [rect("B", 100, 100)], []);
		expect(res).not.toBeNull();
		expect(res!.targetId).toBe("B");
		// dy = A 底(200) + GAP(16) - B 顶(100) = 116 → B 顶 = 216
		expect(res!.moved.get("B")).toEqual({ x: 100, y: 216 });
	});

	it("A 中心在 B 中心下方 → B 上移让位", () => {
		const res = computeBranchPush([{ id: "A", x: 0, y: 300, w: 240, h: 200 }], [rect("B", 0, 180)], []);
		// dy = A 顶(300) - GAP(16) - B 高(200) - B 顶(180) = -96 → B 顶 = 84
		expect(res!.moved.get("B")).toEqual({ x: 0, y: 84 });
	});

	it("整行让位：压住流水线中间的 i → t/i/v 同枝干一起挤开", () => {
		const nodes = [rect("t", 0, 0), rect("i", 300, 0), rect("v", 600, 0)];
		const edges = [edge("t", "i"), edge("i", "v")];
		const res = computeBranchPush([{ id: "A", x: 320, y: -60, w: 240, h: 200 }], nodes, edges);
		expect(res!.targetId).toBe("i");
		// dy = -60+200+16 - 0 = 156，整行同步
		for (const id of ["t", "i", "v"]) expect(res!.moved.get(id)!.y).toBe(156);
	});

	it("级联保距：B 被挤到 C 身上 → C 随 B 位移平移、保留原有间距（不压到最小 GAP）", () => {
		// B(顶100) 与 C(顶340) 原间距 = 340-(100+200) = 40；A 压 B → B 顶216（让出 A，间距 GAP）。
		// C 按 B 的位移(116)平移 → C 顶 = 340+116 = 456，与 B 底(416) 仍保留 40 间距（不再挤成 16）。
		const nodes = [rect("B", 0, 100), rect("C", 0, 340)];
		const res = computeBranchPush([{ id: "A", x: 0, y: 0, w: 240, h: 200 }], nodes, []);
		expect(res!.moved.get("B")!.y).toBe(216);
		expect(res!.moved.get("C")!.y).toBe(456); // 保距：340 + B位移116；C底 vs B底间距 = 40（原样）
	});

	it("级联保距·整列平移：竖列 B/C/D 各留 40 间距 → 插入后整列同移 116、间距全部保留（不挤成一团）", () => {
		const nodes = [rect("B", 0, 100), rect("C", 0, 340), rect("D", 0, 580)];
		const res = computeBranchPush([{ id: "A", x: 0, y: 0, w: 240, h: 200 }], nodes, []);
		const yB = res!.moved.get("B")!.y, yC = res!.moved.get("C")!.y, yD = res!.moved.get("D")!.y;
		expect(yB).toBe(216);
		expect(yC).toBe(456);
		expect(yD).toBe(696);
		// 相邻间距全部保持 40（原样），没有被压到最小 GAP
		expect(yC - (yB + 200)).toBe(40);
		expect(yD - (yC + 200)).toBe(40);
	});

	it("多选整组拖动：两个拖动矩形分别压住 B/C（不同枝干）→ 两者都让位", () => {
		const nodes = [rect("B", 0, 200), rect("C", 600, 200)];
		const drags = [
			{ id: "A1", x: 0, y: 100, w: 240, h: 200 },
			{ id: "A2", x: 600, y: 100, w: 240, h: 200 },
		];
		const res = computeBranchPush(drags, nodes, []);
		expect(res).not.toBeNull();
		// 方向按压得最多的拖动矩形定：A1 中心(200) ≤ B 中心(300) → 下移；两者都让到 拖动底+GAP
		expect(res!.moved.get("B")!.y).toBe(316); // 100+200+16
		expect(res!.moved.get("C")!.y).toBe(316);
	});

	it("skipTarget 排除主目标（堆叠并入候选）→ 不挤，返回 null", () => {
		const res = computeBranchPush([{ id: "A", x: 0, y: 0, w: 240, h: 200 }], [rect("B", 100, 100)], [], {
			skipTarget: (n) => n.id === "B",
		});
		expect(res).toBeNull();
	});

	it("分组容器与分组子节点不参与让位", () => {
		const g = rect("G", 100, 100, 240, 200, "group");
		const child = { ...rect("c", 100, 100), parentId: "G" };
		const res = computeBranchPush([{ id: "A", x: 0, y: 0, w: 240, h: 200 }], [g, child], []);
		expect(res).toBeNull();
	});

	it("拖动矩形同时压住两行 → 两行不叠到同一坐标（级联允许再推已让位枝干；「节点丢失」假象修复）", () => {
		// 行2 y=300、行3 y=600（每行 t→i→v，共享上游 split）；拖动矩形 y=430 同时压住两行
		const nodes = [
			rect("split", -350, 450),
			rect("t2", 0, 300), rect("i2", 320, 300), rect("v2", 640, 300),
			rect("t3", 0, 600), rect("i3", 320, 600), rect("v3", 640, 600),
		];
		const edges = [
			edge("split", "t2"), edge("t2", "i2"), edge("i2", "v2"),
			edge("split", "t3"), edge("t3", "i3"), edge("i3", "v3"),
		];
		const res = computeBranchPush([{ id: "D", x: 320, y: 430, w: 240, h: 200 }], nodes, edges);
		expect(res!.targetId).toBe("i2");
		const y2 = res!.moved.get("i2")!.y;
		const y3 = res!.moved.get("i3")!.y;
		expect(y2).toBe(214); // 行2 让到拖动矩形上方（430-16-200）
		expect(y3).toBe(-2); // 行3 追加让位后与行2 重叠 → 级联再推到行2 上方（214-16-200）
		expect(Math.abs(y2 - y3)).toBeGreaterThanOrEqual(216); // 不再完全重叠（200 高 + 16 间距）
		for (const id of ["t2", "i2", "v2"]) expect(res!.moved.get(id)!.y).toBe(y2);
		for (const id of ["t3", "i3", "v3"]) expect(res!.moved.get(id)!.y).toBe(y3);
	});

	it("forceDir=1：即使拖动矩形中心在目标下方也恒向下让位（裂变落位挤开语义）", () => {
		// drag 中心(300) 在 B 中心(280) 下方 → 缺省会上移；forceDir=1 强制下移
		const res = computeBranchPush(
			[{ id: "N", x: 0, y: 200, w: 240, h: 200 }],
			[rect("B", 0, 180)],
			[],
			{ forceDir: 1 },
		);
		expect(res!.moved.get("B")!.y).toBe(416); // 200+200+16，向下让位
	});

	it("exclude：被排除节点（裂变父节点）既不作目标也不被级联波及", () => {
		// P 被 N 压住但在 exclude 里 → 不动；真正被挤的是同样被压住的 C
		const nodes = [rect("P", 0, 100), rect("C", 300, 100)];
		const res = computeBranchPush(
			[
				{ id: "N1", x: 0, y: 0, w: 240, h: 200 },
				{ id: "N2", x: 300, y: 0, w: 240, h: 200 },
			],
			nodes,
			[],
			{ forceDir: 1, exclude: new Set(["P"]) },
		);
		expect(res!.moved.has("P")).toBe(false);
		expect(res!.moved.get("C")!.y).toBe(216); // 0+200+16
	});

	it("同枝干内部本就重叠 → 级联跳过（不把自己枝干推到天边、不空转）", () => {
		// t 与 i 同枝干且用户本就叠放（150 与 250，相互重叠）；被压后整枝同步位移、相对不变
		const nodes = [rect("t", 0, 150), rect("i", 0, 250)];
		const edges = [edge("t", "i")];
		const res = computeBranchPush([{ id: "A", x: 0, y: 0, w: 240, h: 200 }], nodes, edges);
		expect(res!.moved.get("t")!.y).toBe(216); // 0+200+16
		expect(res!.moved.get("i")!.y).toBe(316); // 整枝 +66，相对间距保持
	});
});

describe("enforceNoOverlap（全局严格不重叠：按生成时间裁决、多级级联）", () => {
	const noneIntersect = (all: PushRect[], moves: Map<string, { x: number; y: number }> | null) => {
		const final = all.map((n) => {
			const m = moves?.get(n.id);
			return m ? { ...n, x: m.x, y: m.y } : n;
		});
		for (let i = 0; i < final.length; i++)
			for (let j = i + 1; j < final.length; j++) {
				const a = final[i];
				const b = final[j];
				const hit = a.x < b.x + (b.w ?? 240) && b.x < a.x + (a.w ?? 240) && a.y < b.y + (b.h ?? 200) && b.y < a.y + (a.h ?? 200);
				expect(hit, `${a.id}×${b.id} 仍相交`).toBe(false);
			}
	};

	it("晚生成留位、早生成整枝向下让位（同行一起走）", () => {
		// 数组序=生成序：行 t→i→v 先生成；A 后生成压在 i 上 → 整行让到 A 下方
		const nodes = [rect("t", 0, 0), rect("i", 300, 0), rect("v", 600, 0), rect("A", 300, -50)];
		const edges = [edge("t", "i"), edge("i", "v")];
		const moves = enforceNoOverlap(nodes, edges);
		for (const id of ["t", "i", "v"]) expect(moves!.get(id)!.y).toBe(166); // A 底(150)+16
		expect(moves!.has("A")).toBe(false);
		noneIntersect(nodes, moves);
	});

	it("多级级联：A 挤开 b，b 让位压到 c 链 → c1..c4 一起被挤开", () => {
		const nodes = [
			rect("c1", 0, 300), rect("c2", 300, 300), rect("c3", 600, 300), rect("c4", 900, 300),
			rect("b", 0, 150),
			rect("A", 0, 0),
		];
		const edges = [edge("c1", "c2"), edge("c2", "c3"), edge("c3", "c4")];
		const moves = enforceNoOverlap(nodes, edges);
		expect(moves!.get("b")!.y).toBe(216); // 让出 A（200+16）
		for (const id of ["c1", "c2", "c3", "c4"]) expect(moves!.get(id)!.y).toBe(432); // 让出 b（216+200+16）
		noneIntersect(nodes, moves);
	});

	it("同枝干内部重叠：整枝推不开 → 只挪早生成的冲突节点", () => {
		const nodes = [rect("t", 0, 0), rect("i", 0, 100)];
		const edges = [edge("t", "i")];
		const moves = enforceNoOverlap(nodes, edges);
		expect(moves!.get("t")!.y).toBe(316); // t(早) 让到 i(晚) 下方：100+200+16
		expect(moves!.has("i")).toBe(false);
		noneIntersect(nodes, moves);
	});

	it("本就无重叠 → null；分组容器/子节点不参与", () => {
		expect(enforceNoOverlap([rect("a", 0, 0), rect("b", 0, 300)], [])).toBeNull();
		const g = rect("G", 0, 0, 240, 200, "group");
		const child = { ...rect("c", 0, 0), parentId: "G" };
		expect(enforceNoOverlap([g, child, rect("d", 10, 10)], [])).toBeNull();
	});
});
