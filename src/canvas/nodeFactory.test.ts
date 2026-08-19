import { describe, it, expect } from "vitest";
import { makeNode, avoidOverlap, resolveCollision, NODE_W, NODE_H } from "./nodeFactory";

const at = (type: string, x: number, y: number) => makeNode(type as any, x, y);
const GAP = 16;
const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
	a.x < b.x + NODE_W + GAP && b.x < a.x + NODE_W + GAP && a.y < b.y + NODE_H + GAP && b.y < a.y + NODE_H + GAP;

describe("avoidOverlap（新增节点不重合）", () => {
	it("无现有节点：原样返回（同引用）", () => {
		const n = at("text.seed", 100, 100);
		expect(avoidOverlap(n, [])).toBe(n);
	});

	it("与现有节点重合：沿对角线错位到不重合处", () => {
		const existing = at("text.seed", 100, 100);
		const out = avoidOverlap(at("image.gen", 100, 100), [existing]);
		expect(out.x).toBeGreaterThan(100);
		expect(out.y).toBeGreaterThan(100);
		expect(overlaps(out, existing)).toBe(false);
	});

	it("分组容器(type=group)被排除：与之重合也不错位", () => {
		const group = at("group", 100, 100);
		const out = avoidOverlap(at("text.seed", 100, 100), [group]);
		expect(out.x).toBe(100);
		expect(out.y).toBe(100);
	});

	it("距离足够远：原样返回", () => {
		const existing = at("text.seed", 100, 100);
		const n = at("text.seed", 1000, 1000);
		expect(avoidOverlap(n, [existing])).toBe(n);
	});

	it("多个相邻节点：找到不与任何节点重合的空位", () => {
		const a = at("text.seed", 100, 100);
		const b = at("text.seed", 128, 128);
		const out = avoidOverlap(at("image.gen", 100, 100), [a, b]);
		expect(overlaps(out, a)).toBe(false);
		expect(overlaps(out, b)).toBe(false);
	});
});

describe("resolveCollision（移动后落点不重合·上下左右就近避让）", () => {
	it("不重合：返回 null（无需移动）", () => {
		const a = at("text.seed", 100, 100);
		expect(resolveCollision(at("image.gen", 1000, 1000), [a])).toBeNull();
	});

	it("完全重合：沿最短的垂直方向(NODE_H<NODE_W)移到空位，水平坐标不变", () => {
		const a = at("text.seed", 100, 100);
		const out = resolveCollision(at("image.gen", 100, 100), [a]);
		expect(out).not.toBeNull();
		expect(out!.x).toBe(100); // 垂直避让 → x 不变（上下方向）
		expect(out!.y).not.toBe(100);
		expect(overlaps(out!, a)).toBe(false);
	});

	it("仅与分组容器重合：返回 null（分组被排除）", () => {
		const group = at("group", 100, 100);
		expect(resolveCollision(at("text.seed", 100, 100), [group])).toBeNull();
	});

	it("上下被占、仅左右有空：沿水平方向避让(y 不变)", () => {
		// 目标(100,100)；正上、正下各放一个 → 垂直走不通，必走左右
		const here = at("text.seed", 100, 100);
		const up = at("text.seed", 100, 100 - (NODE_H + 16));
		const down = at("text.seed", 100, 100 + (NODE_H + 16));
		const out = resolveCollision({ ...here, id: "x" }, [here, up, down]);
		expect(out).not.toBeNull();
		expect(out!.y).toBe(100); // 水平避让 → y 不变
		expect(out!.x).not.toBe(100);
	});
});
