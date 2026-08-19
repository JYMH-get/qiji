import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { useCanvasStore } from "@/store/canvasStore";
import { commandBus } from "@/command/commandBus";
import { registerNodeHandlers } from "@/command/handlers/nodeHandlers";
import { makeNode } from "@/canvas/nodeFactory";
import type { CanvasNode, NodeData } from "@/types";

/**
 * 同类型节点共享设置（输出一致性）语义锁定：
 *  - 在任一节点改共享键（比例/分辨率/模型等）→ 同画布其余同类型节点跟随；
 *  - 内容字段（prompt/assetName 等）绝不扇出；templateId 仅智能推理节点联动（用户定），
 *    purpose 不随之扇出（执行时由模板决定用途）；
 *  - 处理类节点（超分/去字幕/resultOnly）既不作为源、也不被联动；
 *  - 新建节点（makeNode）继承画布上既有同类节点的共享设置。
 */

const mkNode = (
	id: string,
	type: string,
	params: Record<string, unknown> = {},
	data: Partial<NodeData> = {},
): CanvasNode => ({
	id,
	type,
	x: 0,
	y: 0,
	w: 240,
	h: 200,
	parentId: null,
	parentScriptId: null,
	data: { input: {}, params, resultAssetId: null, ...data },
});

const setParams = (id: string, params: Record<string, unknown>) =>
	commandBus.dispatch({ type: "updateNodeParams", id, params }, { source: "gui" });

beforeAll(() => {
	registerNodeHandlers();
});

beforeEach(() => {
	useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
});

