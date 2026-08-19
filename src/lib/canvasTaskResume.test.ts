import { describe, it, expect } from "vitest";
import { listResumableCanvasTasks, type CanvasNodeTask } from "./canvasTaskResume";

const node = (id: string, task?: Partial<CanvasNodeTask>) => ({
	id,
	data: { task: task as CanvasNodeTask | undefined },
});

describe("listResumableCanvasTasks（画布在途任务找回·挑选层）", () => {
	it("挑出带完整任务标记的节点（多节点、无标记的跳过）", () => {
		const nodes = {
			a: node("a", { taskId: "t1", adapterKey: "managed:m1", startedAt: 1 }),
			b: node("b"),
			c: node("c", { taskId: "t2", adapterKey: "managed:m2" }),
		};
		const out = listResumableCanvasTasks(nodes, new Set());
		expect(out).toEqual([
			{ nodeId: "a", taskId: "t1", adapterKey: "managed:m1" },
			{ nodeId: "c", taskId: "t2", adapterKey: "managed:m2" },
		]);
	});

	it("字段残缺（缺 taskId / 缺 adapterKey）无从找回，不入选", () => {
		const nodes = {
			a: node("a", { adapterKey: "managed:m1" }),
			b: node("b", { taskId: "t1" }),
		};
		expect(listResumableCanvasTasks(nodes, new Set())).toEqual([]);
	});

	it("已在本进程跟踪中的任务跳过（switchCanvas 来回不重复挂轮询）", () => {
		const nodes = {
			a: node("a", { taskId: "t1", adapterKey: "managed:m1" }),
			b: node("b", { taskId: "t2", adapterKey: "managed:m2" }),
		};
		const out = listResumableCanvasTasks(nodes, new Set(["t1"]));
		expect(out).toEqual([{ nodeId: "b", taskId: "t2", adapterKey: "managed:m2" }]);
	});

	it("空画布返回空清单", () => {
		expect(listResumableCanvasTasks({}, new Set())).toEqual([]);
	});
});
