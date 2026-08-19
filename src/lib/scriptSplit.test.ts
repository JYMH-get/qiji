import { describe, it, expect } from "vitest";
import { splitLines, segmentsFromBoundaries, nextShotNumber, parentShotId, nextSubIndex, mergedTitle } from "./scriptSplit";
import { buildScriptSplitRows } from "./canvasSpawn";
import type { CanvasNode } from "@/types";

describe("splitLines（按行切、丢空行）", () => {
	it("去掉纯空白行，保留内容行", () => {
		expect(splitLines("场19-1\n\n人物：林凡\n  \n△封印台上光芒消散")).toEqual([
			"场19-1", "人物：林凡", "△封印台上光芒消散",
		]);
	});
	it("空文本 → 空数组", () => {
		expect(splitLines("")).toEqual([]);
		expect(splitLines("  \n \n")).toEqual([]);
	});
});

describe("segmentsFromBoundaries（按拆分点分组）", () => {
	const lines = ["a", "b", "c", "d"];
	it("无拆分点 → 整体一段", () => {
		expect(segmentsFromBoundaries(lines, [])).toEqual(["a\nb\nc\nd"]);
	});
	it("在第 1、3 行前拆 → 三段", () => {
		expect(segmentsFromBoundaries(lines, [1, 3])).toEqual(["a", "b\nc", "d"]);
	});
	it("越界拆分点忽略（0 与 length）", () => {
		expect(segmentsFromBoundaries(lines, [0, 2, 4])).toEqual(["a\nb", "c\nd"]);
	});
	it("空行数组 → 空段", () => {
		expect(segmentsFromBoundaries([], [1])).toEqual([]);
	});
});

describe("nextShotNumber（分镜号续号）", () => {
	it("取现有最大分镜号 + 1", () => {
		expect(nextShotNumber(["分镜1原文", "分镜5原文", "文本节点", "分镜3原文"])).toBe(6);
	});
	it("无分镜标题 → 从 1 起（子号标题不计顶层号）", () => {
		expect(nextShotNumber(["文本节点", "分镜1-2原文", "", undefined as unknown as string])).toBe(1);
	});
});

describe("parentShotId / nextSubIndex（拆分子号命名）", () => {
	it("父「分镜1原文」→ shotId=1；「分镜1-2原文」→ shotId=1-2（嵌套）", () => {
		expect(parentShotId("分镜1原文", 9)).toBe("1");
		expect(parentShotId("分镜1-2原文", 9)).toBe("1-2");
	});
	it("父非分镜标题 → 回退 fallback 号", () => {
		expect(parentShotId("文本节点", 7)).toBe("7");
		expect(parentShotId("", 3)).toBe("3");
	});
	it("同一 shotId 已有子号 → 续号不撞车", () => {
		expect(nextSubIndex(["分镜1-1原文", "分镜1-2原文", "分镜2-1原文"], "1")).toBe(3);
		expect(nextSubIndex(["分镜1-1原文"], "2")).toBe(1);
	});
});

describe("mergedTitle（重组合并后命名=各分镜号相加）", () => {
	it("拼接各选中节点分镜号（、分隔）", () => {
		expect(mergedTitle(["分镜1-2原文", "分镜2-1原文"], [])).toBe("分镜1-2、2-1原文");
		expect(mergedTitle(["分镜1-1原文", "分镜1-2原文"], [])).toBe("分镜1-1、1-2原文");
		expect(mergedTitle(["分镜1原文", "分镜2原文"], [])).toBe("分镜1、2原文");
	});
	it("含非「分镜…原文」标题（无分镜号）→ 退回新顶层号", () => {
		expect(mergedTitle(["文本节点", "另一个"], ["分镜2原文"])).toBe("分镜3原文");
		expect(mergedTitle(["分镜1-1原文", "文本节点"], ["分镜5原文"])).toBe("分镜6原文");
	});
});

describe("buildScriptSplitRows（拆分牵出新原文节点）", () => {
	const parent: CanvasNode = {
		id: "p1", type: "smart.infer", x: 100, y: 50, w: 300, h: 200, parentId: null, parentScriptId: null,
		data: { input: {}, params: {}, resultAssetId: null, title: "分镜1原文" },
	};
	it("每段一个 smart.infer 节点：分镜{shotId}-{子号}原文标题 + prompt/resultText=段文本 + 接自 parent", () => {
		const { nodes, edges } = buildScriptSplitRows(parent, ["段一", "段二\n段二续"], "1", 1);
		expect(nodes).toHaveLength(2);
		expect(edges).toHaveLength(2);
		expect(nodes.every((n) => n.type === "smart.infer")).toBe(true);
		expect(nodes[0].data.title).toBe("分镜1-1原文");
		expect(nodes[1].data.title).toBe("分镜1-2原文");
		expect(nodes[0].data.params.prompt).toBe("段一");
		expect(nodes[0].data.resultText).toBe("段一");
		expect(nodes[1].data.params.prompt).toBe("段二\n段二续");
		expect(nodes.every((n) => n.parentScriptId === "p1")).toBe(true);
		// 接在 parent 之后、纵向堆叠、落在 parent 右侧
		expect(edges.every((e) => e.source === "p1")).toBe(true);
		expect(edges[0].target).toBe(nodes[0].id);
		expect(nodes[0].x).toBeGreaterThan(parent.x + parent.w);
		expect(nodes[1].y).toBeGreaterThan(nodes[0].y);
	});
});
