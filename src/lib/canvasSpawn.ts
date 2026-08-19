/**
 * canvasSpawn —— 节点「裂变」：把结构化结果转成一批子节点 + 连线。
 *
 * 资产拆分 → 多个「生成图片」节点（每资产一节点，填好出图提示词）；
 * 剧集分集 → 多个「智能拆分」节点（每集一节点，填好本集原文，可直接拆分镜）；
 * 智能拆分 → 多个「文本」节点（每个分镜一节点，填好分镜原文）。
 * 子节点一律**自动连线**（父输出 → 子输入）、**填好提示词/内容**，但**不自动运行**。
 */

import type { CanvasNode, CanvasEdge } from "@/types";
import { genId } from "@/lib/id";
import { makeNode, NODE_W, NODE_H } from "@/canvas/nodeFactory";
import { getNodeSpec, type SpawnSpec } from "@/nodes/nodeSpecs";
import { parseAssetsForSpawn, extractEpisodes, type SpawnAssetCat } from "@/lib/assetExtraction";
import { parseShotSegments } from "@/lib/storyboardParse";
import { parseInferCards, parseInferCardsStream, SMART_INFER_MULTI_TPL, SMART_INFER_UNIFIED_SINGLE_TPL } from "@/lib/smartInferPrompts";

const GAP_X = 90;
const GAP_Y = 48;
const ROWS_PER_COL = 6;

/** 节点的文本输出端口名 / 文本输入端口名（单 in/out 模型下即 out/in） */
const outPortOf = (type: string) => getNodeSpec(type)?.outputs[0]?.name ?? "out";
const inPortOf = (type: string) => {
	const s = getNodeSpec(type);
	return s?.inputs.find((p) => p.formats.includes("text"))?.name ?? s?.inputs[0]?.name ?? "in";
};
const mkEdge = (a: CanvasNode, b: CanvasNode): CanvasEdge => ({
	id: genId("edge"),
	kind: "dataflow",
	source: a.id,
	sourcePort: outPortOf(a.type),
	target: b.id,
	targetPort: inPortOf(b.type),
});

/** 子节点的填充内容 */
interface SpawnItem {
	childType: string;
	/** 写入子节点 params.prompt（图片节点=出图提示词；文本节点=内容） */
	prompt: string;
	/** 仅文本节点：同时写入 resultText 以「结果即显示」 */
	asText?: boolean;
	/** 额外节点参数（资产图片节点：purpose/idPrefix/assetName，与资产模式同路由同编号） */
	extraParams?: Record<string, unknown>;
	/** 本项的注册键（编号/名称，供变体回查主体节点） */
	regKeys?: string[];
	/** 变体项：主体的注册键——命中已裂变的主体节点则加「主体→变体」连线（垫图参考） */
	baseKeys?: string[];
}

/** 资产的注册键：编号（大写归一）+ 名称 */
function assetKeys(code?: string, name?: string): string[] {
	const keys: string[] = [];
	const c = String(code ?? "").trim().toUpperCase();
	const n = String(name ?? "").trim();
	if (c) keys.push(`code:${c}`);
	if (n) keys.push(`name:${n}`);
	return keys;
}

/**
 * 资产大类 → 出图 purpose + 资产编号前缀。**与资产模式五页完全一致**
 * （AssetWorkbench 的 imagePurpose × CAT_PREFIX）：群像与角色同用 character 出图用途，前缀 G。
 */
const CAT_GEN: Record<SpawnAssetCat, { purpose: string; idPrefix: string }> = {
	characters: { purpose: "asset.character.image", idPrefix: "C" },
	crowds: { purpose: "asset.character.image", idPrefix: "G" },
	scenes: { purpose: "asset.scene.image", idPrefix: "S" },
	organisms: { purpose: "asset.creature.image", idPrefix: "M" },
	items: { purpose: "asset.prop.image", idPrefix: "P" },
};

/** 资产裂变节点的附加参数（purpose 决定管理端路由；idPrefix/assetName 决定资产编号与命名，与资产模式一致） */
function assetGenParams(a: { cat: SpawnAssetCat; name: string; code?: string }): Record<string, unknown> {
	const gen = CAT_GEN[a.cat] ?? CAT_GEN.characters;
	// assetCode：项目内人读编号（C01/C01A），供 二次解析/变体连主体 按编号回查节点
	return { purpose: gen.purpose, idPrefix: gen.idPrefix, assetName: a.name, ...(a.code ? { assetCode: a.code } : {}) };
}

