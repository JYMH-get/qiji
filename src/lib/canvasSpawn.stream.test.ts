/**
 * IncrementalSpawner —— 流式增量裂变测试（第84轮）。
 * 核心约定：
 *  - 两次「文本有增长」的快照间内容签名不变的项 = 已闭合，立刻裂变；
 *  - 仍在流式输出中的项（签名还在变）绝不提前裂变；
 *  - final=true 按完整全文补齐剩余；已裂变项不重复；
 *  - 全程解析不出任何项 → total 为 0（调用方据此报错，不再静默）。
 */
import { describe, it, expect } from "vitest";
import { IncrementalSpawner, buildSpawn, buildRespawn } from "./canvasSpawn";
import type { CanvasNode, CanvasEdge } from "@/types";

const FULL_JSON = `{
  "visualBible": "3D国漫风，电影感打光",
  "characters": [
    { "code": "C01", "name": "张起天", "imagePrompt": "3D国漫风，男主角张起天，青年男性，剑眉星目，黑色长发束起，白色里衣，电影感打光，全身立绘，纯色背景" },
    { "code": "C02", "name": "陈瞎子", "imagePrompt": "3D国漫风，老者陈瞎子，盲眼，灰白长发，手持桃木剑，粗布道袍，电影感打光，全身立绘，纯色背景" }
  ],
  "scenes": [
    { "code": "S01", "name": "山中木屋", "imagePrompt": "3D国漫风，山中木屋内景，日，小雨，木质结构，昏暗光线，空镜无人" }
  ],
  "props": [
    { "code": "P01", "name": "桃木剑", "imagePrompt": "3D国漫风，桃木剑特写，古朴纹路，红绳缠柄，纯色背景" }
  ]
}`;

const parent = {
	id: "n-parent",
	type: "asset.split",
	x: 100,
	y: 100,
	w: 320,
	h: 200,
	data: { params: {} },
} as unknown as CanvasNode;

const spawnSpec = { childType: "image.gen", source: "assets" } as const;

