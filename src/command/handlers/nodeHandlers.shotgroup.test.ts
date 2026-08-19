import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { useCanvasStore } from "@/store/canvasStore";
import { commandBus } from "../commandBus";
import { registerNodeHandlers } from "./nodeHandlers";
import { buildShotGroupNode, defaultGridFor, moveItem, parseRatio, shotGroupSize, shotGridOf } from "@/lib/shotGroup";
import type { CanvasNode, NodeData } from "@/types";

/**
 * 分镜组命令语义锁定：
 *  - createShotGroup：组节点落子 + 源图片节点删除（连线级联），一次撤销恢复全部；
 *  - updateShotGroup：整组替换 shotAssets（排序/清空）；
 *  - dissolveShotGroup：每张图裂变 image.gen 节点（带 resultAssetId+history），组节点删除。
 */

const mkImgNode = (id: string, data: Partial<NodeData> = {}): CanvasNode => ({
	id,
	type: "image.gen",
	x: 0,
	y: 0,
	w: 240,
	h: 200,
	parentId: null,
	parentScriptId: null,
	data: { input: {}, params: {}, resultAssetId: null, ...data },
});

beforeAll(() => {
	registerNodeHandlers();
});

beforeEach(() => {
	useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
});

describe("shotGroup 纯函数", () => {
	it("defaultGridFor：预设容量够用的最小档；超出 4×4 按 4 列增行", () => {
		expect(defaultGridFor(3)).toEqual({ rows: 2, cols: 2 });
		expect(defaultGridFor(5)).toEqual({ rows: 2, cols: 3 });
		expect(defaultGridFor(9)).toEqual({ rows: 3, cols: 3 });
		expect(defaultGridFor(12)).toEqual({ rows: 3, cols: 4 });
		expect(defaultGridFor(16)).toEqual({ rows: 4, cols: 4 });
		expect(defaultGridFor(18)).toEqual({ rows: 5, cols: 4 });
	});

	it("parseRatio：合法比例解析，非法回退 16:9", () => {
		expect(parseRatio("4:3")).toBeCloseTo(4 / 3);
		expect(parseRatio("1.78:1")).toBeCloseTo(1.78);
		expect(parseRatio("垃圾")).toBeCloseTo(16 / 9);
		expect(parseRatio(undefined)).toBeCloseTo(16 / 9);
	});

	it("moveItem：重排/越界原样返回", () => {
		expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
		expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
		const arr = ["a", "b"];
		expect(moveItem(arr, 0, 5)).toBe(arr);
		expect(moveItem(arr, 1, 1)).toBe(arr);
	});

	it("shotGroupSize/shotGridOf：宫格×比例定尺寸；参数缺省兜底 2×2 16:9", () => {
		const { w, h } = shotGroupSize(2, 2, "1:1", 100);
		expect(w).toBe(2 * 100 + 6 + 16);
		expect(h).toBe(2 * 100 + 6 + 16);
		const g = shotGridOf({ data: { input: {}, params: {}, resultAssetId: null } });
		expect(g).toEqual({ rows: 2, cols: 2, ratio: "16:9", showIndex: false });
	});
});