/**
 * 资产提示词装饰钩子（第174轮拆分前后缀预设化）：画布拆分裂变的资产图片节点与资产模式同尺
 * 挂 画风前缀/类别前后缀 预设胶囊。由 pluginRegistry 注入 attachSplitPresets——本模块保持纯函数
 * 可测（缺省恒等，单测不受 store 影响）。
 */
let assetPromptDecorator: (cat: SpawnAssetCat, prompt: string) => string = (_cat, p) => p;
export function setAssetPromptDecorator(fn: (cat: SpawnAssetCat, prompt: string) => string): void {
	assetPromptDecorator = fn;
}
function decoratedPrompt(a: { cat: SpawnAssetCat; prompt: string }): string {
	try { return assetPromptDecorator(a.cat, a.prompt); } catch { return a.prompt; }
}

/** 卡时长 → 视频节点 duration 参数：按 video.gen spec 的时长范围收敛（越界取边界、取整）；无效返回 undefined */
function nodeDurationFromCard(d?: number): number | undefined {
	if (!d || d <= 0) return undefined;
	const f = getNodeSpec("video.gen")?.params?.find((p) => p.key === "duration");
	const min = typeof f?.min === "number" ? f.min : 4;
	const max = typeof f?.max === "number" ? f.max : 15;
	return Math.min(max, Math.max(min, Math.round(d)));
}

/**
 * 卡的媒体段「分镜n故事板(生成图片) → 分镜n视频(生成视频)」，接在 anchor 之后
 * （anchor=本行原文节点；分镜原文节点自跑时 anchor=原文节点自身）。
 */
function buildCardMedia(
	parent: CanvasNode,
	anchor: CanvasNode,
	card: InferCardLike,
	n: number,
	xImg: number,
	y: number,
): SpawnBuilt {
	const nodes: CanvasNode[] = [];
	const edges: CanvasEdge[] = [];
	// 图视同源：同源提示词独立成节点承载（分镜n同源提示词，text.seed），图片与视频**并联**接在它之后
	// 且**不内置提示词**（运行时自动取上游同源节点文本，见 pluginRegistry inputText 回退）——
	// 改同源节点一处 = 图片与视频提示词同时变。链路 原文→同源提示词→图片/视频。
	if (card.unifiedPrompt) {
		const uni = makeNode("text.seed", xImg, y);
		uni.parentScriptId = parent.id;
		uni.data.title = `分镜${n}同源提示词`;
		// 只写 params.prompt、**不写 resultText**：显示与下游取文都回退 prompt——用户在面板改提示词即全链生效
		//（若写了 resultText，下游 collectUpstreamText 会优先读它，编辑后仍拿旧值）。
		uni.data.params.prompt = card.unifiedPrompt;
		nodes.push(uni);
		edges.push(mkEdge(anchor, uni));
		const img = makeNode("image.gen", xImg + (NODE_W + GAP_X), y);
		img.parentScriptId = parent.id;
		img.data.title = `分镜${n}图片`;
		img.data.params.prompt = ""; // 不内置提示词：用上游同源节点文本
		nodes.push(img);
		edges.push(mkEdge(uni, img));
		const vid = makeNode("video.gen", xImg + (NODE_W + GAP_X) * 2, y);
		vid.parentScriptId = parent.id;
		vid.data.title = `分镜${n}视频`;
		vid.data.params.prompt = ""; // 不内置提示词：用上游同源节点文本
		const dur = nodeDurationFromCard(card.duration);
		if (dur !== undefined) vid.data.params.duration = dur;
		nodes.push(vid);
		edges.push(mkEdge(uni, vid)); // 视频也接同源节点（与图片并联），不接图片
		return { nodes, edges };
	}
	// 双结果（现状）：原文→故事板(图)→视频 串联
	let prev = anchor;
	if (card.storyboardPrompt) {
		const img = makeNode("image.gen", xImg, y);
		img.parentScriptId = parent.id;
		img.data.title = `分镜${n}故事板`;
		img.data.params.prompt = card.storyboardPrompt;
		nodes.push(img);
		edges.push(mkEdge(prev, img));
		prev = img;
	}
	if (card.videoPrompt) {
		const vid = makeNode("video.gen", xImg + (NODE_W + GAP_X), y);
		vid.parentScriptId = parent.id;
		vid.data.title = `分镜${n}视频`;
		vid.data.params.prompt = card.videoPrompt;
		// 卡带指定时长 → 直接设为节点时长参数（画布侧的"单镜头时长"）
		const dur = nodeDurationFromCard(card.duration);
		if (dur !== undefined) vid.data.params.duration = dur;
		nodes.push(vid);
		edges.push(mkEdge(prev, vid));
	}
	return { nodes, edges };
}