describe("IncrementalSpawner 资产流式裂变", () => {
	it("已闭合的资产在下一次增长快照立即裂变；流式中的资产不提前裂变", () => {
		const sp = new IncrementalSpawner(parent, spawnSpec);
		// C01 已闭合、C02 的 imagePrompt 只出到一半
		const cut = FULL_JSON.indexOf("灰白长发");
		const t1 = FULL_JSON.slice(0, cut);
		expect(sp.feed(t1).nodes.length).toBe(0); // 首见：还无法判定闭合

		// 文本增长（C02 提示词继续出）：C01 签名未变 → 裂变；C02 仍在变 → 不裂变
		const t2 = FULL_JSON.slice(0, cut + 20);
		const b2 = sp.feed(t2);
		expect(b2.nodes.length).toBe(1);
		expect(b2.nodes[0].type).toBe("image.gen");
		expect(String(b2.nodes[0].data.params.prompt)).toContain("张起天");
		expect(b2.edges.length).toBe(1);
		expect(b2.edges[0].source).toBe(parent.id);

		// 无增长的快照不推进判定（模型停顿时不会把半截提示词误判为完整）
		expect(sp.feed(t2).nodes.length).toBe(0);

		// final：按完整全文补齐剩余 3 个，且 C01 不重复
		const bf = sp.feed(FULL_JSON, true);
		expect(bf.nodes.length).toBe(3);
		expect(sp.total).toBe(4);
	});

	it("final 直接喂完整全文（无流式过程）也能全量裂变", () => {
		const sp = new IncrementalSpawner(parent, spawnSpec);
		const b = sp.feed(FULL_JSON, true);
		expect(b.nodes.filter((n) => n.type === "image.gen").length).toBe(4);
		expect(sp.total).toBe(4);
	});

	it("final 传空文本时回退到最近一次流式全文", () => {
		const sp = new IncrementalSpawner(parent, spawnSpec);
		sp.feed(FULL_JSON);
		const b = sp.feed("", true);
		expect(sp.total).toBe(4);
		expect(b.nodes.length).toBe(4);
	});

	it("裂变节点带资产模式同款 purpose/编号前缀/资产名（同路由同编号）", () => {
		const sp = new IncrementalSpawner(parent, spawnSpec);
		const b = sp.feed(FULL_JSON, true);
		const byName = (kw: string) => b.nodes.find((n) => String(n.data.params.assetName || "").includes(kw))!;
		expect(byName("张起天").data.params.purpose).toBe("asset.character.image");
		expect(byName("张起天").data.params.idPrefix).toBe("C");
		expect(byName("山中木屋").data.params.purpose).toBe("asset.scene.image");
		expect(byName("山中木屋").data.params.idPrefix).toBe("S");
		expect(byName("桃木剑").data.params.purpose).toBe("asset.prop.image");
		expect(byName("桃木剑").data.params.idPrefix).toBe("P");
	});

	it("变体裂变：主体→变体 直接连线（垫图参考），拆分→变体 边保留", () => {
		const VJSON = `{
		  "characters": [
		    { "code": "C01", "name": "张起天", "imagePrompt": "主体出图提示词",
		      "variants": [ { "code": "C01A", "name": "战损", "imagePrompt": "变体出图提示词" } ] }
		  ]
		}`;
		// 一次性路径（变体命名沿用「父名 · 造型名」；本例无 status/label → 造型名回退"变体"）
		const b = buildSpawn(parent, { spawn: spawnSpec }, VJSON);
		expect(b.nodes.length).toBe(2);
		const baseN = b.nodes.find((n) => n.data.params.assetName === "张起天")!;
		const varN = b.nodes.find((n) => String(n.data.params.assetName).startsWith("张起天 · "))!;
		expect(varN.data.params.assetCode).toBe("C01A"); // 变体编号随节点（回查/注册用）
		expect(b.edges.length).toBe(3); // split→主体、split→变体、主体→变体
		expect(b.edges.some((e) => e.source === baseN.id && e.target === varN.id)).toBe(true);
		expect(b.edges.filter((e) => e.source === parent.id).length).toBe(2);
		// 流式路径（跨批次回查主体）
		const sp = new IncrementalSpawner(parent, spawnSpec);
		const sb = sp.feed(VJSON, true);
		const sBase = sb.nodes.find((n) => n.data.params.assetName === "张起天")!;
		const sVar = sb.nodes.find((n) => String(n.data.params.assetName).startsWith("张起天 · "))!;
		expect(sb.edges.some((e) => e.source === sBase.id && e.target === sVar.id)).toBe(true);
	});

	it("解析不出任何资产时 total 为 0（调用方据此报错）", () => {
		const sp = new IncrementalSpawner(parent, spawnSpec);
		sp.feed("这是一段与资产提取无关的普通文字。", true);
		expect(sp.total).toBe(0);
	});
});

