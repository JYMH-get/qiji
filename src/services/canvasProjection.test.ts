import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { syncCanvasFromProject } from "./canvasProjection";

/** 资产模式 → 画布单向投影的可行性验证：投影正确性 + 幂等 + 就地更新。 */
describe("canvasProjection（资产模式↔画布全映射）", () => {
	beforeEach(() => {
		useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {} });
		useProjectStore.setState({
			scriptText: "", characters: [], scenes: [], items: [], organisms: [], crowds: [], episodes: [], mediaSettings: {},
		} as any);
	});

	const nodes = () => Object.values(useCanvasStore.getState().nodes);
	const byRef = (r: string) => nodes().find((n) => n.data.sourceRef === r);

	it("资产不投影：同步不建资产节点，且清理历史残留的资产投影节点及其连线", () => {
		useProjectStore.setState({
			scriptText: "某段小说原文……",
			characters: [{ id: "C01-1", name: "张起天", prompt: "出图提示词A", image: "" }],
			scenes: [{ id: "S01-1", name: "山中木屋", prompt: "出图提示词B" }],
			items: [], organisms: [], crowds: [], episodes: [],
		} as any);

		expect(syncCanvasFromProject()).toBe(true);
		expect(byRef("script")?.type).toBe("text.seed");
		// 资产不再投影
		expect(byRef("assetSplit")).toBeFalsy();
		expect(byRef("asset:C01-1")).toBeFalsy();
		expect(byRef("asset:S01-1")).toBeFalsy();

		// 历史残留清理：预置旧版投影产生的资产节点+连线 → 下次同步被移除，非资产节点保留
		const scriptId = byRef("script")!.id;
		useCanvasStore.setState({
			nodes: {
				...useCanvasStore.getState().nodes,
				"old-split": { id: "old-split", type: "asset.split", x: 0, y: 0, w: 100, h: 100, data: { sourceRef: "assetSplit", params: {}, input: {} } } as any,
				"old-img": { id: "old-img", type: "image.gen", x: 0, y: 0, w: 100, h: 100, data: { sourceRef: "asset:C01-1", params: {}, input: {} } } as any,
			},
			edges: {
				...useCanvasStore.getState().edges,
				"old-e": { id: "old-e", kind: "dataflow", source: "old-split", sourcePort: "out", target: "old-img", targetPort: "in" } as any,
			},
		});
		expect(syncCanvasFromProject()).toBe(true);
		const ns = useCanvasStore.getState().nodes;
		expect(ns["old-split"]).toBeFalsy();
		expect(ns["old-img"]).toBeFalsy();
		expect(useCanvasStore.getState().edges["old-e"]).toBeFalsy();
		expect(byRef("script")?.id).toBe(scriptId); // 非资产投影节点不受影响

		// 幂等：重复投影不新增节点
		const count = Object.keys(useCanvasStore.getState().nodes).length;
		syncCanvasFromProject();
		expect(Object.keys(useCanvasStore.getState().nodes).length).toBe(count);
	});

	it("剧集分集 + 智能推理 + 故事板/视频 → 全流水线节点（全文→剧集→分镜）", () => {
		useProjectStore.setState({
			scriptText: "原文",
			characters: [], scenes: [], items: [], organisms: [], crowds: [],
			episodes: [
				{
					id: "ep1", title: "第一集", scriptText: "本集内容",
					shots: [{
						id: "sh1", index: 1, title: "分镜1", scriptSegment: "分镜原文", prompt: "",
						materials: [{ id: "m1", assetId: "M1", media: "image", name: "张起天", uri: "asset://m1.png" }],
						storyboardPrompt: "故事板提示词", storyboardUri: "asset://sb.png",
						videoPrompt: "视频提示词", videoUri: "asset://v.mp4",
					}],
				},
			],
		} as any);

		expect(syncCanvasFromProject()).toBe(true);
		expect(byRef("episodeSplit")?.type).toBe("episode.split");
		// 每集「智能推理」节点 = 剧集分集的下游（承接本集原文），非与之平级
		expect(byRef("episode:ep1")?.type).toBe("smart.infer");
		expect(byRef("episode:ep1")?.data.resultText).toContain("本集内容");
		// 分镜原文节点 = 智能推理节点（带推理功能）+ 命名「分镜n原文」（新格式，与裂变一致）
		expect(byRef("shot:sh1")?.type).toBe("smart.infer");
		expect(byRef("shot:sh1")?.data.title).toBe("分镜1原文");
		expect(byRef("shot:sh1")?.data.resultText).toContain("分镜原文");
		// 分镜故事板图 + 视频媒体节点（命名 分镜n故事板/视频）
		expect(byRef("shotSb:sh1")?.type).toBe("image.gen");
		expect(byRef("shotSb:sh1")?.data.title).toBe("分镜1故事板");
		// 投影后提示词=表格正文 + 按画布素材枚举重建的图例前缀（素材「张起天」占 @Image1——图例与素材区一一对应）
		expect(byRef("shotSb:sh1")?.data.params.prompt).toBe("【素材图例】@Image1 是 张起天；\n\n故事板提示词");
		expect(byRef("shotSb:sh1")?.data.resultAssetId).toBeTruthy();
		expect(byRef("shotVid:sh1")?.type).toBe("video.gen");
		expect(byRef("shotVid:sh1")?.data.title).toBe("分镜1视频");
		expect(byRef("shotVid:sh1")?.data.resultAssetId).toBeTruthy();
		// 垫图同步：分镜素材 → 故事板/视频节点 input.images
		const sbImgs = (byRef("shotSb:sh1")?.data.input as any)?.images;
		expect(Array.isArray(sbImgs) && sbImgs[0]?.url).toBe("asset://m1.png");
		const vidImgs = (byRef("shotVid:sh1")?.data.input as any)?.images;
		expect(Array.isArray(vidImgs) && vidImgs[0]?.url).toBe("asset://m1.png");
		// 流水线连线：分镜文本 → 故事板图 → 视频
		const edges = Object.values(useCanvasStore.getState().edges);
		// 链路：剧集分集 → 每集智能推理 → 分镜文本 → 故事板图 → 视频
		expect(edges.some((e) => e.source === byRef("episodeSplit")!.id && e.target === byRef("episode:ep1")!.id)).toBe(true);
		expect(edges.some((e) => e.source === byRef("episode:ep1")!.id && e.target === byRef("shot:sh1")!.id)).toBe(true);
		expect(edges.some((e) => e.source === byRef("shot:sh1")!.id && e.target === byRef("shotSb:sh1")!.id)).toBe(true);
		expect(edges.some((e) => e.source === byRef("shotSb:sh1")!.id && e.target === byRef("shotVid:sh1")!.id)).toBe(true);
	});

	it("图视同源投影：原文→同源提示词节点→图片+视频并联（图/视频不内置提示词）；切回双结果清理同源节点", () => {
		useProjectStore.setState({
			scriptText: "原文",
			characters: [], scenes: [], items: [], organisms: [], crowds: [],
			mediaSettings: { imgVideoSameSource: true },
			episodes: [
				{
					id: "ep1", title: "第一集", scriptText: "本集内容",
					shots: [{
						id: "sh1", index: 1, title: "分镜1", scriptSegment: "分镜原文", prompt: "",
						materials: [],
						unifiedPrompt: "同源提示词甲", storyboardUri: "asset://sb.png", videoUri: "asset://v.mp4",
					}],
				},
			],
		} as any);

		expect(syncCanvasFromProject()).toBe(true);
		// 分集推理节点带同源多卡模板；原文节点带同源单卡模板
		expect(byRef("episode:ep1")?.data.params.templateId).toBe("smart.infer.unified");
		expect(byRef("shot:sh1")?.data.params.templateId).toBe("smart.infer.unified.single");
		// 同源提示词独立节点承载（唯一提示词来源）
		const uni = byRef("shotUni:sh1")!;
		expect(uni.type).toBe("text.seed");
		expect(uni.data.title).toBe("分镜1同源提示词");
		expect(uni.data.params.prompt).toBe("同源提示词甲");
		// 图片/视频不内置提示词（运行时取上游同源节点文本）
		expect(byRef("shotSb:sh1")?.data.title).toBe("分镜1图片");
		expect(byRef("shotSb:sh1")?.data.params.prompt).toBe("");
		expect(byRef("shotVid:sh1")?.data.params.prompt).toBe("");
		// 链路：原文→同源；图片与视频并联接同源节点
		const edges = () => Object.values(useCanvasStore.getState().edges);
		expect(edges().some((e) => e.source === byRef("shot:sh1")!.id && e.target === uni.id)).toBe(true);
		expect(edges().some((e) => e.source === uni.id && e.target === byRef("shotSb:sh1")!.id)).toBe(true);
		expect(edges().some((e) => e.source === uni.id && e.target === byRef("shotVid:sh1")!.id)).toBe(true);
		// 无 图→视频 串联边、无 原文→图/原文→视频 直连边
		expect(edges().some((e) => e.source === byRef("shotSb:sh1")!.id && e.target === byRef("shotVid:sh1")!.id)).toBe(false);
		expect(edges().some((e) => e.source === byRef("shot:sh1")!.id && e.target === byRef("shotSb:sh1")!.id)).toBe(false);

		// 关掉图视同源再同步 → 同源节点及其边清理，恢复 原文→故事板→视频 串联
		useProjectStore.setState({
			mediaSettings: { imgVideoSameSource: false },
			episodes: [{
				id: "ep1", title: "第一集", scriptText: "本集内容",
				shots: [{ id: "sh1", index: 1, title: "分镜1", scriptSegment: "分镜原文", prompt: "", materials: [], storyboardPrompt: "故事板乙", videoPrompt: "视频乙", storyboardUri: "asset://sb.png", videoUri: "asset://v.mp4" }],
			}],
		} as any);
		expect(syncCanvasFromProject()).toBe(true);
		expect(byRef("shotUni:sh1")).toBeFalsy(); // 同源节点退场
		expect(byRef("shotSb:sh1")?.data.params.prompt).toBe("故事板乙"); // 双结果恢复内置提示词
		expect(edges().some((e) => e.source === byRef("shot:sh1")!.id && e.target === byRef("shotSb:sh1")!.id)).toBe(true);
		expect(edges().some((e) => e.source === byRef("shotSb:sh1")!.id && e.target === byRef("shotVid:sh1")!.id)).toBe(true);
	});

	it("类型迁移：旧格式 text.seed 原文投影节点 → 再同步迁移为 smart.infer（分镜n原文）", () => {
		useProjectStore.setState({
			scriptText: "原文", characters: [], scenes: [], items: [], organisms: [], crowds: [],
			episodes: [{ id: "ep1", title: "第一集", scriptText: "本集", shots: [{ id: "sh1", index: 1, title: "分镜1", scriptSegment: "镜1原文", prompt: "", materials: [] }] }],
		} as any);
		// 预置旧版投影（分镜原文用 text.seed，无标题）
		useCanvasStore.setState({
			nodes: {
				old: { id: "old", type: "text.seed", x: 5, y: 6, w: 100, h: 100, data: { sourceRef: "shot:sh1", params: { prompt: "镜1原文" }, resultText: "镜1原文", input: {} } } as any,
			},
			edges: {},
		});
		expect(syncCanvasFromProject("ep1")).toBe(true);
		const shot = byRef("shot:sh1");
		expect(shot?.type).toBe("smart.infer"); // 已迁移
		expect(shot?.data.title).toBe("分镜1原文");
		expect(useCanvasStore.getState().nodes["old"]).toBeFalsy(); // 旧 text.seed 节点已删
	});

	it("多画布：每个分集是一块独立画布——切换载入各自节点，互不影响", () => {
		useProjectStore.setState({
			scriptText: "原文", characters: [], scenes: [], items: [], organisms: [], crowds: [], canvasEpisodeId: null, canvases: {},
			episodes: [
				{ id: "ep1", title: "第一集", scriptText: "一", shots: [{ id: "s1", index: 1, title: "分镜1", scriptSegment: "镜1", prompt: "", materials: [] }] },
				{ id: "ep2", title: "第二集", scriptText: "二", shots: [{ id: "s2", index: 1, title: "分镜1", scriptSegment: "镜2", prompt: "", materials: [] }] },
			],
		} as any);
		const sw = useProjectStore.getState().switchCanvas;
		// 切到 ep2 的画布并同步 → 当前画布(canvasStore)只有 ep2 的节点
		sw("ep2");
		expect(syncCanvasFromProject("ep2")).toBe(true);
		expect(byRef("episode:ep2")).toBeTruthy();
		expect(byRef("shot:s2")).toBeTruthy();
		// 切到 ep1 的画布并同步 → 当前画布换成 ep1 的节点；ep2 的节点不在当前画布（已存入 canvases["ep2"]）
		sw("ep1");
		expect(syncCanvasFromProject("ep1")).toBe(true);
		expect(byRef("episode:ep1")).toBeTruthy();
		expect(byRef("shot:s1")).toBeTruthy();
		expect(byRef("episode:ep2")).toBeFalsy(); // 独立画布：ep2 节点不在 ep1 画布里
		expect(useProjectStore.getState().canvases["ep2"]?.nodes).toBeTruthy(); // 但保存在 canvases["ep2"]
		// 切回 ep2 → 其画布节点重新载入
		sw("ep2");
		expect(byRef("episode:ep2")).toBeTruthy();
		expect(byRef("episode:ep1")).toBeFalsy();
	});

	it("投影素材键空间与画布匹配同构：id=台账 blob id、assetId=实体 id、voiceForAssetId 透传", () => {
		useLibraryStore.setState({ assets: {} } as any);
		useProjectStore.setState({
			scriptText: "原文", characters: [], scenes: [], items: [], organisms: [], crowds: [],
			assetBlobs: { TP0001: { id: "TP0001", url: "https://oss/x.png", localUri: "asset://m1.png" } },
			episodes: [{
				id: "ep1", title: "第一集", scriptText: "本集",
				shots: [{
					id: "sh1", index: 1, title: "分镜1", scriptSegment: "镜1", prompt: "",
					materials: [
						{ id: "m1", assetId: "C-ent-1", media: "image", name: "甲", uri: "asset://m1.png" },
						{ id: "m2", assetId: "aud-ent-1", media: "audio", name: "甲的声音", uri: "asset://v.mp3", voiceForAssetId: "C-ent-1" },
						{ id: "m3", assetId: "C-ent-9", media: "image", name: "无图者", uri: "" }, // 无图素材：投影丢弃（不进 input 不占号）
					],
					videoPrompt: "视频提示词", videoUri: "asset://v.mp4",
				}],
			}],
		} as any);
		expect(syncCanvasFromProject("ep1")).toBe(true);
		const vid = byRef("shotVid:sh1")!;
		const imgs = (vid.data.input as any).images;
		// 台账有记录的素材：id=blob id（图生图按 id 取字节）、url=公网 url、assetId=实体 id——与画布「匹配素材」互认
		expect(imgs).toHaveLength(1);
		expect(imgs[0]).toMatchObject({ id: "TP0001", url: "https://oss/x.png", assetId: "C-ent-1" });
		// 音频带音色归属（图例「@ImageN的声音参考@AudioM」按 assetId/voiceForAssetId 配对）
		const auds = (vid.data.input as any).audios;
		expect(auds[0]).toMatchObject({ assetId: "aud-ent-1", voiceForAssetId: "C-ent-1" });
	});

	it("投影后按画布枚举重建图例+落 matOrder：上游故事板图占号在前，表格陈旧图例被整体替换（错位回归锁）", () => {
		useLibraryStore.setState({ assets: {} } as any);
		useProjectStore.setState({
			scriptText: "原文", characters: [], scenes: [], items: [], organisms: [], crowds: [], assetBlobs: {},
			episodes: [{
				id: "ep1", title: "第一集", scriptText: "本集",
				shots: [{
					id: "sh1", index: 1, title: "分镜1", scriptSegment: "镜1", prompt: "",
					materials: [
						{ id: "m1", assetId: "C-ent-1", media: "image", name: "甲", uri: "asset://m1.png" },
						{ id: "m2", assetId: "C-ent-2", media: "image", name: "乙", uri: "asset://m2.png" },
					],
					// 表格带来的图例编号与画布枚举不同（画布上游故事板图占 @Image1）——必须被整体重建，否则一一对应错位
					storyboardPrompt: "故事板提示词",
					videoPrompt: "【素材图例】@Image1 是 甲，@Image2 是 乙，\n\n正文",
					storyboardUri: "asset://sb.png", videoUri: "asset://v.mp4",
				}],
			}],
		} as any);
		expect(syncCanvasFromProject("ep1")).toBe(true);
		const vid = byRef("shotVid:sh1")!;
		const prompt = String(vid.data.params.prompt);
		// 画布枚举：上游故事板图（分镜1故事板）@Image1 → 表格素材顺延 @Image2/@Image3；正文保留
		expect(prompt).toContain("【素材图例】@Image1 是 分镜1故事板；@Image2 是 甲；@Image3 是 乙；");
		expect(prompt).toContain("正文");
		expect(prompt).not.toContain("@Image1 是 甲");
		// matOrder 同步锁定（上游边在前、表格素材在后），后续增删/@ 待选按同一枚举
		const order = vid.data.matOrder as string[];
		expect(order).toHaveLength(3);
		expect(order[0].startsWith("e:")).toBe(true);
		// 幂等：再次同步图例不堆叠、不再变化
		syncCanvasFromProject("ep1");
		expect(String(byRef("shotVid:sh1")!.data.params.prompt)).toBe(prompt);
	});

	it("用户挪动投影节点后，再次投影保留其位置（仅更新数据）", () => {
		useProjectStore.setState({
			scriptText: "原文", characters: [], scenes: [], items: [], organisms: [], crowds: [],
			episodes: [{ id: "ep1", title: "第一集", scriptText: "本集内容", shots: [] }],
		} as any);
		syncCanvasFromProject("ep1");
		const infer = byRef("episode:ep1")!;
		// 模拟用户在画布里挪动
		useCanvasStore.getState().moveNode(infer.id, 1234, 5678);
		// 资产模式改了本集内容 → 再投影
		useProjectStore.setState({ episodes: [{ id: "ep1", title: "第一集", scriptText: "本集内容-改", shots: [] }] } as any);
		syncCanvasFromProject("ep1");
		const after = byRef("episode:ep1")!;
		expect(after.x).toBe(1234);
		expect(after.y).toBe(5678);
		expect(after.data.params.prompt).toContain("本集内容-改");
	});
});
