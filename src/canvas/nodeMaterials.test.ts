/**
 * renumberPromptAfterRemoval —— 删除素材后提示词 @ 引用同步修正（第86轮锁定）：
 *  - 被删素材的 @KindN 引用移除（连同紧邻分隔符）；
 *  - 其后同媒体编号前移一位（与素材区重新编号保持一致）；
 *  - 之前的编号与其它媒体类型不受影响。
 * removeUpstreamMaterial —— 删除上游连线素材（第97轮补充）：断开对应连线 + 提示词重编号。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renumberPromptAfterRemoval, removeUpstreamMaterial, removeNodeMaterial, listNodeMaterials, buildNodeLegend } from "./nodeMaterials";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import type { CanvasNode, NodeData } from "@/types";

describe("renumberPromptAfterRemoval", () => {
	it("删除中间素材：对应引用移除、其后编号前移", () => {
		const p = "参考@Image1、@Image2、@Image3 生成画面";
		expect(renumberPromptAfterRemoval(p, "image", 2)).toBe("参考@Image1、@Image2 生成画面");
	});

	it("删除首个素材：@Image1 引用移除（用户正文保留），@Image2/@Image3 前移", () => {
		const p = "@Image1在左，@Image2在右，@Image3远景";
		expect(renumberPromptAfterRemoval(p, "image", 1)).toBe("在左，@Image1在右，@Image2远景");
	});

	it("不同媒体类型互不影响", () => {
		const p = "@Image1配@Audio1，@Image2配@Audio2";
		expect(renumberPromptAfterRemoval(p, "audio", 1)).toBe("@Image1配@Image2配@Audio1");
	});

	it("编号小于被删项的引用原样保留", () => {
		const p = "@Video1接@Video2";
		expect(renumberPromptAfterRemoval(p, "video", 2)).toBe("@Video1接");
	});

	it("无相关引用时提示词不变", () => {
		const p = "纯文字提示词，无任何引用";
		expect(renumberPromptAfterRemoval(p, "image", 1)).toBe(p);
	});
});

// ── removeUpstreamMaterial：断线 + 提示词重编号 ──

const mkN = (id: string, data: Partial<NodeData> = {}): CanvasNode => ({
	id, type: "image.gen", x: 0, y: 0, w: 240, h: 200, parentId: null, parentScriptId: null,
	data: { input: {}, params: {}, resultAssetId: null, ...data },
});
const mkE = (id: string, source: string, target: string) =>
	({ id, kind: "dataflow" as const, source, sourcePort: "out", target, targetPort: "in" });
const mkA = (id: string, kind: string, name: string) =>
	({ id, kind, name, uri: `mem://${id}`, serverAssetId: null, thumbnailUri: null, createdAt: "", deletedByUser: false, localPath: null });

describe("removeUpstreamMaterial（删除上游连线素材）", () => {
	beforeEach(() => {
		useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
		useLibraryStore.setState({ assets: {} });
	});

	it("删除第 1 个上游图片：连线断开、@Image 引用重编号（自加素材编号一并前移）", () => {
		useLibraryStore.setState({
			assets: { A1: mkA("A1", "image", "图一"), A2: mkA("A2", "image", "图二") } as never,
		});
		useCanvasStore.setState({
			nodes: {
				u1: mkN("u1", { resultAssetId: "A1" }),
				u2: mkN("u2", { resultAssetId: "A2" }),
				t: mkN("t", { params: { prompt: "@Image1在左，@Image2居中，@Image3在右" }, input: { images: [{ id: "S1", url: "http://x/s1" }] } }),
			},
			edges: { e1: mkE("e1", "u1", "t"), e2: mkE("e2", "u2", "t") },
		});
		removeUpstreamMaterial("t", "e1");
		const s = useCanvasStore.getState();
		expect(s.edges.e1).toBeUndefined();
		expect(s.edges.e2).toBeDefined();
		expect(s.nodes.t.data.params.prompt).toBe("在左，@Image1居中，@Image2在右");
		// 自加素材不动
		expect((s.nodes.t.data.input as Record<string, unknown[]>).images).toHaveLength(1);
	});

	it("上游是文本节点（不贡献媒体素材）：只断线，提示词不动", () => {
		useCanvasStore.setState({
			nodes: {
				txt: mkN("txt"),
				t: mkN("t", { params: { prompt: "@Image1保持" } }),
			},
			edges: { e1: mkE("e1", "txt", "t") },
		});
		removeUpstreamMaterial("t", "e1");
		const s = useCanvasStore.getState();
		expect(s.edges.e1).toBeUndefined();
		expect(s.nodes.t.data.params.prompt).toBe("@Image1保持");
	});

	it("媒体类型独立计数：删上游音频不影响 @Image 编号", () => {
		useLibraryStore.setState({
			assets: { I1: mkA("I1", "image", "图"), AU1: mkA("AU1", "audio", "音") } as never,
		});
		useCanvasStore.setState({
			nodes: {
				ui: mkN("ui", { resultAssetId: "I1" }),
				ua: mkN("ua", { resultAssetId: "AU1" }),
				t: mkN("t", { params: { prompt: "@Image1的声音参考@Audio1" } }),
			},
			edges: { e1: mkE("e1", "ui", "t"), e2: mkE("e2", "ua", "t") },
		});
		removeUpstreamMaterial("t", "e2");
		const s = useCanvasStore.getState();
		expect(s.edges.e2).toBeUndefined();
		expect(s.nodes.t.data.params.prompt).toBe("@Image1的声音参考");
	});

	it("边不属于本节点/不存在：不做任何变更", () => {
		useCanvasStore.setState({
			nodes: { a: mkN("a"), b: mkN("b") },
			edges: { e1: mkE("e1", "a", "b") },
		});
		removeUpstreamMaterial("a", "e1"); // e1 的 target 是 b 不是 a
		expect(useCanvasStore.getState().edges.e1).toBeDefined();
		removeUpstreamMaterial("b", "e404");
		expect(useCanvasStore.getState().edges.e1).toBeDefined();
	});
});

// ── listNodeMaterials：按加入顺序（matOrder）单点枚举 + 上游素材友好命名 ──

describe("listNodeMaterials（加入顺序 + 命名）", () => {
	beforeEach(() => {
		useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
		useLibraryStore.setState({ assets: {} });
	});

	it("上游生成节点未绑定资产：用节点标题（分镜），不用 gen_output 机器文件名", () => {
		useLibraryStore.setState({ assets: { A1: mkA("A1", "image", "image.gen_output_1784416763719") } as never });
		useCanvasStore.setState({
			nodes: { up: mkN("up", { resultAssetId: "A1", title: "分镜" }), t: mkN("t") },
			edges: { e1: mkE("e1", "up", "t") },
		});
		const items = listNodeMaterials("t");
		expect(items).toHaveLength(1);
		expect(items[0].name).toBe("分镜");
		const legend = buildNodeLegend("t");
		expect(legend).toContain("@Image1 是 分镜");
		expect(legend).not.toContain("gen_output");
	});

	it("先匹配后连线（有 matOrder）：后连的上游素材排在已匹配素材之后，编号不错位", () => {
		useLibraryStore.setState({ assets: { A1: mkA("A1", "image", "image.gen_output_1") } as never });
		useCanvasStore.setState({
			nodes: {
				up: mkN("up", { resultAssetId: "A1", title: "分镜" }),
				t: mkN("t", {
					input: { images: [{ id: "S1", url: "http://x/s1", name: "张起天" }] },
					matOrder: ["s:S1"], // 匹配已落库的加入顺序
				}),
			},
			edges: { e1: mkE("e1", "up", "t") },
		});
		const items = listNodeMaterials("t");
		expect(items.map((i) => [i.tag, i.name])).toEqual([
			["@Image1", "张起天"],
			["@Image2", "分镜"],
		]);
		expect(buildNodeLegend("t")).toBe("【素材图例】@Image1 是 张起天，@Image2 是 分镜，");
	});

	it("无 matOrder（旧项目/先连线后匹配）：保持旧序——上游在前、自加在后", () => {
		useLibraryStore.setState({ assets: { A1: mkA("A1", "image", "image.gen_output_1") } as never });
		useCanvasStore.setState({
			nodes: {
				up: mkN("up", { resultAssetId: "A1", title: "分镜" }),
				t: mkN("t", { input: { images: [{ id: "S1", url: "http://x/s1", name: "张起天" }] } }),
			},
			edges: { e1: mkE("e1", "up", "t") },
		});
		expect(listNodeMaterials("t").map((i) => [i.tag, i.name])).toEqual([
			["@Image1", "分镜"],
			["@Image2", "张起天"],
		]);
	});

	it("删除按 matOrder 排在后面的上游素材：前面自加素材的 @ 引用不动", () => {
		useLibraryStore.setState({ assets: { A1: mkA("A1", "image", "image.gen_output_1") } as never });
		useCanvasStore.setState({
			nodes: {
				up: mkN("up", { resultAssetId: "A1", title: "分镜" }),
				t: mkN("t", {
					input: { images: [{ id: "S1", url: "http://x/s1", name: "张起天" }] },
					matOrder: ["s:S1", "e:e1"],
					params: { prompt: "【素材图例】@Image1 是 张起天，@Image2 是 分镜，\n\n@Image1特写，@Image2全景" },
				}),
			},
			edges: { e1: mkE("e1", "up", "t") },
		});
		removeUpstreamMaterial("t", "e1");
		const s = useCanvasStore.getState();
		expect(s.edges.e1).toBeUndefined();
		expect(s.nodes.t.data.params.prompt).toBe("【素材图例】@Image1 是 张起天，\n\n@Image1特写，全景");
		expect(s.nodes.t.data.matOrder).toEqual(["s:S1"]); // 断线后快照同步剔除
	});
});

describe("removeNodeMaterial（删自加素材）— 已有图例时整体重建、不留残句", () => {
	beforeEach(() => {
		useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
		useLibraryStore.setState({ assets: {} });
	});
	it("删第 1 张自加图：图例重建为剩余素材、正文 @ 引用前移、无「是 张三」残留", () => {
		useCanvasStore.setState({
			nodes: {
				t: mkN("t", {
					params: { prompt: "【素材图例】@Image1 是 张三，@Image2 是 李四，\n\n镜头推近 @Image2 说话" },
					input: { images: [{ id: "S1", url: "http://x/1", name: "张三" }, { id: "S2", url: "http://x/2", name: "李四" }] },
				}),
			},
			edges: {},
		});
		removeNodeMaterial("t", "images", 0); // 删张三
		const p = useCanvasStore.getState().nodes.t.data.params.prompt as string;
		expect(p).toBe("【素材图例】@Image1 是 李四，\n\n镜头推近 @Image1 说话");
		expect(p).not.toContain("张三");
	});
});
