/**
 * makeTermMatcher —— 高精度资产匹配标准（第86轮锁定，阈值 80%）：
 *  - 归一化精确子串：空格/标点/全半角/大小写差异不挡匹配，命中语义仍是全等；
 *  - 相似度 ≥80% 兜底：词长 <5 不允许任何编辑=必须全等（短中文名改一个字就是别人，绝不放宽）；
 *    5~9 字容 1 处出入，10+ 字容 2 处；
 *  - 图例前缀「【素材图例】…」在匹配前剥掉（防上一轮提取写入的资产名清单自我循环）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTermMatcher, stripLegendForMatch, applyAssetMatchToImageNode, matchNodeDraftAssets, matchAssetsInText, matchedAssetTextRanges } from "./assetMatch";
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
	it("图例与正文同行时只剥图例，正文仍参与匹配", () => {
		expect(stripLegendForMatch("【素材图例】@Image1 是 赵三娘，赵三娘和李四吃饭"))
			.toBe("赵三娘和李四吃饭");
	});
});

describe("matchAssetsInText 最长文本唯一匹配", () => {
	beforeEach(() => {
		useProjectStore.setState({ characters: [], crowds: [], scenes: [], organisms: [], items: [] } as never);
		useAssetFormStore.setState({ selForm: {} } as never);
	});

	it("子场景完整命中后不再用同一段文字匹配父场景", () => {
		useProjectStore.setState({
			scenes: [
				{ id: "S1", name: "医院", image: "mem://hospital", variants: [] },
				{ id: "S2", name: "医院·会诊室", image: "mem://consult", variants: [] },
			],
		} as never);
		expect(matchAssetsInText("医院·会诊室内正在开会").map((x) => x.assetId)).toEqual(["S2"]);
	});

	it("包含关系只占用一次，但不同位置再次出现仍可匹配另一个资产", () => {
		useProjectStore.setState({
			characters: [
				{ id: "C1", name: "学生", image: "mem://student", variants: [] },
				{ id: "C2", name: "医学生", image: "mem://med-student", variants: [] },
			],
		} as never);
		expect(matchAssetsInText("医学生正在值班").map((x) => x.assetId)).toEqual(["C2"]);
		expect(matchAssetsInText("医学生带着一名学生值班").map((x) => x.assetId)).toEqual(["C1", "C2"]);
	});

	it("两个资产使用同一个名称时同一文字只归属资产池中的第一项", () => {
		useProjectStore.setState({
			items: [
				{ id: "P1", name: "病历", image: "mem://record-1", variants: [] },
				{ id: "P2", name: "病历", image: "mem://record-2", variants: [] },
			],
		} as never);
		expect(matchAssetsInText("桌上放着病历").map((x) => x.assetId)).toEqual(["P1"]);
	});

	it("对白正文不参与匹配，但说话角色和非对白文字继续正常匹配", () => {
		useProjectStore.setState({
			characters: [{ id: "C1", name: "张医生", image: "mem://doctor", variants: [] }],
			scenes: [{ id: "S1", name: "医院", image: "mem://hospital", variants: [] }],
		} as never);
		expect(matchAssetsInText("张医生：医院那边来电话了").map((x) => x.assetId)).toEqual(["C1"]);
		expect(matchAssetsInText("护士：医院那边来电话了").map((x) => x.assetId)).toEqual(["S1"]);
		expect(matchAssetsInText("▲张医生放下病历，说：“医院那边来电话了。”").map((x) => x.assetId)).toEqual(["C1"]);
		expect(matchAssetsInText("▲张医生正在医院值班").map((x) => x.assetId)).toEqual(["C1", "S1"]);
		expect(matchAssetsInText("场景：医院").map((x) => x.assetId)).toEqual(["S1"]);
		expect(matchAssetsInText("镜头1：医院全景").map((x) => x.assetId)).toEqual(["S1"]);
	});

	it("结构标题后的资产正文保留，截图中的记忆梳理与资产绑定不当作对白", () => {
		const names = ["赵德柱", "刘备", "曹操", "孙权", "赵云", "典韦", "甘宁"];
		useProjectStore.setState({ characters: names.map((name) => ({ id: name, name, image: `mem://${name}`, variants: [] })) } as never);
		for (const heading of ["记忆梳理", "资产绑定", "当前人物情绪", "全局风格前缀", "判定结果"]) {
			expect(matchAssetsInText(`${heading}：${names.join("、")}位于云端；当前状态：夜晚。`).map((x) => x.assetId)).toEqual(names);
		}
	});

	it("冒号前包含人物资产、别名或群像时排除对白，保留带动作修饰的说话主体", () => {
		useProjectStore.setState({
			characters: [{ id: "C1", name: "刘备/玄德", image: "mem://liu", variants: [] }],
			crowds: [{ id: "C2", name: "守城士兵", image: "mem://guards", variants: [] }],
			scenes: [{ id: "S1", name: "医院", image: "mem://hospital", variants: [] }],
		} as never);
		for (const speaker of ["刘备（低声）", "▲玄德转身说道", "刘备与玄德齐声", "镜头中站在城墙前沉思片刻后缓缓转过身来的刘备低声说道"]) {
			expect(matchAssetsInText(`${speaker}：医院那边来电话了`).map((x) => x.assetId)).toEqual(["C1"]);
		}
		expect(matchAssetsInText("守城士兵齐声：去医院").map((x) => x.assetId)).toEqual(["C2"]);
	});

	it.each(["旁白", "旁白（低沉）", "内心os", "内心 OS", "内心独白", "画外音", "电话音", "广播", "众人"])("识别明确说话主体 %s", (speaker) => {
		useProjectStore.setState({ scenes: [{ id: "S1", name: "医院", image: "mem://hospital", variants: [] }] } as never);
		expect(matchAssetsInText(`${speaker}：医院那边来电话了`).map((x) => x.assetId)).toEqual([]);
	});

	it.each([["“", "”"], ['"', '"'], ["‘", "’"], ["'", "'"], ["「", "」"], ["『", "』"]])("仅排除 %s %s 包围的内容，保留同行动作和后续行", (open, close) => {
		useProjectStore.setState({
			characters: [{ id: "C1", name: "刘备", image: "mem://liu", variants: [] }],
			scenes: [{ id: "S1", name: "医院", image: "mem://hospital", variants: [] }],
		} as never);
		expect(matchAssetsInText(`刘备说${open}去医院${close}，然后转身。`).map((x) => x.assetId)).toEqual(["C1"]);
		expect(matchAssetsInText(`${open}刘备${close}：医院全景`).map((x) => x.assetId)).toEqual(["S1"]);
		expect(matchAssetsInText(`${open}去医院${close}\n刘备站在医院门口`).map((x) => x.assetId)).toEqual(["C1", "S1"]);
		expect(matchAssetsInText(`描述：${open}医院`).map((x) => x.assetId)).toEqual(["S1"]);
	});
});

describe("成对白边界结束后恢复资产匹配", () => {
	beforeEach(() => {
		useProjectStore.setState({ characters: ["孙权", "刘备", "曹操", "赵云", "典韦", "甘宁"].map((name, i) => ({ id: `C${i}`, name, image: `mem://${i}`, variants: [] })),
			crowds: [], scenes: [{ id: "S1", name: "镇魂宗", image: "mem://scene", variants: [] }], organisms: [], items: [] } as never);
		useAssetFormStore.setState({ selForm: {} });
	});
	it.each([["{", "}"], ["【", "】"], ["“", "”"], ["‘", "’"], ["’", "‘"], ['"', '"'], ["'", "'"], ["「", "」"], ["『", "』"]])("%s…%s 后的剧情继续匹配且坐标正确", (open, close) => {
		const text = `孙权说道：${open}刘备快来！${close}对白结束后，曹操、赵云前往镇魂宗。`;
		const hits: string[] = [];
		expect(matchAssetsInText(text, (_id, start, end) => hits.push(text.slice(start, end))).map(a => a.name).sort())
			.toEqual(["孙权", "曹操", "赵云", "镇魂宗"].sort());
		expect(hits.sort()).toEqual(["孙权", "曹操", "赵云", "镇魂宗"].sort());
	});
	it("截图原文：尾部再次出现的已匹配人物也能高亮", () => {
		const text = "刘备、曹操、孙权位于镇魂宗上空云端。孙权说道：{快快快，我们大老远赶来做客，好歹让我们看看！}对白结束后，刘备、曹操、孙权同时发出笑声。赵云、典韦、甘宁站在刘备、曹操、孙权后方云端。";
		const hits: Array<{ name: string; start: number }> = [];
		matchAssetsInText(text, (_id, start, end) => hits.push({ name: text.slice(start, end), start }));
		expect(hits.filter(h => h.start > text.indexOf("对白结束后")).map(h => h.name).sort())
			.toEqual(["刘备", "曹操", "孙权", "赵云", "典韦", "甘宁", "刘备", "曹操", "孙权"].sort());
	});
	it("同行多段对白各自在闭合符结束，嵌套符号不提前结束", () => {
		const text = '孙权说：{刘备说“曹操”，还有【典韦】。}赵云走来。赵云说：“甘宁在哪里？”曹操现身。';
		expect(matchAssetsInText(text).map(a => a.name).sort()).toEqual(["孙权", "赵云", "曹操"].sort());
	});
	it("说话人和冒号在括号内部时，闭合后恢复；普通结构括号仍匹配", () => {
		expect(matchAssetsInText("【孙权说：刘备快来】曹操走来").map(a => a.name).sort()).toEqual(["孙权", "曹操"].sort());
		expect(matchAssetsInText("【记忆梳理】刘备在{镇魂宗}外等候").map(a => a.name).sort()).toEqual(["刘备", "镇魂宗"].sort());
	});
	it("未闭合对白沿用行尾边界，下一行正常匹配", () => {
		expect(matchAssetsInText("孙权说：{刘备快来\n曹操走来").map(a => a.name).sort()).toEqual(["孙权", "曹操"].sort());
	});
});

describe("已加入素材的资产文字高亮", () => {
	beforeEach(() => {
		useProjectStore.setState({
			characters: [
				{ id: "C1", name: "刘备/玄德", image: "mem://liu", variants: [{ id: "V1", name: "刘备战甲", image: "mem://armor" }] },
				{ id: "C2", name: "曹操", image: "mem://cao", variants: [] },
			],
			crowds: [], scenes: [], organisms: [], items: [], assetBlobs: {},
		} as never);
		useAssetFormStore.setState({ selForm: {} } as never);
	});
	const selected = [{ assetId: "C1", uri: "mem://liu" }];
	it("只标素材区已有资产，保持原文坐标并排除对白", () => {
		const text = '  记忆梳理：刘 备、曹操。\r\n刘备（低声）：曹操与玄德来了。\n“玄德”转身，玄德站定。';
		expect(matchedAssetTextRanges(text, selected).map((r) => text.slice(r.start, r.end))).toEqual(["刘 备", "刘备", "玄德"]);
		expect(matchedAssetTextRanges(text, [])).toEqual([]);
		expect(matchedAssetTextRanges(text, [{ uri: "mem://unrelated" }])).toEqual([]);
	});
	it("支持变体身份及图片反查，音色引用不冒充已加入的角色图", () => {
		const text = "刘备战甲与玄德站定";
		for (const material of [{ assetId: "V1", uri: "mem://expired" }, { uri: "mem://armor" }]) {
			expect(matchedAssetTextRanges(text, [material]).map((r) => text.slice(r.start, r.end))).toEqual(["刘备战甲", "玄德"]);
		}
		expect(matchedAssetTextRanges(text, [{ assetId: "C1", uri: "mem://voice", media: "audio" }])).toEqual([]);
	});
	it("保留最长名称唯一匹配，不把未加入的长名称资产标成已有短名称", () => {
		useProjectStore.setState({ characters: [
			{ id: "C1", name: "学生", image: "mem://short", variants: [] },
			{ id: "C2", name: "医学生", image: "mem://long", variants: [] },
		] } as never);
		const text = "医学生带学生值班";
		expect(matchedAssetTextRanges(text, selected)).toEqual([{ start: 4, end: 6 }]);
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

	it("匹配到资产后：提示词前置「【素材图例】@Image1 是 资产名；」+ 图追加进素材区", () => {
		useProjectStore.setState({
			characters: [{ id: "C1", name: "张三", image: "mem://c1", variants: [] }],
			crowds: [], scenes: [], organisms: [], items: [],
		} as never);
		useCanvasStore.setState({ nodes: { n1: mkNode("n1", { params: { prompt: "张三站在门口" } }) } } as never);
		const added = applyAssetMatchToImageNode("n1");
		expect(added).toBe(1);
		const n = useCanvasStore.getState().nodes.n1;
		const p = n.data.params.prompt as string;
		expect(p.startsWith("【素材图例】@Image1 是 张三；")).toBe(true);
		expect(p.includes("张三站在门口")).toBe(true);
		const imgs = (n.data.input as { images?: { name?: string }[] }).images || [];
		expect(imgs.length).toBe(1);
		expect(imgs[0].name).toBe("张三");
	});

	it("视频角色绑定音色：加入声音参考音频 + 图例配对「@ImageN的声音参考@AudioM」", () => {
		useProjectStore.setState({
			characters: [{ id: "C1", name: "张三", image: "mem://c1", variants: [], voiceUri: "mem://v1", voiceAssetId: "AU1", voiceName: "张三的声音" }],
			crowds: [], scenes: [], organisms: [], items: [],
		} as never);
		useCanvasStore.setState({ nodes: { n1: { ...mkNode("n1", { params: { prompt: "张三开口说话" } }), type: "video.gen" } } } as never);
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
		expect(r!.prompt.startsWith("【素材图例】@Image1 是 张三；")).toBe(true);
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
		expect(p.startsWith("【素材图例】@Image1 是 张三；@Image2 是 分镜；")).toBe(true);
		expect(p).not.toContain("gen_output");
		expect(n.data.matOrder).toEqual(["s:mem://c1", "e:e1"]);
	});
});