/** 分镜原文节点的标题正则（分镜n原文——智能推理裂变行首节点） */
// 分镜n原文 / 分镜n-n原文（拆分子号）——两者都是原文节点，均支持自跑重推理
export const SHOT_SCRIPT_TITLE_RE = /^分镜([\d-]+)原文$/;

/**
 * 一卡 → 一条流水线行「分镜n原文(智能推理) → 分镜n故事板(生成图片) → 分镜n视频(生成视频)」。
 * n=卡序号（1 起），写入 data.title 作为节点标题；buildSpawn/IncrementalSpawner/buildRespawn 三路共用。
 * 原文节点=**智能推理节点**（不是纯文本）：原文既是展示内容也是推理输入——用户可直接在该节点
 * 重跑本镜推理（模板走 spec 默认「单分镜」，与手动新建的智能推理节点一致）。
 */
function buildCardRow(parent: CanvasNode, card: InferCardLike, n: number, baseX: number, y: number): SpawnBuilt {
	const nodes: CanvasNode[] = [];
	const edges: CanvasEdge[] = [];
	const textNode = makeNode("smart.infer", baseX, y);
	textNode.parentScriptId = parent.id;
	textNode.data.title = `分镜${n}原文`;
	textNode.data.params.prompt = card.script;
	textNode.data.resultText = card.script;
	// 图视同源卡：原文节点带同源·单卡模板，自跑重推理仍产同源提示词（图片+视频并联）
	if (card.unifiedPrompt) textNode.data.params.templateId = SMART_INFER_UNIFIED_SINGLE_TPL;
	nodes.push(textNode);
	edges.push(mkEdge(parent, textNode));
	const media = buildCardMedia(parent, textNode, card, n, baseX + (NODE_W + GAP_X), y);
	nodes.push(...media.nodes);
	edges.push(...media.edges);
	return { nodes, edges };
}

/**
 * 原文节点「拆分」：把一段原文的多段文本各建一个新「分镜{shotId}-{子号}原文」节点（智能推理节点），
 * 全部接在 parent 之后（parent 输出 → 新节点输入），纵向堆在 parent 右侧。
 * shotId=父节点分镜标识（如「1」；父是「分镜1原文」时子节点为「分镜1-1原文」——拆分进去的用子序号命名）。
 * startSub=起始子序号（调用方按画布现有「分镜{shotId}-N原文」最大子号 + 1 传入，重复拆同一节点不撞车）。
 * 新节点与裂变原文节点同构（title 匹配 SHOT_SCRIPT_TITLE_RE + 上游为智能推理节点）→ 支持自跑重推理。
 */
export function buildScriptSplitRows(
	parent: CanvasNode,
	segments: string[],
	shotId: string,
	startSub: number,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
	const nodes: CanvasNode[] = [];
	const edges: CanvasEdge[] = [];
	const baseX = parent.x + (parent.w || NODE_W) + GAP_X;
	segments.forEach((seg, i) => {
		const y = parent.y + i * (NODE_H + GAP_Y);
		const node = makeNode("smart.infer", baseX, y);
		node.parentScriptId = parent.id;
		node.data.title = `分镜${shotId}-${startSub + i}原文`;
		node.data.params.prompt = seg;
		node.data.resultText = seg;
		nodes.push(node);
		edges.push(mkEdge(parent, node));
	});
	return { nodes, edges };
}

/** 把资产解析结果整理成可读的「格式化文本」（用于结果文本节点） */
function formatAssets(resultText: string): string {
	const assets = parseAssetsForSpawn(resultText);
	if (!assets.length) return resultText;
	return assets.map((a) => `【${[a.code, a.name].filter(Boolean).join(" ")}】\n${a.prompt}`).join("\n\n");
}

export interface BuildSpawnOpts {
	/** 结构化裂变（资产→图片 / 分集·分镜→文本） */
	spawn?: SpawnSpec;
	/** 额外落一个携带完整文本结果的下游「文本」节点 */
	emitResultText?: boolean;
}

