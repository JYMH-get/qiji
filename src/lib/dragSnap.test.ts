import { describe, it, expect } from "vitest";
import { snapPosition } from "./dragSnap";

describe("snapPosition（拖动吸附对齐）", () => {
	it("左缘差 ≤ 阈值 → 吸附对齐到其它节点左缘", () => {
		const p = snapPosition({ id: "A", x: 105, y: 0, w: 240, h: 200 }, [{ id: "B", x: 100, y: 400, w: 240, h: 200 }]);
		expect(p.x).toBe(100);
		expect(p.y).toBe(0); // y 无参考线在阈值内，不动
	});

	it("水平中线对齐（y 取最近参考线）", () => {
		const p = snapPosition({ id: "A", x: 1000, y: 96, w: 240, h: 200 }, [{ id: "B", x: 0, y: 100, w: 240, h: 200 }]);
		expect(p.y).toBe(100);
	});

	it("超过阈值不吸附", () => {
		const p = snapPosition({ id: "A", x: 115, y: 0, w: 240, h: 200 }, [{ id: "B", x: 100, y: 400, w: 240, h: 200 }]);
		expect(p.x).toBe(115);
	});

	it("分组容器不作为吸附参考", () => {
		const p = snapPosition({ id: "A", x: 105, y: 0, w: 240, h: 200 }, [
			{ id: "G", type: "group", x: 100, y: 0, w: 400, h: 400 },
		]);
		expect(p.x).toBe(105);
	});

	it("命中时返回参考线：竖线在对齐 x、跨度覆盖 拖动节点↔对齐节点", () => {
		const p = snapPosition({ id: "A", x: 105, y: 0, w: 240, h: 200 }, [{ id: "B", x: 100, y: 400, w: 240, h: 200 }]);
		expect(p.guides.length).toBe(1);
		const g = p.guides[0];
		expect(g.axis).toBe("x");
		expect(g.value).toBe(100);
		expect(g.from).toBeLessThanOrEqual(0); // 覆盖拖动节点顶
		expect(g.to).toBeGreaterThanOrEqual(600); // 覆盖对齐节点底(400+200)
	});

	it("未命中时无参考线", () => {
		const p = snapPosition({ id: "A", x: 500, y: 500, w: 240, h: 200 }, [{ id: "B", x: 100, y: 0, w: 240, h: 200 }]);
		expect(p.guides.length).toBe(0);
	});
});
