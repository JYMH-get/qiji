import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { smartInferContext } from "@/lib/inferUpstream";
import { useCanvasStore } from "@/store/canvasStore";
import { useCatalogStore } from "@/store/catalogStore";
import { commandBus } from "@/command/commandBus";
import { registerNodeHandlers } from "@/command/handlers/nodeHandlers";
import type { CatalogTemplate } from "@/contract";
import type { CanvasNode, CanvasEdge, NodeData } from "@/types";

/**
 * 单卡/多卡重做（第108轮）语义锁定：
 *  - 上游类型 → 可用用途：上游智能推理→仅单卡（storyboard.singleShot）；上游剧集分集→仅多卡+拆分；
 *    无/其他上游→全部；智能推理上游优先于剧集分集（原文节点场景）；
 *  - 106轮模板联动加门禁：templateId 只扇出到允许该模板用途的节点（多卡模板不串单卡原文节点）；
 *  - 模板不在 catalog → 维持旧行为原样扇出（向后兼容）。
 */

const mkNode = (id: string, type: string, params: Record<string, unknown> = {}, data: Partial<NodeData> = {}): CanvasNode => ({
	id, type, x: 0, y: 0, w: 240, h: 200, parentId: null, parentScriptId: null,
	data: { input: {}, params, resultAssetId: null, ...data },
});
const mkEdge = (id: string, source: string, target: string): CanvasEdge => ({
	id, kind: "data" as CanvasEdge["kind"], source, sourcePort: "out", target, targetPort: "in",
});

describe("smartInferContext（上游类型 → 可用用途）", () => {
	const nodes = {
		ep: mkNode("ep", "episode.split"),
		inf: mkNode("inf", "smart.infer"),
		txt: mkNode("txt", "text.seed"),
		me: mkNode("me", "smart.infer"),
	};
	it("上游是智能推理节点 → 仅单卡（默认单分镜模板）", () => {
		const ctx = smartInferContext("me", nodes, { e1: mkEdge("e1", "inf", "me") });
		expect(ctx.scope).toBe("single");
		expect(ctx.purposes).toEqual(["storyboard.singleShot", "storyboard.unifiedShot"]);
		expect(ctx.defaultTemplateId).toBe("smart.infer.single");
	});
	it("上游是剧集分集 → 仅多卡+拆分（默认多分镜模板）", () => {
		const ctx = smartInferContext("me", nodes, { e1: mkEdge("e1", "ep", "me") });
		expect(ctx.scope).toBe("multi");
		expect(ctx.purposes).toEqual(["storyboard.toVideoPrompt", "storyboard.unified", "storyboard.split"]);
		expect(ctx.defaultTemplateId).toBe("smart.infer.multi");
	});
	it("智能推理上游优先于剧集分集（两者并存按单卡）", () => {
		const ctx = smartInferContext("me", nodes, { e1: mkEdge("e1", "ep", "me"), e2: mkEdge("e2", "inf", "me") });
		expect(ctx.scope).toBe("single");
	});
	it("无上游 / 其他上游（文本节点）→ 多卡单卡拆分都有", () => {
		expect(smartInferContext("me", nodes, {}).scope).toBe("both");
		const ctx = smartInferContext("me", nodes, { e1: mkEdge("e1", "txt", "me") });
		expect(ctx.scope).toBe("both");
		expect(ctx.purposes).toEqual(["storyboard.toVideoPrompt", "storyboard.unified", "storyboard.singleShot", "storyboard.unifiedShot", "storyboard.split"]);
	});
	it("出边不算上游（自己连向下游不影响判定）", () => {
		const ctx = smartInferContext("me", nodes, { e1: mkEdge("e1", "me", "inf") });
		expect(ctx.scope).toBe("both");
	});
});

describe("模板联动门禁（106联动 × 单卡/多卡用途）", () => {
	const TPLS = [
		{ id: "tpl.multi", name: "官方3多卡", capability: "text", purpose: "storyboard.toVideoPrompt", variables: [] },
		{ id: "tpl.single", name: "官方3单卡", capability: "text", purpose: "storyboard.singleShot", variables: [] },
	] as CatalogTemplate[];
	beforeAll(() => {
		registerNodeHandlers();
	});
	beforeEach(() => {
		useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
		useCatalogStore.setState({ catalog: { version: "t", models: [], templates: TPLS, nodes: [], imageTemplates: [], variantPrefixes: [], schemas: [] } as never });
	});
	const setParams = (id: string, params: Record<string, unknown>) =>
		commandBus.dispatch({ type: "updateNodeParams", id, params }, { source: "gui" });

	it("多卡模板扇出：多卡/自由节点收到，单卡原文节点跳过（保留原模板）；共享 model 仍全员扇出", () => {
		useCanvasStore.setState({
			nodes: {
				ep: mkNode("ep", "episode.split"),
				a: mkNode("a", "smart.infer", { model: "m1" }),           // 上游 ep → 仅多卡
				shot: mkNode("shot", "smart.infer", { model: "m1", templateId: "tpl.single" }), // 上游 a → 仅单卡
				free: mkNode("free", "smart.infer", { model: "m1" }),      // 无上游 → 全部
			} as never,
			edges: { e1: mkEdge("e1", "ep", "a"), e2: mkEdge("e2", "a", "shot") } as never,
		});
		setParams("a", { model: "m2", templateId: "tpl.multi" });
		const n = useCanvasStore.getState().nodes;
		expect(n.free.data.params.templateId).toBe("tpl.multi"); // 全部允许 → 跟随
		expect(n.shot.data.params.templateId).toBe("tpl.single"); // 单卡节点不被多卡模板污染
		expect(n.shot.data.params.model).toBe("m2"); // 其余共享键照常联动
	});

	it("单卡模板扇出：多卡（分集下游）节点跳过", () => {
		useCanvasStore.setState({
			nodes: {
				ep: mkNode("ep", "episode.split"),
				a: mkNode("a", "smart.infer", { templateId: "tpl.multi" }),
				shot: mkNode("shot", "smart.infer", {}),
			} as never,
			edges: { e1: mkEdge("e1", "ep", "a"), e2: mkEdge("e2", "a", "shot") } as never,
		});
		setParams("shot", { templateId: "tpl.single" });
		expect(useCanvasStore.getState().nodes.a.data.params.templateId).toBe("tpl.multi");
	});

	it("模板不在 catalog → 旧行为原样扇出（向后兼容）", () => {
		useCanvasStore.setState({
			nodes: {
				ep: mkNode("ep", "episode.split"),
				a: mkNode("a", "smart.infer", {}),
				b: mkNode("b", "smart.infer", {}),
			} as never,
			edges: { e1: mkEdge("e1", "ep", "a") } as never,
		});
		setParams("b", { templateId: "tpl.unknown" });
		expect(useCanvasStore.getState().nodes.a.data.params.templateId).toBe("tpl.unknown");
	});
});