/** 解析结构化结果，构造子节点 + 连线（不入 store，由调用方经 spawnNodes 命令批量提交） */
export function buildSpawn(
	parent: CanvasNode,
	opts: BuildSpawnOpts,
	resultText: string,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
	// 智能推理：每卡裂变一条横向流水线 文本(原剧本) → 生成图片(故事板提示词) → 生成视频(视频提示词)
	if (opts.spawn?.source === "cards") {
		const cards = parseInferCards(resultText);
		if (!cards.length) return { nodes: [], edges: [] };
		const baseX = parent.x + (parent.w || NODE_W) + GAP_X;
		const nodes: CanvasNode[] = [];
		const edges: CanvasEdge[] = [];
		cards.forEach((card, i) => {
			const y = parent.y + i * (NODE_H + GAP_Y);
			const built = buildCardRow(parent, card, i + 1, baseX, y);
			nodes.push(...built.nodes);
			edges.push(...built.edges);
		});
		return { nodes, edges };
	}

	const items: SpawnItem[] = [];

	// 结果文本节点（首位）：图片/无文本裂变的节点用它承载「格式化文本」输出
	if (opts.emitResultText) {
		const content = opts.spawn?.source === "assets" ? formatAssets(resultText) : resultText;
		if (content.trim()) items.push({ childType: "text.seed", prompt: content, asText: true });
	}

	const spawn = opts.spawn;
	if (spawn?.source === "assets") {
		for (const a of parseAssetsForSpawn(resultText)) {
			items.push({
				childType: spawn.childType,
				prompt: decoratedPrompt(a),
				extraParams: assetGenParams(a),
				regKeys: assetKeys(a.code, a.name),
				baseKeys: a.baseCode || a.baseName ? assetKeys(a.baseCode, a.baseName) : undefined,
			});
		}
	} else if (spawn?.source === "episodes") {
		// 剧集分集裂变的每集节点承载**整集**原文 → 智能推理子节点显式带多分镜模板（手动新建的默认单分镜）
		const epExtra = spawn.childType === "smart.infer" ? { templateId: SMART_INFER_MULTI_TPL } : undefined;
		for (const e of extractEpisodes(resultText)) items.push({ childType: spawn.childType, prompt: e.content, asText: true, extraParams: epExtra });
	} else if (spawn?.source === "shots") {
		for (const s of parseShotSegments(resultText)) items.push({ childType: spawn.childType, prompt: s.content, asText: true });
	}
	if (!items.length) return { nodes: [], edges: [] };

	const parentSpec = getNodeSpec(parent.type);
	const parentOut = parentSpec?.outputs[0]?.name ?? "text";
	const baseX = parent.x + (parent.w || NODE_W) + GAP_X;
	const nodes: CanvasNode[] = [];
	const edges: CanvasEdge[] = [];

	const assetReg = new Map<string, CanvasNode>(); // 编号/名称 → 已裂变主体节点（变体连线回查）
	items.forEach((item, i) => {
		const col = Math.floor(i / ROWS_PER_COL);
		const row = i % ROWS_PER_COL;
		const x = baseX + col * (NODE_W + GAP_X);
		const y = parent.y + row * (NODE_H + GAP_Y);
		const child = makeNode(item.childType, x, y);
		child.parentScriptId = parent.id;
		child.data.params.prompt = item.prompt;
		if (item.extraParams) Object.assign(child.data.params, item.extraParams);
		if (item.asText) child.data.resultText = item.prompt;
		nodes.push(child);
		// 子节点输入端口（优先 text 格式端口）
		const childSpec = getNodeSpec(item.childType);
		const childIn =
			childSpec?.inputs.find((p) => p.formats.includes("text"))?.name ?? childSpec?.inputs[0]?.name;
		if (childIn) {
			edges.push({
				id: genId("edge"),
				kind: "dataflow",
				source: parent.id,
				sourcePort: parentOut,
				target: child.id,
				targetPort: childIn,
			});
		}
		// 变体 → 直接连上主体（主体图即垫图参考；整理时该边按同级变体处理、不改分层）
		for (const k of item.regKeys ?? []) if (!assetReg.has(k)) assetReg.set(k, child);
		const baseNode = item.baseKeys?.map((k) => assetReg.get(k)).find((n): n is CanvasNode => !!n && n !== child);
		if (baseNode) edges.push(mkEdge(baseNode, child));
	});

	return { nodes, edges };
}

// ═══════════════════════════════════════════════════════════════
// 流式增量裂变（第84轮）
// ═══════════════════════════════════════════════════════════════

export interface SpawnBuilt {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
}

const EMPTY_BUILT: SpawnBuilt = { nodes: [], edges: [] };

/** 增量解析出的一个可裂变项 */
interface IncItem {
	/** 跨快照稳定的去重键（资产编号 / 卡号） */
	key: string;
	/** 内容签名：两次「文本有增长」的快照间签名不变 = 该项已在流中闭合 */
	sig: string;
	/**
	 * 尾项守卫：流式尾卡的后续字段可能还没开始输出（含「键已出、值未出」的空窗——
	 * 此时签名不变但卡并不完整），置 true 则本快照绝不裂变，等出现下一卡或 final。
	 * 卡片字段有顺序（原文在前、提示词在后），只靠签名稳定会把"只有原文"的尾卡误判闭合，
	 * 且 key 进去重集后 final 补齐也救不回（图片/视频节点从此缺失）。
	 */
	pending?: boolean;
	asset?: { prompt: string; extraParams: Record<string, unknown>; regKeys?: string[]; baseKeys?: string[] };
	card?: InferCardLike;
}