describe("IncrementalSpawner 智能推理卡片流式裂变", () => {
	const card = (n: number) =>
		`{ "card_number": "第${n}卡", "original_script": "分镜${n}原文", "storyboard_prompts": "故事板提示词${n}", "video_prompts": "视频提示词${n}" }`;
	const CARDS = `[\n${card(1)},\n${card(2)}\n]`;
	const inferParent = { ...parent, id: "n-infer", type: "smart.infer" } as unknown as CanvasNode;
	const cardSpec = { childType: "text.seed", source: "cards" } as const;

	it("每闭合一卡裂变一条 文本→图→视频 流水线", () => {
		const sp = new IncrementalSpawner(inferParent, cardSpec);
		const cut = CARDS.indexOf("故事板提示词2");
		sp.feed(CARDS.slice(0, cut));
		const b2 = sp.feed(CARDS.slice(0, cut + 5));
		// 第1卡闭合 → text.seed + image.gen + video.gen 三节点
		expect(b2.nodes.map((n) => n.type)).toEqual(["smart.infer", "image.gen", "video.gen"]);
		expect(b2.edges.length).toBe(3);

		const bf = sp.feed(CARDS, true);
		expect(bf.nodes.map((n) => n.type)).toEqual(["smart.infer", "image.gen", "video.gen"]);
		expect(sp.total).toBe(2);
	});

	it("流水线三连节点命名：分镜n原文 / 分镜n故事板 / 分镜n视频（data.title）", () => {
		const b = buildSpawn(inferParent, { spawn: cardSpec }, CARDS);
		expect(b.nodes.map((n) => n.data.title)).toEqual([
			"分镜1原文", "分镜1故事板", "分镜1视频",
			"分镜2原文", "分镜2故事板", "分镜2视频",
		]);
	});

	it("liveParent 相对定位：流式期间父节点被拖动 → 后续裂变按父节点**当前**位置落点", () => {
		let cur = { ...inferParent };
		const sp = new IncrementalSpawner(inferParent, cardSpec, () => cur);
		const t1 = `[${card(1)},{ "card_number": "第2卡", "original_script": "流式中`;
		sp.feed(t1);
		const b1 = sp.feed(t1 + "更多");
		// 第1卡：按原位置（baseX = x + w + GAP_X = 100+320+90）
		expect(b1.nodes[0].x).toBe(510);
		expect(b1.nodes[0].y).toBe(100);
		// 用户拖动了主节点 → 第2卡按新位置出（不再钉死在开跑时的旧坐标）
		cur = { ...inferParent, x: 5000, y: 3000 };
		const b2 = sp.feed(`[${card(1)},${card(2)}]`, true);
		expect(b2.nodes[0].x).toBe(5000 + 320 + 90);
		expect(b2.nodes[0].y).toBe(3000 + (200 + 48)); // 第2卡 i=1 行
	});

	it("分镜原文节点自跑（shotScriptSelf）：只裂变 故事板/视频 接到自身，分镜号沿用自己标题", () => {
		const rowNode = {
			...parent,
			id: "n-row",
			type: "smart.infer",
			data: { params: { prompt: "本镜原文" }, title: "分镜3原文" },
		} as unknown as CanvasNode;
		const sp = new IncrementalSpawner(rowNode, cardSpec, undefined, { shotScriptSelf: true });
		const b = sp.feed('[{ "card_number": "第1卡", "duration": 6, "original_script": "本镜原文", "storyboard_prompts": "新故事板", "video_prompts": "新视频" }]', true);
		expect(b.nodes.map((n) => n.type)).toEqual(["image.gen", "video.gen"]); // 不再建原文节点
		expect(b.nodes.map((n) => n.data.title)).toEqual(["分镜3故事板", "分镜3视频"]);
		expect(b.edges[0].source).toBe("n-row"); // 图直接接到原文节点自身
		expect(b.edges[1].source).toBe(b.nodes[0].id);
		expect(b.nodes[1].data.params.duration).toBe(6);
	});

	it("卡带 duration → 视频节点 duration 参数（按 spec 范围收敛：2.2→4、8→8、30→15；缺失=默认）", () => {
		const cardD = (n: number, d: string) =>
			`{ "card_number": "第${n}卡", "duration": ${d}, "original_script": "原文${n}", "storyboard_prompts": "sb${n}", "video_prompts": "vp${n}" }`;
		const text = `[${cardD(1, "2.2")},${cardD(2, "8")},${cardD(3, "30")},${card(4)}]`;
		const b = buildSpawn(inferParent, { spawn: cardSpec }, text);
		const vids = b.nodes.filter((n) => n.type === "video.gen");
		expect(vids.map((n) => n.data.params.duration)).toEqual([4, 8, 15, 15]); // 第4卡无 duration → spec 默认 15（用户定档）
	});

	it("流式裂变同样带 duration（IncrementalSpawner 路径）", () => {
		const sp = new IncrementalSpawner(inferParent, cardSpec);
		const b = sp.feed('[{ "card_number": "第1卡", "duration": 7, "original_script": "a", "storyboard_prompts": "s", "video_prompts": "v" }]', true);
		const vid = b.nodes.find((n) => n.type === "video.gen")!;
		expect(vid.data.params.duration).toBe(7);
	});

	it("尾卡假闭合回归：原文闭合后、提示词「键已出值未出」的空窗不误裂变（漏图漏视频的根因）", () => {
		const sp = new IncrementalSpawner(inferParent, cardSpec);
		// t1：尾卡原文值已闭合，storyboard 还没出
		const t1 = '[{ "card_number": "第1卡", "duration": 12, "original_script": "原文一",';
		expect(sp.feed(t1).nodes.length).toBe(0);
		// t2：文本有增长，但只增长了下一字段的 键名+开引号（值为空）——签名与 t1 相同，
		// 旧逻辑在此误判闭合 → 只裂变文本节点，且 final 也救不回（key 已进去重集）
		const t2 = t1 + ' "storyboard_prompts": "';
		expect(sp.feed(t2).nodes.length).toBe(0);
		// t3：提示词继续流出，仍不裂变（尾卡等 final）
		const t3 = t2 + "故事板内容";
		expect(sp.feed(t3).nodes.length).toBe(0);
		// final：完整全文 → 一次性裂变完整流水线 文本→图→视频
		const full = t3 + '", "video_prompts": "视频内容" }]';
		const b = sp.feed(full, true);
		expect(b.nodes.map((n) => n.type)).toEqual(["smart.infer", "image.gen", "video.gen"]);
		expect(sp.total).toBe(1);
	});

	it("图视同源卡（unified_prompt）：同源提示词独立节点承载，图片/视频**不内置提示词**并联接同源节点", () => {
		const UJSON = `[{ "card_number": "第1卡", "duration": 12, "original_script": "分镜1原文", "unified_prompt": "同源提示词一" }]`;
		const b = buildSpawn(inferParent, { spawn: cardSpec }, UJSON);
		// 原文(smart.infer) + 同源提示词(text.seed) + 图片(image.gen) + 视频(video.gen)
		expect(b.nodes.map((n) => n.type)).toEqual(["smart.infer", "text.seed", "image.gen", "video.gen"]);
		const [txt, uni, img, vid] = b.nodes;
		expect(txt.data.title).toBe("分镜1原文");
		expect(txt.data.params.templateId).toBe("smart.infer.unified.single"); // 自跑仍同源
		expect(uni.data.title).toBe("分镜1同源提示词");
		expect(uni.data.params.prompt).toBe("同源提示词一"); // 提示词只在同源节点（单一来源）
		expect(img.data.title).toBe("分镜1图片");
		expect(img.data.params.prompt).toBe(""); // 不内置：运行时取上游同源节点文本
		expect(vid.data.params.prompt).toBe("");
		expect(vid.data.params.duration).toBe(12);
		// 链路：原文→同源；图片与视频**并联**接同源节点（不是 图→视频 串联）
		expect(b.edges.find((e) => e.target === uni.id)!.source).toBe(txt.id);
		expect(b.edges.find((e) => e.target === img.id)!.source).toBe(uni.id);
		expect(b.edges.find((e) => e.target === vid.id)!.source).toBe(uni.id);
	});

	it("图视同源二次解析（buildRespawn）：残行补 同源节点+图+视频；已有同源节点只补缺", () => {
		const RESULT_U = JSON.stringify([
			{ card_number: "第1卡", duration: 8, original_script: "第一卡原文内容，长度超过二十四个字符以便前缀匹配判定。", unified_prompt: "同源一" },
		]);
		// 行存在但下游为空 → 补 同源+图+视频 三节点
		const row = {
			id: "r1", type: "smart.infer", x: 400, y: 100, w: 240, h: 200, parentId: null, parentScriptId: "n-infer",
			data: { input: {}, params: { prompt: "第一卡原文内容，长度超过二十四个字符以便前缀匹配判定。" }, resultAssetId: null },
		} as unknown as CanvasNode;
		const nodes = { "n-infer": inferParent, r1: row } as Record<string, CanvasNode>;
		const edges = { e1: { id: "e1", kind: "dataflow", source: "n-infer", sourcePort: "out", target: "r1", targetPort: "in" } as CanvasEdge };
		const b = buildRespawn(inferParent, cardSpec, RESULT_U, nodes, edges);
		expect(b.patched).toBe(1);
		expect(b.nodes.map((n) => n.type)).toEqual(["text.seed", "image.gen", "video.gen"]);
		const [uni, img, vid] = b.nodes;
		expect(uni.data.params.prompt).toBe("同源一");
		expect(img.data.params.prompt).toBe("");
		expect(b.edges.find((e) => e.target === uni.id)!.source).toBe("r1");
		expect(b.edges.find((e) => e.target === img.id)!.source).toBe(uni.id);
		expect(b.edges.find((e) => e.target === vid.id)!.source).toBe(uni.id);
	});

	it("多卡时非尾卡照常流式裂变（出现下一卡即不再是尾卡）", () => {
		const sp = new IncrementalSpawner(inferParent, cardSpec);
		// 第1卡完整 + 第2卡刚开头（第1卡已非尾卡）
		const t1 = `[${card(1)},{ "card_number": "第2卡", "original_script": "流式中`;
		expect(sp.feed(t1).nodes.length).toBe(0); // 首见：稳定性判定尚无历史
		const t2 = t1 + "继续";
		const b2 = sp.feed(t2);
		expect(b2.nodes.map((n) => n.type)).toEqual(["smart.infer", "image.gen", "video.gen"]); // 第1卡裂变
		const bf = sp.feed(`[${card(1)},${card(2)}]`, true);
		expect(bf.nodes.map((n) => n.type)).toEqual(["smart.infer", "image.gen", "video.gen"]); // 第2卡补齐
		expect(sp.total).toBe(2);
	});
});

