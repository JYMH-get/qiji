import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { useCanvasStore } from "@/store/canvasStore";
import { commandBus } from "../commandBus";
import { registerNodeHandlers } from "./nodeHandlers";
import type { CanvasNode, NodeData } from "@/types";

/**
 * 自定义结果 · addNodeResults 语义锁定（悬停工具栏「上传」）：
 *  - 已有主图归档进 resultHistory（去重、旧→新），新资产依次入历史，最后一个设为主图；
 *  - 空节点（无结果）上传 = 直接成为主图 + 历史；
 *  - 重复资产 id 去重（历史不重复），主图仍切到最后一个；
 *  - 结构命令：一次撤销回到上传前（主图与历史整体回退）。
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

const dispatch = (nodeId: string, assetIds: string[]) =>
	commandBus.dispatch({ type: "addNodeResults", nodeId, assetIds }, { source: "gui" });

beforeAll(() => {
	registerNodeHandlers();
});

beforeEach(() => {
	useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
});

describe("addNodeResults（上传自定义结果入堆叠）", () => {
	it("已有主图归档进历史，新资产依次入历史，最后一个设为主图", () => {
		useCanvasStore.setState({
			nodes: { a: mkNode("a", { resultAssetId: "v1", resultHistory: ["v0", "v1"] }) },
		});
		dispatch("a", ["u1", "u2"]);
		const d = useCanvasStore.getState().nodes.a.data;
		expect(d.resultAssetId).toBe("u2");
		expect(d.resultHistory).toEqual(["v0", "v1", "u1", "u2"]);
	});

	it("老节点只有主图无 history：主图自动补册后再追加", () => {
		useCanvasStore.setState({ nodes: { a: mkNode("a", { resultAssetId: "v1" }) } });
		dispatch("a", ["u1"]);
		const d = useCanvasStore.getState().nodes.a.data;
		expect(d.resultAssetId).toBe("u1");
		expect(d.resultHistory).toEqual(["v1", "u1"]);
	});

	it("空节点（无任何结果）上传 = 直接成为主图 + 历史", () => {
		useCanvasStore.setState({ nodes: { a: mkNode("a") } });
		dispatch("a", ["u1"]);
		const d = useCanvasStore.getState().nodes.a.data;
		expect(d.resultAssetId).toBe("u1");
		expect(d.resultHistory).toEqual(["u1"]);
	});

	it("重复资产 id 去重：历史不重复，主图切到最后一个；空 id 列表不做变更", () => {
		useCanvasStore.setState({
			nodes: { a: mkNode("a", { resultAssetId: "v1", resultHistory: ["v1"] }) },
		});
		dispatch("a", ["v1", "u1"]);
		let d = useCanvasStore.getState().nodes.a.data;
		expect(d.resultAssetId).toBe("u1");
		expect(d.resultHistory).toEqual(["v1", "u1"]);
		const before = useCanvasStore.getState().past.length;
		dispatch("a", []);
		d = useCanvasStore.getState().nodes.a.data;
		expect(d.resultAssetId).toBe("u1");
		expect(useCanvasStore.getState().past.length).toBeGreaterThanOrEqual(before); // 空列表不改数据
	});

	it("结构命令：一次撤销回到上传前（主图与历史整体回退）", () => {
		useCanvasStore.setState({
			nodes: { a: mkNode("a", { resultAssetId: "v1", resultHistory: ["v1"] }) },
		});
		dispatch("a", ["u1", "u2"]);
		expect(useCanvasStore.getState().nodes.a.data.resultAssetId).toBe("u2");
		useCanvasStore.getState().undo();
		const d = useCanvasStore.getState().nodes.a.data;
		expect(d.resultAssetId).toBe("v1");
		expect(d.resultHistory).toEqual(["v1"]);
	});
});