interface InferCardLike {
	script: string;
	storyboardPrompt: string;
	videoPrompt: string;
	/** 图视同源提示词（图片与视频共用一段；有值即走同源并联链路） */
	unifiedPrompt?: string;
	/** 卡指定时长（秒），写入裂变视频节点的 duration 参数 */
	duration?: number;
}

/**
 * IncrementalSpawner —— 文本流式期间**边出边裂变**。
 *
 * 旧逻辑是任务 success 后一次性解析全文、批量裂变：跑几分钟一个子节点都看不到，
 * 解析不出时还静默跳过（看起来像"资产节点被屏蔽了"）。改为每次 partialText 刷新
 * 都增量解析：资产拆分每出完一个资产提示词就立刻生成一个「生成图片」节点；
 * 智能推理每出完一卡就立刻生成「文本→生成图片→生成视频」流水线。
 *
 * 「已完整」判定（不依赖 JSON 结构）：流式文本只在尾部追加——若两次**文本有增长**
 * 的快照之间某项的内容签名完全没变，说明它早已闭合；仍在输出中的项每次快照都在
 * 变长，不会误判。文本无增长的快照直接跳过（模型停顿不推进判定）。final=true
 * （任务成功，拿到完整全文）时把剩余未裂变的全部补齐。
 *
 * ⚠ 尾卡例外（pending）：卡片字段有顺序（原文在前、提示词在后），尾卡在「原文已闭合、
 * 提示词键已出但值未出」的空窗里签名恰好不变——只靠稳定性会把只有原文的尾卡误判闭合，
 * 只裂变出文本节点且 key 进去重集后 final 也救不回。故尾卡一律等 出现下一卡 或 final。
 * 资产项天然免疫（imagePrompt 是最后字段且是成项前提，没有这个空窗）。
 */
export class IncrementalSpawner {
	private spawnedKeys = new Set<string>();
	private lastSig = new Map<string, string>();
	private lastLen = 0;
	private lastText = "";
	/** 已裂变项计数（网格/流水线定位连续递增） */
	private index = 0;
	/** 编号/名称 → 已裂变资产节点（跨 feed 批次持久，变体连主体回查） */
	private assetReg = new Map<string, CanvasNode>();

	constructor(
		private readonly parent: CanvasNode,
		private readonly spawn: SpawnSpec,
		/** 活体父节点访问器：裂变落点按父节点**当前**位置算（相对定位）——流式期间用户拖动了主节点，后续子节点跟着新位置出，而不是钉死在开跑时的旧坐标 */
		private readonly liveParent?: () => CanvasNode | undefined,
		/** shotScriptSelf=分镜原文节点自跑重推理：自己就是原文节点——卡片**不再建原文节点**，
		 *  只裂变 分镜n故事板/分镜n视频 接到自身（n 沿用自己标题里的分镜号） */
		private readonly opts?: { shotScriptSelf?: boolean },
	) {}

	/** 定位基准：父节点当前状态（找不到时回退构造快照） */
	private get origin(): CanvasNode {
		return this.liveParent?.() ?? this.parent;
	}

	/** 已裂变项总数（final 后为 0 说明整个输出没解析出任何资产/卡片） */
	get total(): number {
		return this.spawnedKeys.size;
	}

	/** 喂入当前累计文本；返回本次新裂变的节点/连线（由调用方派发 spawnNodes 命令） */
	feed(rawText: string, final = false): SpawnBuilt {
		const text = rawText && rawText.length >= this.lastText.length ? rawText : this.lastText || rawText;
		if (!text) return EMPTY_BUILT;
		if (!final && text.length <= this.lastLen) return EMPTY_BUILT; // 无增长：不推进稳定性判定
		this.lastLen = Math.max(this.lastLen, text.length);
		this.lastText = text;

		let items: IncItem[];
		try {
			items = this.parseItems(text, final);
		} catch {
			return EMPTY_BUILT;
		}

		const out: SpawnBuilt = { nodes: [], edges: [] };
		for (const it of items) {
			if (this.spawnedKeys.has(it.key)) continue;
			const ready = final || (!it.pending && this.lastSig.get(it.key) === it.sig);
			this.lastSig.set(it.key, it.sig);
			if (!ready) continue;
			this.spawnedKeys.add(it.key);
			this.buildItem(it, out);
		}
		return out;
	}