describe("createShotGroup / updateShotGroup / dissolveShotGroup", () => {
	it("创建：组节点落子、源节点删除且连线级联；一次撤销全部恢复", () => {
		useCanvasStore.setState({
			nodes: {
				a: mkImgNode("a", { resultAssetId: "P1" }),
				b: mkImgNode("b", { resultAssetId: "P2" }),
				u: mkImgNode("u"),
			},
			edges: {
				e1: { id: "e1", kind: "dataflow", source: "u", sourcePort: "out", target: "a", targetPort: "in" },
			},
		});
		const group = buildShotGroupNode({ assets: ["P1", "P2"], x: 0, y: 0 });
		commandBus.dispatch({ type: "createShotGroup", node: group, deleteSourceIds: ["a", "b"] }, { source: "gui" });
		const s = useCanvasStore.getState();
		expect(s.nodes.a).toBeUndefined();
		expect(s.nodes.b).toBeUndefined();
		expect(s.edges.e1).toBeUndefined();
		const g = s.nodes[group.id];
		expect(g?.type).toBe("shot.group");
		expect(g?.data.shotAssets).toEqual(["P1", "P2"]);
		useCanvasStore.getState().undo();
		const s2 = useCanvasStore.getState();
		expect(s2.nodes.a).toBeDefined();
		expect(s2.nodes[group.id]).toBeUndefined();
		expect(s2.edges.e1).toBeDefined();
	});

	it("updateShotGroup：整组替换资产列表（排序/清空）", () => {
		const group = buildShotGroupNode({ assets: ["P1", "P2", "P3"], x: 0, y: 0 });
		useCanvasStore.setState({ nodes: { [group.id]: group } });
		commandBus.dispatch({ type: "updateShotGroup", nodeId: group.id, assets: ["P3", "P1", "P2"] }, { source: "gui" });
		expect(useCanvasStore.getState().nodes[group.id].data.shotAssets).toEqual(["P3", "P1", "P2"]);
		commandBus.dispatch({ type: "updateShotGroup", nodeId: group.id, assets: [] }, { source: "gui" });
		expect(useCanvasStore.getState().nodes[group.id].data.shotAssets).toEqual([]);
	});

	it("单独解除：该格移出宫格 + 裂变 image.gen 承载，组节点保留；一次撤销整体回退", () => {
		const group = buildShotGroupNode({ assets: ["P1", "P2", "P3"], x: 100, y: 50 });
		useCanvasStore.setState({ nodes: { [group.id]: group } });
		commandBus.dispatch({ type: "extractShotGroupItem", nodeId: group.id, index: 1 }, { source: "gui" });
		const s = useCanvasStore.getState();
		expect(s.nodes[group.id]?.data.shotAssets).toEqual(["P1", "P3"]);
		const child = Object.values(s.nodes).find((n) => n.type === "image.gen");
		expect(child?.data.resultAssetId).toBe("P2");
		expect(child?.data.resultHistory).toEqual(["P2"]);
		expect(child!.x).toBeGreaterThan(group.x + group.w);
		// 一次撤销：格子回宫格、子节点消失
		useCanvasStore.getState().undo();
		const s2 = useCanvasStore.getState();
		expect(s2.nodes[group.id]?.data.shotAssets).toEqual(["P1", "P2", "P3"]);
		expect(Object.values(s2.nodes).filter((n) => n.type === "image.gen")).toHaveLength(0);
		// 越界 index：handler 不动状态（结构命令快照照压，无害）
		commandBus.dispatch({ type: "extractShotGroupItem", nodeId: group.id, index: 9 }, { source: "gui" });
		const s3 = useCanvasStore.getState();
		expect(s3.nodes[group.id]?.data.shotAssets).toEqual(["P1", "P2", "P3"]);
		expect(Object.values(s3.nodes).filter((n) => n.type === "image.gen")).toHaveLength(0);
	});

	it("解组：每张图一个 image.gen 节点（resultAssetId+history），组节点删除", () => {
		const group = buildShotGroupNode({ assets: ["P1", "P2", "P3"], x: 100, y: 50 });
		useCanvasStore.setState({ nodes: { [group.id]: group } });
		commandBus.dispatch({ type: "dissolveShotGroup", nodeId: group.id }, { source: "gui" });
		const s = useCanvasStore.getState();
		expect(s.nodes[group.id]).toBeUndefined();
		const children = Object.values(s.nodes).filter((n) => n.type === "image.gen");
		expect(children.map((n) => n.data.resultAssetId).sort()).toEqual(["P1", "P2", "P3"]);
		for (const c of children) {
			expect(c.data.resultHistory).toEqual([c.data.resultAssetId]);
			expect(c.x).toBeGreaterThan(group.x + group.w); // 铺在组右侧
		}
	});
});