describe("fanOutSharedParams（同类型节点共享设置）", () => {
	it("改一个图片节点的比例/分辨率 → 其余图片节点跟随，视频节点不动", () => {
		useCanvasStore.setState({
			nodes: {
				i1: mkNode("i1", "image.gen", { aspect: "16:9", resolution: "2k", prompt: "甲" }),
				i2: mkNode("i2", "image.gen", { aspect: "16:9", resolution: "2k", prompt: "乙" }),
				i3: mkNode("i3", "image.gen", { aspect: "16:9", prompt: "丙" }),
				v1: mkNode("v1", "video.gen", { aspect_ratio: "16:9" }),
			},
		});
		setParams("i1", { aspect: "9:16", resolution: "4k" });
		const s = useCanvasStore.getState();
		expect(s.nodes.i1.data.params.aspect).toBe("9:16");
		expect(s.nodes.i2.data.params.aspect).toBe("9:16");
		expect(s.nodes.i2.data.params.resolution).toBe("4k");
		expect(s.nodes.i3.data.params.aspect).toBe("9:16");
		expect(s.nodes.v1.data.params.aspect_ratio).toBe("16:9"); // 不同类型不联动
	});

	it("内容字段不扇出：prompt/assetName 只落源节点；混合补丁只扇出共享键", () => {
		useCanvasStore.setState({
			nodes: {
				i1: mkNode("i1", "image.gen", { prompt: "甲" }),
				i2: mkNode("i2", "image.gen", { prompt: "乙", assetName: "白羊" }),
			},
		});
		setParams("i1", { prompt: "甲改", quality: "medium" });
		const s = useCanvasStore.getState();
		expect(s.nodes.i1.data.params.prompt).toBe("甲改");
		expect(s.nodes.i2.data.params.prompt).toBe("乙"); // prompt 不共享
		expect(s.nodes.i2.data.params.assetName).toBe("白羊");
		expect(s.nodes.i2.data.params.quality).toBe("medium"); // 共享键跟随
	});

	it("处理类节点不参与：超分/去字幕/resultOnly 不被联动，作为源也不扇出", () => {
		useCanvasStore.setState({
			nodes: {
				v1: mkNode("v1", "video.gen", { resolution: "720p" }),
				up: mkNode("up", "video.gen", { purpose: "video.upscale", resolution: "1080p" }),
				clip: mkNode("clip", "video.gen", { resultOnly: true, resolution: "720p" }),
			},
		});
		setParams("v1", { resolution: "480p" });
		let s = useCanvasStore.getState();
		expect(s.nodes.up.data.params.resolution).toBe("1080p"); // 处理节点不被联动
		expect(s.nodes.clip.data.params.resolution).toBe("720p");
		setParams("up", { resolution: "2k" });
		s = useCanvasStore.getState();
		expect(s.nodes.v1.data.params.resolution).toBe("480p"); // 处理节点为源不扇出
	});

	it("智能推理节点共享模型与提示词模板（选官方3 → 其余智能推理节点跟随），purpose 不扇出", () => {
		useCanvasStore.setState({
			nodes: {
				a: mkNode("a", "smart.infer", { model: "m1", templateId: "smart.infer.multi" }),
				b: mkNode("b", "smart.infer", { model: "m1", templateId: "smart.infer.single", purpose: "storyboard.toVideoPrompt" }),
				sp: mkNode("sp", "asset.split", { model: "m1", templateId: "asset.extract.basic" }),
			},
		});
		// 面板选模板时 templateId 与 purpose 一起写入源节点（setParam({templateId, purpose})）
		setParams("a", { model: "m2", templateId: "tpl-official-3", purpose: "storyboard.split" });
		const s = useCanvasStore.getState();
		expect(s.nodes.b.data.params.model).toBe("m2");
		expect(s.nodes.b.data.params.templateId).toBe("tpl-official-3"); // 模板跟随
		expect(s.nodes.b.data.params.purpose).toBe("storyboard.toVideoPrompt"); // purpose 不扇出（执行时模板决定用途）
		expect(s.nodes.sp.data.params.templateId).toBe("asset.extract.basic"); // 不同类型不联动
	});

	it("资产拆分节点模板不联动（只共享模型/模式）", () => {
		useCanvasStore.setState({
			nodes: {
				s1: mkNode("s1", "asset.split", { model: "m1", templateId: "asset.extract.basic" }),
				s2: mkNode("s2", "asset.split", { model: "m1", templateId: "asset.extract.basic" }),
			},
		});
		setParams("s1", { model: "m2", templateId: "tpl-user" });
		const s = useCanvasStore.getState();
		expect(s.nodes.s2.data.params.model).toBe("m2");
		expect(s.nodes.s2.data.params.templateId).toBe("asset.extract.basic");
	});

	it("换模型 → 被联动节点的非共享参数（时长）也收敛到新模型档位，档内值不动", () => {
		useCanvasStore.setState({
			nodes: {
				v1: mkNode("v1", "video.gen", { model: "m1", duration: 10 }),
				v2: mkNode("v2", "video.gen", { model: "m1", duration: 30 }), // 越档（spec 4-15）
				v3: mkNode("v3", "video.gen", { model: "m1", duration: 8 }),
			},
		});
		setParams("v1", { model: "m2" });
		const s = useCanvasStore.getState();
		expect(s.nodes.v2.data.params.model).toBe("m2");
		expect(s.nodes.v2.data.params.duration).toBe(15); // 夹到新模型上限
		expect(s.nodes.v3.data.params.duration).toBe(8); // 档内 → 不动（勿抹平每卡时长）
	});
});

describe("inheritSharedParams（新建节点继承同类设置）", () => {
	it("画布已有 9:16 图片节点 → makeNode 的新图片节点继承 9:16（含模型）", () => {
		useCanvasStore.setState({
			nodes: {
				i1: mkNode("i1", "image.gen", { aspect: "9:16", resolution: "4k", model: "gpt-image-2", prompt: "甲" }),
			},
		});
		const n = makeNode("image.gen", 0, 0);
		expect(n.data.params.aspect).toBe("9:16");
		expect(n.data.params.resolution).toBe("4k");
		expect(n.data.params.model).toBe("gpt-image-2");
		expect(n.data.params.prompt).toBeUndefined(); // 内容不继承
	});

	it("空画布 → 用 spec 默认值；处理类节点不作为继承来源", () => {
		useCanvasStore.setState({ nodes: {} });
		expect(makeNode("image.gen", 0, 0).data.params.aspect).toBe("16:9");
		useCanvasStore.setState({
			nodes: { up: mkNode("up", "video.gen", { purpose: "video.upscale", resolution: "2k" }) },
		});
		expect(makeNode("video.gen", 0, 0).data.params.resolution).toBe("720p"); // 不从处理节点继承
	});
});