	private parseItems(text: string, final: boolean): IncItem[] {
		if (this.spawn.source === "assets") {
			return parseAssetsForSpawn(text)
				.filter((a) => a.prompt?.trim())
				.map((a) => ({
					key: a.code || a.name || a.prompt.slice(0, 60),
					sig: `${a.code ?? ""}${a.name ?? ""}${a.prompt}`,
					asset: {
						prompt: decoratedPrompt(a),
						extraParams: assetGenParams(a),
						regKeys: assetKeys(a.code, a.name),
						baseKeys: a.baseCode || a.baseName ? assetKeys(a.baseCode, a.baseName) : undefined,
					},
				}));
		}
		if (this.spawn.source === "cards") {
			// 流式期间用容错抽取（支持未闭合尾卡）；终态优先严格 JSON（最准）
			const cards = final ? parseInferCards(text) : parseInferCardsStream(text);
			const lastIdx = cards.length - 1;
			return cards
				.map((c, origIdx) => ({ c, origIdx }))
				.filter(({ c }) => c.script || c.storyboardPrompt || c.videoPrompt || c.unifiedPrompt)
				.map(({ c, origIdx }, i) => ({
					key: `${c.title || `卡${i + 1}`}${c.script.slice(0, 40)}`,
					sig: `${c.duration ?? ""}${c.script}${c.storyboardPrompt}${c.videoPrompt}${c.unifiedPrompt ?? ""}`,
					card: c,
					// 尾卡守卫：最后一卡的提示词字段可能仍在流式输出（含「键已出、值未出」空窗），
					// 只在 final 或出现下一卡（本卡 JSON 对象必已闭合）后才允许裂变
					pending: !final && origIdx === lastIdx,
				}));
		}
		return [];
	}

	private buildItem(it: IncItem, out: SpawnBuilt): void {
		// 相对定位：每次裂变都按父节点**当前**位置算落点（用户流式期间拖动主节点也跟随）
		const parent = this.origin;
		const baseX = parent.x + (parent.w || NODE_W) + GAP_X;
		const i = this.index++;

		if (it.asset) {
			// 与 buildSpawn assets 网格一致：每列 6 行，列向右延伸
			const col = Math.floor(i / ROWS_PER_COL);
			const row = i % ROWS_PER_COL;
			const child = makeNode(this.spawn.childType, baseX + col * (NODE_W + GAP_X), parent.y + row * (NODE_H + GAP_Y));
			child.parentScriptId = parent.id;
			child.data.params.prompt = it.asset.prompt;
			Object.assign(child.data.params, it.asset.extraParams); // purpose/idPrefix/assetName：与资产模式同路由同编号
			out.nodes.push(child);
			out.edges.push(mkEdge(parent, child));
			// 变体 → 直接连上主体（主体先于变体出现在流中，跨 feed 批次也能回查）
			for (const k of it.asset.regKeys ?? []) if (!this.assetReg.has(k)) this.assetReg.set(k, child);
			const base = it.asset.baseKeys?.map((k) => this.assetReg.get(k)).find((n): n is CanvasNode => !!n && n !== child);
			if (base) out.edges.push(mkEdge(base, child));
			return;
		}

		if (it.card) {
			if (this.opts?.shotScriptSelf) {
				// 分镜原文节点自跑：只裂变 故事板/视频 接到**自身**（不再建原文节点）；
				// 分镜号沿用自己标题（分镜n原文 → 分镜n故事板/分镜n视频）
				const m = SHOT_SCRIPT_TITLE_RE.exec(String(parent.data.title ?? ""));
				const n = m ? Number(m[1]) : i + 1;
				const built = buildCardMedia(parent, parent, it.card, n, baseX, parent.y + i * (NODE_H + GAP_Y));
				out.nodes.push(...built.nodes);
				out.edges.push(...built.edges);
				return;
			}
			// 与 buildSpawn cards 流水线一致：每卡一行「分镜n原文 → 分镜n故事板 → 分镜n视频」
			const built = buildCardRow(parent, it.card, i + 1, baseX, parent.y + i * (NODE_H + GAP_Y));
			out.nodes.push(...built.nodes);
			out.edges.push(...built.edges);
		}
	}
}

// ═══════════════════════════════════════════════════════════════
// 二次解析（对已有结果重新解析，只补缺漏——不重跑模型、不重复已有节点）
// ═══════════════════════════════════════════════════════════════

