import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { useCanvasStore } from "@/store/canvasStore";
import { commandBus } from "../commandBus";
import { registerNodeHandlers } from "./nodeHandlers";
import type { CanvasNode, NodeData } from "@/types";

/**
 * 抽屉式堆叠 · mergeNodeIntoStack 语义锁定：
 *  - source 的 历史+主图 追加进 target.resultHistory（去重、旧→新顺序、target 主图不变）；
 *  - source 节点删除，其连线级联删除；
 *  - source 无结果资产 = 不动；老节点只有主图无 history 也能并入（target 主图自动补册）；
 *  - 结构命令：一次撤销可恢复。
 */

const mkNode = (id: string, data: Partial<NodeData> = {}): CanvasNode => ({
	id,
	type: "video.gen",
	x: 0,
	y: 0,
	w: 240,
	h: 200,
	parentId: null,
	parentScriptId: null,
	data: { input: {}, params: {}, resultAssetId: null, ...data },
});

const dispatch = (sourceId: string, targetId: string) =>
	commandBus.dispatch({ type: "mergeNodeIntoStack", sourceId, targetId }, { source: "gui" });

beforeAll(() => {
	registerNodeHandlers();
});

beforeEach(() => {
	useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
});

describe("mergeNodeIntoStack（拖入堆叠）", () => {
	it("source 历史+主图并入 target 历史（去重），target 主图不变，source 删除且连线级联", () => {
		useCanvasStore.setState({
			nodes: {
				a: mkNode("a", { resultAssetId: "v1", resultHistory: ["v0", "v1"] }),
				b: mkNode("b", { resultAssetId: "v9", resultHistory: ["v8", "v9", "v1"] }),
				u: mkNode("u"),
			},
			edges: {
				e1: { id: "e1", kind: "dataflow", source: "u", sourcePort: "out", target: "b", targetPort: "in" },
			},
		});
		dispatch("b", "a");
		const s = useCanvasStore.getState();
		expect(s.nodes.b).toBeUndefined();
		expect(s.edges.e1).toBeUndefined();
		expect(s.nodes.a.data.resultAssetId).toBe("v1"); // 主图不变
		expect(s.nodes.a.data.resultHistory).toEqual(["v0", "v1", "v8", "v9"]); // v1 去重
	});

	it("老节点只有主图无 history：也能并入，target 主图自动补册", () => {
		useCanvasStore.setState({
			nodes: {
				a: mkNode("a", { resultAssetId: "t1" }),
				b: mkNode("b", { resultAssetId: "s1" }),
			},
		});
		dispatch("b", "a");
		const s = useCanvasStore.getState();
		expect(s.nodes.b).toBeUndefined();
		expect(s.nodes.a.data.resultHistory).toEqual(["t1", "s1"]);
	});

	it("source 无任何结果资产 / 自并入：不做任何变更", () => {
		useCanvasStore.setState({
			nodes: {
				a: mkNode("a", { resultAssetId: "t1", resultHistory: ["t1"] }),
				b: mkNode("b"),
			},
		});
		dispatch("b", "a");
		expect(useCanvasStore.getState().nodes.b).toBeDefined();
		expect(useCanvasStore.getState().nodes.a.data.resultHistory).toEqual(["t1"]);
		dispatch("a", "a");
		expect(useCanvasStore.getState().nodes.a).toBeDefined();
	});

	it("结构命令：一次撤销恢复 source 节点与 target 原历史", () => {
		useCanvasStore.setState({
			nodes: {
				a: mkNode("a", { resultAssetId: "t1", resultHistory: ["t1"] }),
				b: mkNode("b", { resultAssetId: "s1", resultHistory: ["s1"] }),
			},
		});
		dispatch("b", "a");
		expect(useCanvasStore.getState().nodes.b).toBeUndefined();
		useCanvasStore.getState().undo();
		const s = useCanvasStore.getState();
		expect(s.nodes.b).toBeDefined();
		expect(s.nodes.a.data.resultHistory).toEqual(["t1"]);
	});
});
