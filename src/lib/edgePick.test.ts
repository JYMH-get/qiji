import { describe, it, expect } from "vitest";
import { pickEdgesInRect } from "./edgePick";

const nodes: Record<string, { x: number; y: number; w?: number; h?: number }> = {
	A: { x: 0, y: 0, w: 240, h: 200 },      // 右侧中点 (240,100)
	B: { x: 600, y: 0, w: 240, h: 200 },    // 左侧中点 (600,100)
	C: { x: 600, y: 600, w: 240, h: 200 },  // 左侧中点 (600,700)
};
const eAB = { id: "eAB", source: "A", target: "B" }; // 水平连线 y≈100
const eAC = { id: "eAC", source: "A", target: "C" }; // 下弯贝塞尔（中点约 (420,400)）

describe("pickEdgesInRect（框选拾取连线）", () => {
	it("矩形罩住连线中段（框内无节点）→ 拾取", () => {
		expect(pickEdgesInRect({ x1: 350, y1: 50, x2: 450, y2: 150 }, nodes, [eAB])).toEqual(["eAB"]);
	});

	it("矩形不与连线相交 → 不拾取", () => {
		expect(pickEdgesInRect({ x1: 350, y1: 260, x2: 450, y2: 330 }, nodes, [eAB])).toEqual([]);
	});

	it("贝塞尔弯段命中：斜向连线的曲线中点也能拾取（非只看端点直线）", () => {
		expect(pickEdgesInRect({ x1: 370, y1: 350, x2: 470, y2: 450 }, nodes, [eAC])).toEqual(["eAC"]);
	});

	it("多条连线只拾取相交者", () => {
		const hits = pickEdgesInRect({ x1: 350, y1: 50, x2: 450, y2: 150 }, nodes, [eAB, eAC]);
		expect(hits).toEqual(["eAB"]);
	});

	it("端点节点缺失的边跳过（不抛错）", () => {
		expect(pickEdgesInRect({ x1: 0, y1: 0, x2: 1000, y2: 1000 }, nodes, [{ id: "eX", source: "A", target: "GONE" }])).toEqual([]);
	});
});
