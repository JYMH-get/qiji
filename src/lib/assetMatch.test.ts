/**
 * makeTermMatcher —— 高精度资产匹配标准（第86轮锁定，阈值 80%）：
 *  - 归一化精确子串：空格/标点/全半角/大小写差异不挡匹配，命中语义仍是全等；
 *  - 相似度 ≥80% 兜底：词长 <5 不允许任何编辑=必须全等（短中文名改一个字就是别人，绝不放宽）；
 *    5~9 字容 1 处出入，10+ 字容 2 处；
 *  - 图例前缀「【素材图例】…」在匹配前剥掉（防上一轮提取写入的资产名清单自我循环）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTermMatcher, stripLegendForMatch, applyAssetMatchToImageNode, matchNodeDraftAssets } from "./assetMatch";
import { useCanvasStore } from "@/store/canvasStore";
import { useProjectStore } from "@/store/projectStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import type { CanvasNode, NodeData } from "@/types";

describe("makeTermMatcher 高精度匹配", () => {
	it("精确子串命中", () => {
		const m = makeTermMatcher("▲陈瞎子坐在张起天的床边，正在擦他的桃木剑。");
		expect(m("张起天")).toBe(true);
		expect(m("桃木剑")).toBe(true);
		expect(m("陈青鸢")).toBe(false);
	});

	it("归一化：空格/标点/大小写差异不挡匹配", () => {
		expect(makeTermMatcher("镜头推向 张 起天 的面部")("张起天")).toBe(true);
		expect(makeTermMatcher("场景切到「山中·木屋」内部")("山中木屋")).toBe(true);
		expect(makeTermMatcher("the BLADE-Sword gleams")("Blade Sword")).toBe(true);
	});

	it("短资产名（<5 字）必须全等：改一个字就是别人，80% 阈值不放宽", () => {
		expect(makeTermMatcher("张启天缓缓睁眼")("张起天")).toBe(false);
		expect(makeTermMatcher("陈瞎子擦着桃花剑")("桃木剑")).toBe(false);
	});

	it("中长词允许 ≥80% 相似（6 字 1 处出入 ≈83%；10 字 2 处 = 80%）", () => {
		// 6 字场景名 1 字之差 → 83% ≥80%，采用
		expect(makeTermMatcher("众人退入青云剑宗主殿")("青云剑宗大殿")).toBe(true);
		// 10 字 2 处出入 → 恰好 80%，采用
		expect(makeTermMatcher("幽冥血海玄天老祖真身出现")("幽冥血海玄殿老祖分身")).toBe(true);
		// 3 处出入 → 70%，不采用
		expect(makeTermMatcher("幽冥血河玄天老祖真身出现")("幽冥血海玄殿老祖分身")).toBe(false);
	});

	it("空词不命中", () => {
		expect(makeTermMatcher("任意文本")("")).toBe(false);
		expect(makeTermMatcher("任意文本")("　。，")).toBe(false);
	});
});

describe("stripLegendForMatch", () => {
	it("剥掉图例前缀行，正文保留", () => {
		const s = "【素材图例】@Image1 是 楚长生，@Image1的声音参考@Audio1，\n镜头推近，楚长生抬头。";
		expect(stripLegendForMatch(s)).toBe("镜头推近，楚长生抬头。");
	});
});

// ── applyAssetMatchToImageNode：匹配后写入「素材图例」前缀（与资产模式同格式 @xxx是xxx）──
const mkNode = (id: string, data: Partial<NodeData> = {}): CanvasNode => ({
	id, type: "image.gen", x: 0, y: 0, w: 240, h: 200, parentId: null, parentScriptId: null,
	data: { input: {}, params: {}, resultAssetId: null, ...data },
});

describe("applyAssetMatchToImageNode 写入素材图例", () => {
	beforeEach(() => {
		useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {}, past: [], future: [] } as never);
		useProjectStore.setState({ characters: [], crowds: [], scenes: [], organisms: [], items: [] } as never);
		useAssetFormStore.setState({ selForm: {} } as never);
	});

	it("匹配到资产后：提示词前置「【素材图例】@Image1 是 资产名，」+ 图追加进素材区", () => {
		useProjectStore.setState({
			characters: [{ id: "C1", name: "张三", image: "mem://c1", variants: [] }],
			crowds: [], scenes: [], organisms: [], items: [],
		} as never);
		useCanvasStore.setState({ nodes: { n1: mkNode("n1", { params: { prompt: "张三站在门口" } }) } } as never);
		const added = applyAssetMatchToImageNode("n1");
		expect(added).toBe(1);
		const n = useCanvasStore.getState().nodes.n1;
		const p = n.data.params.prompt as string;
		expect(p.startsWith("【素材图例】@Image1 是 张三，")).toBe(true);
		expect(p.includes("张三站在门口")).toBe(true);
		const imgs = (n.data.input as { images?: { name?: string }[] }).images || [];
		expect(imgs.length).toBe(1);
		expect(imgs[0].name).toBe("张三");
	});

	it("角色绑定音色：加入声音参考音频 + 图例配对「@ImageN的声音参考@AudioM」", () => {
		useProjectStore.setState({
			characters: [{ id: "C1", name: "张三", image: "mem://c1", variants: [], voiceUri: "mem://v1", voiceAssetId: "AU1", voiceName: "张三的声音" }],
			crowds: [], scenes: [], organisms: [], items: [],
		} as never);
		useCanvasStore.setState({ nodes: { n1: mkNode("n1", { params: { prompt: "张三开口说话" } }) } } as never);
		const added = applyAssetMatchToImageNode("n1");
		expect(added).toBe(2); // 图 + 音频
		const n = useCanvasStore.getState().nodes.n1;
		const input = n.data.input as { images?: unknown[]; audios?: { name?: string }[] };
		expect(input.images?.length).toBe(1);
		expect(input.audios?.length).toBe(1);
		const p = n.data.params.prompt as string;
		expect(p.includes("@Image1 是 张三")).toBe(true);
		expect(p.includes("@Image1的声音参考@Audio1")).toBe(true);
	});

	it("幂等：再次匹配不堆叠图例（只保留一个前缀、无新增返回 0）", () => {
		useProjectStore.setState({
			characters: [{ id: "C1", name: "张三", image: "mem://c1", variants: [] }],
			crowds: [], scenes: [], organisms: [], items: [],
		} as never);
		useCanvasStore.setState({ nodes: { n1: mkNode("n1", { params: { prompt: "张三站在门口" } }) } } as never);
		applyAssetMatchToImageNode("n1");
		const again = applyAssetMatchToImageNode("n1");
		expect(again).toBe(0);
		const p = useCanvasStore.getState().nodes.n1.data.params.prompt as string;
		expect(p.match(/【素材图例】/g)?.length).toBe(1);
	});

	it("promptOverride（放大弹窗草稿）：以草稿为准匹配与写图例，节点旧提示词被草稿+图例取代", () => {
		useProjectStore.setState({
			characters: [{ id: "C1", name: "张三", image: "mem://c1", variants: [] }],
			crowds: [], scenes: [], organisms: [], items: [],
		} as never);
		// 节点已存提示词不含资产名——只有草稿点名了张三
		useCanvasStore.setState({ nodes: { n1: mkNode("n1", { params: { prompt: "旧提示词无资产" } }) } } as never);
		const r = matchNodeDraftAssets("n1", "草稿：张三站在门口");
		expect(r).not.toBeNull();
		expect(r!.added).toBe(1);
		expect(r!.prompt.startsWith("【素材图例】@Image1 是 张三，")).toBe(true);
		expect(r!.prompt.includes("草稿：张三站在门口")).toBe(true);
		// 节点提示词同步为草稿+图例（弹窗保存时再落同值幂等）
		expect(useCanvasStore.getState().nodes.n1.data.params.prompt).toBe(r!.prompt);
	});

	it("matchNodeDraftAssets 无匹配且无变化 → null（草稿不被回写扰动）", () => {
		useProjectStore.setState({ characters: [], crowds: [], scenes: [], organisms: [], items: [] } as never);
		useCanvasStore.setState({ nodes: { n1: mkNode("n1", { params: { prompt: "别的内容" } }) } } as never);
		expect(matchNodeDraftAssets("n1", "没有任何资产名")).toBeNull();
	});

	it("先匹配后连线：匹配落 matOrder，后连的上游素材追加在后，再匹配只在尾部加条目、原编号不变", () => {
		useProjectStore.setState({
			characters: [{ id: "C1", name: "张三", image: "mem://c1", variants: [] }],
			crowds: [], scenes: [], organisms: [], items: [],
		} as never);
		useCanvasStore.setState({ nodes: { n1: mkNode("n1", { params: { prompt: "张三站在门口" } }) } } as never);
		// ① 匹配：素材加入顺序落进 matOrder
		applyAssetMatchToImageNode("n1");
		expect(useCanvasStore.getState().nodes.n1.data.matOrder).toEqual(["s:mem://c1"]);
		// ② 再连上游分镜节点（有出图）：按「素材只往后加」排在已匹配素材之后
		useLibraryStore.setState({
			assets: { A1: { id: "A1", kind: "image", name: "image.gen_output_1784416763719", uri: "mem://A1", serverAssetId: null, thumbnailUri: null, createdAt: "", deletedByUser: false, localPath: null } },
		} as never);
		useCanvasStore.setState({
			nodes: {
				...useCanvasStore.getState().nodes,
				up: mkNode("up", { resultAssetId: "A1", title: "分镜" }),
			},
			edges: { e1: { id: "e1", kind: "dataflow", source: "up", sourcePort: "out", target: "n1", targetPort: "in" } },
		} as never);
		// ③ 再匹配：图例在尾部补上游条目（节点标题命名），@Image1 仍是张三
		applyAssetMatchToImageNode("n1");
		const n = useCanvasStore.getState().nodes.n1;
		const p = String(n.data.params.prompt);
		expect(p.startsWith("【素材图例】@Image1 是 张三，@Image2 是 分镜，")).toBe(true);
		expect(p).not.toContain("gen_output");
		expect(n.data.matOrder).toEqual(["s:mem://c1", "e:e1"]);
	});
});