export interface RespawnBuilt extends SpawnBuilt {
	/** 解析出的总项数（0 = 结果解析不出内容） */
	parsed: number;
	/** 整行/整项新增数 */
	added: number;
	/** 已有行补齐缺漏节点（图/视频）的行数 */
	patched: number;
}

const normForMatch = (s: unknown) => String(s ?? "").replace(/\s+/g, "");

/**
 * 已裂变子节点 ⇄ 解析项 的对应判定：归一化（剥空白）后全等，或前 60 字前缀相同
 * （流式容错抽取与终态严格 JSON 的转义还原可能有微小差异；短文本要求全等防误配）。
 */
function sameContent(a: unknown, b: unknown): boolean {
	const na = normForMatch(a), nb = normForMatch(b);
	if (!na || !nb) return false;
	if (na === nb) return true;
	return na.length >= 24 && nb.length >= 24 && na.slice(0, 60) === nb.slice(0, 60);
}

/**
 * 二次解析：对节点**已存的结果文本**重新解析，与画布上已裂变的子节点比对，
 * 只构造缺漏部分（不入 store，由调用方经 spawnNodes 命令一次提交=一次撤销）。
 * - cards（智能推理/智能拆分）：按原文匹配已有行——整行缺失补全流水线；
 *   行存在但缺 生成图片/生成视频 节点则补建并接到该行（尾卡假闭合竞态留下的残行由此救回）；
 * - assets（资产拆分）：按 资产名/提示词 匹配已有图片节点，缺失的补进网格。
 * 已有节点一律不改（用户可能已编辑提示词）。
 */