describe("buildSpawn 一次性裂变（回归）", () => {
	it("资产 → image.gen 节点", () => {
		const built = buildSpawn(parent, { spawn: spawnSpec }, FULL_JSON);
		expect(built.nodes.filter((n) => n.type === "image.gen").length).toBe(4);
		expect(built.edges.length).toBe(4);
	});
});

describe("buildRespawn 二次解析（只补缺漏）", () => {
	const inferParent = { ...parent, id: "n-infer", type: "smart.infer" } as unknown as CanvasNode;
	const cardSpec = { childType: "text.seed", source: "cards" } as const;
	const mkChild = (id: string, type: string, params: Record<string, unknown>, x = 0, y = 0): CanvasNode =>
		({ id, type, x, y, w: 240, h: 200, parentId: null, parentScriptId: "n-infer", data: { input: {}, params, resultAssetId: null } } as CanvasNode);
	const mkE = (id: string, source: string, target: string): CanvasEdge =>
		({ id, kind: "dataflow", source, sourcePort: "out", target, targetPort: "in" } as CanvasEdge);

	const RESULT = JSON.stringify([
		{ card_number: "第1卡", duration: 6, original_script: "第一卡原文内容，长度超过二十四个字符以便前缀匹配判定。", storyboard_prompts: "故事板一", video_prompts: "视频一" },
		{ card_number: "第2卡", duration: 9, original_script: "第二卡原文内容，同样长度超过二十四个字符以便匹配判定。", storyboard_prompts: "故事板二", video_prompts: "视频二" },
	]);

	it("残行（只有文本节点）→ 补建 图/视频 并接到该行；完整行不动", () => {
		// 第1卡完整流水线；第2卡只有文本节点（尾卡假闭合留下的残行）
		const t1 = mkChild("t1", "text.seed", { prompt: "第一卡原文内容，长度超过二十四个字符以便前缀匹配判定。" }, 400, 100);
		const i1 = mkChild("i1", "image.gen", { prompt: "故事板一" }, 700, 100);
		const v1 = mkChild("v1", "video.gen", { prompt: "视频一" }, 1000, 100);
		const t2 = mkChild("t2", "text.seed", { prompt: "第二卡原文内容，同样长度超过二十四个字符以便匹配判定。" }, 400, 350);
		const nodes = { "n-infer": inferParent, t1, i1, v1, t2 } as Record<string, CanvasNode>;
		const edges = {
			e1: mkE("e1", "n-infer", "t1"), e2: mkE("e2", "t1", "i1"), e3: mkE("e3", "i1", "v1"),
			e4: mkE("e4", "n-infer", "t2"),
		};
		const b = buildRespawn(inferParent, cardSpec, RESULT, nodes, edges);
		expect(b.parsed).toBe(2);
		expect(b.added).toBe(0);
		expect(b.patched).toBe(1);
		expect(b.nodes.map((n) => n.type)).toEqual(["image.gen", "video.gen"]);
		expect(b.nodes[0].data.params.prompt).toBe("故事板二");
		expect(b.nodes[1].data.params.duration).toBe(9); // 卡时长跟着补上
		// 新图接在已有文本节点 t2 上，新视频接在新图上
		expect(b.edges[0].source).toBe("t2");
		expect(b.edges[1].source).toBe(b.nodes[0].id);
	});

	it("整卡缺失 → 补全新流水线；全部齐全 → 不产任何节点", () => {
		const t1 = mkChild("t1", "text.seed", { prompt: "第一卡原文内容，长度超过二十四个字符以便前缀匹配判定。" }, 400, 100);
		const i1 = mkChild("i1", "image.gen", { prompt: "故事板一" }, 700, 100);
		const v1 = mkChild("v1", "video.gen", { prompt: "视频一" }, 1000, 100);
		const nodes = { "n-infer": inferParent, t1, i1, v1 } as Record<string, CanvasNode>;
		const edges = { e1: mkE("e1", "n-infer", "t1"), e2: mkE("e2", "t1", "i1"), e3: mkE("e3", "i1", "v1") };
		const b = buildRespawn(inferParent, cardSpec, RESULT, nodes, edges);
		expect(b.added).toBe(1); // 第2卡整行新增
		expect(b.nodes.map((n) => n.type)).toEqual(["smart.infer", "image.gen", "video.gen"]);

		// 把第2卡整行也放进画布 → 再解析无缺漏
		const [nt, ni, nv] = b.nodes;
		const nodes2 = { ...nodes, [nt.id]: nt, [ni.id]: ni, [nv.id]: nv };
		const edges2 = { ...edges, ...Object.fromEntries(b.edges.map((e) => [e.id, e])) };
		const b2 = buildRespawn(inferParent, cardSpec, RESULT, nodes2, edges2);
		expect(b2.nodes.length).toBe(0);
		expect(b2.parsed).toBe(2);
	});

	it("资产二次解析：按资产名匹配，只补缺失项", () => {
		// 画布上已有 张起天；其余 3 个资产缺失
		const c1 = mkChild("c1", "image.gen", { assetName: "张起天", prompt: "已有提示词" }, 500, 100);
		const nodes = { "n-parent": parent, c1 } as Record<string, CanvasNode>;
		const edges = { e1: mkE("e1", "n-parent", "c1") };
		const b = buildRespawn(parent, spawnSpec, FULL_JSON, nodes, edges);
		expect(b.parsed).toBe(4);
		expect(b.added).toBe(3);
		expect(b.nodes.every((n) => n.type === "image.gen")).toBe(true);
		expect(b.nodes.some((n) => n.data.params.assetName === "张起天")).toBe(false);
	});

	it("解析不出内容 → parsed=0（调用方据此提示失败）", () => {
		const b = buildRespawn(inferParent, cardSpec, "一段无关文本", {}, {});
		expect(b.parsed).toBe(0);
		expect(b.nodes.length).toBe(0);
	});
});