export function buildRespawn(
	parent: CanvasNode,
	spawn: SpawnSpec,
	resultText: string,
	allNodes: Record<string, CanvasNode>,
	allEdges: Record<string, CanvasEdge>,
): RespawnBuilt {
	const out: RespawnBuilt = { nodes: [], edges: [], parsed: 0, added: 0, patched: 0 };
	const children = Object.values(allEdges)
		.filter((e) => e.source === parent.id)
		.map((e) => allNodes[e.target])
		.filter((n): n is CanvasNode => !!n);
	const downstreamOf = (id: string, type: string): CanvasNode | null => {
		for (const e of Object.values(allEdges)) {
			if (e.source !== id) continue;
			const n = allNodes[e.target];
			if (n?.type === type) return n;
		}
		return null;
	};
	const baseX = parent.x + (parent.w || NODE_W) + GAP_X;

	if (spawn.source === "cards") {
		const cards = parseInferCards(resultText);
		out.parsed = cards.length;
		// 新行落点：现有子节点最下方继续往下排
		let nextY = children.length
			? Math.max(...children.map((n) => n.y)) + (NODE_H + GAP_Y)
			: parent.y;
		for (let ci = 0; ci < cards.length; ci++) {
			const card = cards[ci];
			const n = ci + 1; // 分镜序号（命名 分镜n原文/故事板/视频）
			if (!card.script && !card.storyboardPrompt && !card.videoPrompt && !card.unifiedPrompt) continue;
			// 原文行匹配：新裂变=smart.infer（分镜n原文），存量画布=text.seed（改型前），两者都认
			const row = children.find(
				(n2) =>
					(n2.type === "smart.infer" || n2.type === "text.seed") &&
					sameContent(n2.data.params.prompt ?? n2.data.resultText, card.script),
			);
			if (!row) {
				// 整行缺失 → 补一条完整流水线（与 buildSpawn cards 同构，含分镜n命名）
				const built = buildCardRow(parent, card, n, baseX, nextY);
				out.nodes.push(...built.nodes);
				out.edges.push(...built.edges);
				nextY += NODE_H + GAP_Y;
				out.added++;
				continue;
			}
			// 图视同源：行下游应为 同源提示词节点(text.seed) → 图片/视频 并联（图/视频不内置提示词）。
			// 缺同源节点则补建（带同源提示词），再对同源节点补缺 图片/视频。
			if (card.unifiedPrompt) {
				let patchedU = false;
				const stepX = (row.w || NODE_W) + GAP_X;
				let uni = downstreamOf(row.id, "text.seed");
				if (!uni) {
					uni = makeNode("text.seed", row.x + stepX, row.y);
					uni.parentScriptId = parent.id;
					uni.data.title = `分镜${n}同源提示词`;
					uni.data.params.prompt = card.unifiedPrompt; // 不写 resultText：编辑 prompt 即全链生效
					out.nodes.push(uni); out.edges.push(mkEdge(row, uni)); patchedU = true;
				}
				const uniHas = (type: string) => downstreamOf(uni!.id, type);
				if (!uniHas("image.gen")) {
					const im = makeNode("image.gen", row.x + stepX * 2, row.y);
					im.parentScriptId = parent.id;
					im.data.title = `分镜${n}图片`;
					im.data.params.prompt = ""; // 用上游同源节点文本
					out.nodes.push(im); out.edges.push(mkEdge(uni, im)); patchedU = true;
				}
				if (!uniHas("video.gen")) {
					const v = makeNode("video.gen", row.x + stepX * 3, row.y);
					v.parentScriptId = parent.id;
					v.data.title = `分镜${n}视频`;
					v.data.params.prompt = ""; // 用上游同源节点文本
					const dur = nodeDurationFromCard(card.duration);
					if (dur !== undefined) v.data.params.duration = dur;
					out.nodes.push(v); out.edges.push(mkEdge(uni, v)); patchedU = true;
				}
				if (patchedU) out.patched++;
				continue;
			}
			// 行存在 → 检查下游缺漏：缺图补图（接原文），缺视频补视频（接图，无图接原文）
			let prev: CanvasNode = row;
			let patchedThis = false;
			const img = downstreamOf(row.id, "image.gen");
			if (img) {
				prev = img;
			} else if (card.storyboardPrompt) {
				const im = makeNode("image.gen", row.x + ((row.w || NODE_W) + GAP_X), row.y);
				im.parentScriptId = parent.id;
				im.data.title = `分镜${n}故事板`;
				im.data.params.prompt = card.storyboardPrompt;
				out.nodes.push(im);
				out.edges.push(mkEdge(row, im));
				prev = im;
				patchedThis = true;
			}
			const vid = downstreamOf(prev.id, "video.gen") ?? (prev !== row ? downstreamOf(row.id, "video.gen") : null);
			if (!vid && card.videoPrompt) {
				const v = makeNode("video.gen", row.x + ((row.w || NODE_W) + GAP_X) * 2, row.y);
				v.parentScriptId = parent.id;
				v.data.title = `分镜${n}视频`;
				v.data.params.prompt = card.videoPrompt;
				const dur = nodeDurationFromCard(card.duration);
				if (dur !== undefined) v.data.params.duration = dur;
				out.nodes.push(v);
				out.edges.push(mkEdge(prev, v));
				patchedThis = true;
			}
			if (patchedThis) out.patched++;
		}
		return out;
	}

	if (spawn.source === "assets") {
		const assets = parseAssetsForSpawn(resultText).filter((a) => a.prompt?.trim());
		out.parsed = assets.length;
		// 主体回查注册表（编号/名称 → 节点）：既有子节点 + 本次新建，供补缺的变体连主体
		const reg = new Map<string, CanvasNode>();
		const regNode = (n: CanvasNode) => {
			for (const k of assetKeys(String(n.data.params.assetCode ?? ""), String(n.data.params.assetName ?? ""))) {
				if (!reg.has(k)) reg.set(k, n);
			}
		};
		for (const n of children) if (n.type === spawn.childType) regNode(n);
		// 网格续排：从已有同类子节点数量之后接着排
		let idx = children.filter((n) => n.type === spawn.childType).length;
		for (const a of assets) {
			// 二次解析防重：名称优先；提示词兜底须 裸文/挂胶囊 两种形态都认（新节点带预设胶囊、存量节点是裸文）
			const exists = children.some(
				(n) =>
					n.type === spawn.childType &&
					((a.name && String(n.data.params.assetName || "").trim() === a.name.trim()) ||
						sameContent(n.data.params.prompt, a.prompt) ||
						sameContent(n.data.params.prompt, decoratedPrompt(a))),
			);
			if (exists) continue;
			const col = Math.floor(idx / ROWS_PER_COL);
			const rowI = idx % ROWS_PER_COL;
			const child = makeNode(spawn.childType, baseX + col * (NODE_W + GAP_X), parent.y + rowI * (NODE_H + GAP_Y));
			child.parentScriptId = parent.id;
			child.data.params.prompt = decoratedPrompt(a);
			Object.assign(child.data.params, assetGenParams(a));
			out.nodes.push(child);
			out.edges.push(mkEdge(parent, child));
			// 变体 → 连上主体（主体可能是既有子节点，也可能是本次刚补建的）
			regNode(child);
			if (a.baseCode || a.baseName) {
				const base = assetKeys(a.baseCode, a.baseName).map((k) => reg.get(k)).find((n): n is CanvasNode => !!n && n !== child);
				if (base) out.edges.push(mkEdge(base, child));
			}
			idx++;
			out.added++;
		}
		return out;
	}

	return out;
}
