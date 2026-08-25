/**
 * 提示词模板存储（文件持久化）—— 数据化的 catalog 模板，正文权威留管理端。
 *
 * 仿 store/models.ts：每个模板带 purpose（用途/schema 路由）+ nodeTypes（节点类型白名单，
 * 控制"用在哪个节点"）+ body 正文 + variables。管理端可增删改 + 编辑正文 + 绑定节点。
 * 改动后 bump 版本（并入 catalog version，触发用户端热更新）。
 *
 * 链式复合（chainNextId/chainPipeVar）字段先在此落数据，编排在 dispatchGenerate 实现（增量B）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadJson, saveJson } from "./db.ts";
import { audienceChain, audienceGroupId, PLATFORM_AUDIENCE } from "./agents.ts";
import type { Capability, Purpose } from "../contract.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 读取提示词原稿作模板正文（仅 seed/刷新时用，之后正文持久化在 templates.json）。
 * 正文权威**属服务端**：原稿在 `server/skills/`（server/src/store → `../../skills`）；
 * 兼容旧布局再退到仓库根 `../../../skills`。都缺失则返回 ""（调用方给简短兜底正文）。
 */
function readSkill(relPath: string): string {
	for (const base of ["../../skills", "../../../skills"]) {
		try {
			return readFileSync(join(here, base, relPath), "utf8");
		} catch {
			/* try next */
		}
	}
	return "";
}

export interface TemplateDef {
	id: string;
	name: string;
	capability: Capability;
	/** 用途；画风等"预设类"模板可无 purpose（不可执行，仅作配置项） */
	purpose?: Purpose;
	/** 分类（按类型归档，便于查找），如 "画风"、"资产提取"、"分镜生图"、"视频生成"；空=未分类 */
	category: string;
	/** 节点类型白名单：可用于哪些画布节点（text/script/image/video/audio）；空=不限 */
	nodeTypes: string[];
	/** 正文（权威，存管理端；支持 {{变量}} 占位） */
	body: string;
	/** 参考图（data URL，已压缩），如画风参考图 */
	images: string[];
	/** 该模板需要的变量名（界面提示/校验用） */
	variables: string[];
	/** 预设方案的「互斥组」：同一非空组内的预设不能同时出现在一段提示词里（客户端插入其一即移除同组旧胶囊）。
	 *  仅对「预设方案」类模板有意义；内置 4/6/9 宫格由客户端按 id 归入「宫格」组，此处供管理端为其它预设配置。 */
	presetGroup?: string;
	/** 预设方案的默认插入位置：前缀（用户输入前）/后缀（用户输入后）；缺省=前缀。仅「预设方案」类有意义。 */
	presetPosition?: "prefix" | "suffix";
	/** 绑定的输出 schema id（结构化输出强制） */
	schemaId?: string;
	/** 链式复合：跑完本段后把输出注入下一段并再调一次（增量B 编排） */
	chainNextId?: string;
	/** 注入到下一段的变量名（默认"上一步"） */
	chainPipeVar?: string;
	/** 该 (capability + 各 nodeType) 下默认选中 */
	isDefault?: boolean;
	/** 归属渠道商 id（渠道商自营模板，仅其名下用户可见、仅其本人可管理）；空=平台模板（管理端管理） */
	agentId?: string;
	/** 平台模板的开放范围（仅平台模板即 agentId 空时有意义；第110轮起源站也是受众）：
	 *  "all"（默认/未设）=全部受众可用；"select"=仅 shareAgentIds 列出的受众；"none"=不开放给任何人。
	 *  受众 = 各渠道商 + 源站（PLATFORM_AUDIENCE="platform"，即平台直属用户）。 */
	shareScope?: "all" | "select" | "none";
	/** shareScope==="select" 时开放到的受众 id 列表（渠道商 id / "platform"=源站）
	 *  ⚠ 第176轮起为**旧清单**（存量数据仍生效）：管理端「开放范围」已改按分组勾选（shareGroupIds），
	 *  与模型侧（models.ts ModelDef.shareGroupIds）完全同构。 */
	shareAgentIds?: string[];
	/** shareScope==="select" 时开放到的**渠道商分组** id 列表（第176轮；受众的生效分组命中即开放） */
	shareGroupIds?: string[];
	enabled: boolean;
	order: number;
	createdAt: string;
	updatedAt: string;
}

interface Store {
	version: number;
	/** 内置模板种子版本：bump 后启动时刷新内置模板正文（不动用户自建模板） */
	seedVersion?: number;
	/** 定向 skills 刷新版本：bump 后仅强制刷新 SKILL_REFRESH_IDS 指定模板的正文（不动其它模板/默认项） */
	skillsRefreshVersion?: number;
	/** 重置版本：bump 后启动时把模板库一次性裁剪为 RESET_KEEP_IDS（删除其余全部模板，含用户自建） */
	resetVersion?: number;
	/** 定向删除版本：bump 后启动时仅删除 REMOVE_IDS 指定模板（不动其它，含用户自建） */
	removeVersion?: number;
	/** 受众语义迁移版本（第110轮「源站也是受众」）：一次性把存量 select/none 换算成含 platform 的等价形态 */
	audienceVersion?: number;
	/** 已被管理员删除的内置模板 id（墓碑）——重启时不再补种，使删除可持久 */
	deletedSeedIds?: string[];
	templates: TemplateDef[];
}

const FILE = "templates.json";
/** 内置模板有重大更新（如把 skills/*.md 全文录入正文）时 +1，触发**全量**内置模板一次性刷新 */
const SEED_VERSION = 2;
/**
 * 定向刷新：仅把这些模板的正文从 skills md 强制覆盖（避免 SEED_VERSION 全量刷新误伤其它模板/默认项）。
 * 当下方 id 对应的 skills md 正文有更新、需强推到已入库数据时，把 SKILL_REFRESH_VERSION +1。
 * ⚠ 2026-07-19 用户定（勿回退）：提示词正文一律在管理端「提示词模板」页维护（data/templates.json 为唯一权威），
 * skills md 已过时、不再跟进——**永远不要再 bump 本版本号或 SEED_VERSION**（会用过时 md 覆盖用户线上调好的正文）。
 * 新增内置模板走补种（只加缺失、不动存量）即可，无需任何版本号。
 */
const SKILL_REFRESH_VERSION = 4; // v4：单卡/同源单卡模板加入 {{上上一分镜}}{{上一分镜}}{{下一分镜}} 邻镜上下文
const SKILL_REFRESH_IDS = ["smart.infer.multi", "smart.infer.single", "asset.extract.basic", "smart.infer.unified", "smart.infer.unified.single"];
/**
 * 一次性重置：bump RESET_VERSION 后，启动时把模板库**裁剪为下列 id**（删除其余全部，含用户自建/旧内置）。
 * 用于"重置提示词库、只保留指定模板"。裁剪后管理员仍可正常新增（gate 已置位，不会再裁剪）。
 */
const RESET_VERSION = 1;
/**
 * 一次性定向删除：bump REMOVE_VERSION 后，启动时仅删除下列内置模板（记墓碑防补种回来），
 * 不影响其它模板/用户自建（区别于 RESET 的"裁剪为保留集"）。追加要删的内置模板到此并 bump。
 */
const REMOVE_VERSION = 1;
const REMOVE_IDS = ["asset.prompt.optimize"]; // 取消资产界面「提示词优化」→ 删除其服务端模板
const RESET_KEEP_IDS = new Set([
	"asset.extract.basic",   // 资产提取（剧本2资产）
	"smart.infer.multi",     // 智能推理·多分镜
	"smart.infer.single",    // 智能推理·单分镜
	"smart.infer.unified",        // 图视同源·多分镜
	"smart.infer.unified.single", // 图视同源·单分镜
	"script.episodes.basic", // 剧本自动分集（内部，用户保留）
	// 画风/宫格预设已迁独立预设库（第174轮 presets.ts）——RESET 早已消费（v1），此清单仅存档语义
]);
/** 刷新内置模板时覆盖的"定义性"字段（保留 enabled / createdAt） */
const REFRESH_FIELDS: (keyof TemplateDef)[] = [
	"name", "capability", "purpose", "category", "nodeTypes", "body", "variables", "schemaId", "isDefault", "order",
];

function tpl(
	partial: Pick<TemplateDef, "id" | "name" | "capability" | "body"> & Partial<TemplateDef>,
): TemplateDef {
	const now = new Date().toISOString();
	return {
		purpose: undefined,
		category: "",
		nodeTypes: [],
		variables: [],
		images: [],
		schemaId: undefined,
		chainNextId: undefined,
		chainPipeVar: undefined,
		isDefault: false,
		enabled: true,
		order: 0,
		createdAt: now,
		updatedAt: now,
		...partial,
	};
}

const DEFAULT_TEMPLATES: TemplateDef[] = [
	tpl({
		id: "asset.extract.basic",
		name: "资产提取（基础）",
		capability: "text",
		purpose: "script.analyze",
		category: "资产提取",
		nodeTypes: ["text"],
		variables: ["视觉风格", "原文", "角色列表", "场景列表", "物品列表", "生物列表", "当前时间"],
		schemaId: "asset.extract.v1",
		isDefault: true,
		order: 1,
		// 正文权威来源：skills/小说2资产/资产拆分.md（占位符已含 {{视觉风格}}{{角色列表}}…{{原文}}）
		body: readSkill("小说2资产/资产拆分.md") || [
			"你是漫剧资产拆分专家。视觉风格：{{视觉风格}}。提取角色/场景/生物/道具及视觉圣经、分集，只取核心高频资产。",
			"已设计：角色 {{角色列表}}；场景 {{场景列表}}；道具 {{物品列表}}；生物 {{生物列表}}。当前时间：{{当前时间}}。",
			"原文：\n{{原文}}",
		].join("\n"),
	}),
	// 智能推理·多分镜——一次推理同时产出每卡的 原剧本 + 宫格故事板提示词 + 影视级视频提示词。
	// 客户端「智能推理」(多分镜)按 templateId 调用；输出纯 JSON 数组 cards，客户端 parseInferCards 解析。
	// 非默认(isDefault:false)，避免与 storyboard.toVideoPrompt 的默认模板冲突；正文权威留 skills/分镜2视频/智能推理-多分镜.md。
	tpl({
		id: "smart.infer.multi",
		name: "智能推理·多分镜",
		capability: "text",
		purpose: "storyboard.toVideoPrompt",
		category: "智能推理",
		nodeTypes: ["text", "script"],
		variables: ["原文"],
		isDefault: false,
		order: 6,
		body: readSkill("分镜2视频/智能推理-多分镜.md") ||
			"你是 AI 漫剧超创导演。把整集剧本拆成约 10-13 张 15 秒大卡，为每一卡同时产出 原剧本/宫格故事板提示词/影视级视频提示词。直接输出干净 JSON 数组，每个对象含 card_number、original_script、storyboard_prompts、video_prompts 四个字段。\n\n【本集剧本原文】\n{{原文}}",
	}),
	// 智能推理·单分镜——只为单个分镜补出故事板提示词 + 视频提示词（输出 1 卡）。
	// 第108轮：单卡独立为专属用途 storyboard.singleShot（与多卡 storyboard.toVideoPrompt 分开，
	// 画布按上游类型决定节点可用哪些用途的模板；输出仍共用同一套卡解析）。
	tpl({
		id: "smart.infer.single",
		name: "智能推理·单分镜",
		capability: "text",
		purpose: "storyboard.singleShot",
		category: "智能推理",
		nodeTypes: ["text", "script"],
		variables: ["原文", "上上一分镜", "上一分镜", "下一分镜"],
		isDefault: false,
		order: 7,
		body: readSkill("分镜2视频/智能推理-单分镜.md") ||
			"你是 AI 漫剧超创导演。只为下方这一个分镜产出 故事板提示词 + 视频提示词（不再拆多卡），original_script 原样保留。直接输出只含 1 个对象的干净 JSON 数组，含 card_number、original_script、storyboard_prompts、video_prompts 四个字段。\n\n【本分镜剧本原文】\n{{原文}}",
	}),
	// 图视同源·多分镜——每卡产出**一段**同源提示词（unified_prompt，图片与视频共用），
	// 不再分故事板/视频两段。客户端「图视同源」多卡按 templateId 调用；输出 cards，parseInferCards 解析。
	tpl({
		id: "smart.infer.unified",
		name: "图视同源·多分镜",
		capability: "text",
		purpose: "storyboard.unified",
		category: "智能推理",
		nodeTypes: ["text", "script"],
		variables: ["原文"],
		isDefault: false,
		order: 8,
		body: readSkill("分镜2视频/图视同源-多分镜.md") ||
			"你是 AI 漫剧超创导演（图视同源模式）。把整集剧本拆成约 10-13 张 15 秒大卡，为每一卡产出**一段同源提示词**（图片与视频共用，既含首帧宫格构图又含15秒视听时间轴）。直接输出干净 JSON 数组，每个对象含 card_number、duration、original_script、unified_prompt 四个字段。\n\n【本集剧本原文】\n{{原文}}",
	}),
	// 图视同源·单分镜——单卡产出一段同源提示词（unified_prompt，图片与视频共用）。
	tpl({
		id: "smart.infer.unified.single",
		name: "图视同源·单分镜",
		capability: "text",
		purpose: "storyboard.unifiedShot",
		category: "智能推理",
		nodeTypes: ["text", "script"],
		variables: ["原文", "上上一分镜", "上一分镜", "下一分镜"],
		isDefault: false,
		order: 9,
		body: readSkill("分镜2视频/图视同源-单分镜.md") ||
			"你是 AI 漫剧超创导演（图视同源·单分镜）。只为下方这一个分镜产出**一段同源提示词**（图片与视频共用，既含首帧宫格构图又含15秒视听时间轴），original_script 原样保留。直接输出只含 1 个对象的干净 JSON 数组，含 card_number、duration、original_script、unified_prompt 四个字段。\n\n【本分镜剧本原文】\n{{原文}}",
	}),
	// ── 内部模板（不进选择器；调用时显式传 templateId；用户已保留 提示词优化 / 自动分集）──
	tpl({
		id: "script.episodes.basic",
		name: "剧本自动分集（内部）",
		capability: "text",
		purpose: "script.analyze",
		category: "内部",
		nodeTypes: ["text"],
		variables: ["原文"],
		order: 10,
		// 边界法：只输出每集 标题 + 起始锚点句（输出短、不截断），客户端按锚点在原文确定性切分
		body: [
			"阅读下面的剧本，按剧情节奏把它划分成若干集（剧集）。",
			"",
			'严格只输出一个 JSON 数组，每个元素为 {"title":"剧集标题","anchor":"该集开头在原文中的第一句原文"}。',
			"要求：",
			"- anchor 必须从原文逐字照抄一小段（约10~30字），保证能在原文中被精确检索到；不要改写、不要加引号外的内容。",
			"- 只输出边界，不要输出剧本正文、不要分镜、不要任何解释或额外文字。",
			"- 第一集的 anchor 取剧本正文真正开始的那一句。",
			"",
			"剧本：",
			"{{原文}}",
		].join("\n"),
	}),
	// ── 转视角（第193轮）：提示词**只留服务端**（用户要求客户端不可见）——客户端仅传机位参数
	// （params.viewAngle），buildPrompt 按 purpose 分支经 translators/viewAnglePrompt.ts 渲染：
	// 机位/俯仰/景别/平移/镜头短语为参数化文本在代码里，主骨架与未见区域条款在下面模板里可管理端调优。
	tpl({
		id: "viewangle.main",
		name: "转视角·主模板",
		capability: "image",
		purpose: "image.viewangle",
		category: "转视角",
		nodeTypes: ["image"],
		variables: ["机位描述", "未见区域", "补充要求"],
		isDefault: true,
		order: 20,
		body:
			"把 @Image1 的场景改为新的相机机位重新拍摄同一画面：{{机位描述}}。" +
			"画面内容必须还是原图中的同一场景：原图里已有的一切（场景、物体，如有人物也包括人物）" +
			"保持形态、材质、光照氛围与相互空间位置关系完全一致，不添加、不删除、不改变任何内容，" +
			"只改变相机的位置、朝向与构图，输出与原图同一画风的连贯画面。{{未见区域}}{{补充要求}}",
	}),
	tpl({
		id: "viewangle.backfill.far",
		name: "转视角·未见区域条款（大角度≥135°）",
		capability: "image",
		purpose: "image.viewangle",
		category: "转视角",
		nodeTypes: ["image"],
		order: 21,
		// ⚠ 纯镜头语言勿回退（第192轮教训）：不提「背面/人物/发型/服装」——无人场景会被诱导凭空造人
		body:
			"注意：新机位下画面的大部分区域在原图中被遮挡或没有拍到（各物体的背侧、场景的另一面）——" +
			"请根据原图中各物体的形状、材质、结构与空间布局，推理并连贯地生成这些未见区域；" +
			"构图必须符合新机位（前后关系相应反转），不要沿用原图的正面构图；" +
			"画面里只能出现原图中已有的物体，绝不要凭空添加原图中不存在的物体或人物。",
	}),
	tpl({
		id: "viewangle.backfill.mid",
		name: "转视角·未见区域条款（侧后 90–135°）",
		capability: "image",
		purpose: "image.viewangle",
		category: "转视角",
		nodeTypes: ["image"],
		order: 22,
		body:
			"注意：新机位包含部分原图未拍到的侧后区域，请按原图各物体的结构与空间布局合理补全，" +
			"与可见部分自然衔接；绝不要凭空添加原图中不存在的物体或人物。",
	}),
	// ── 720°全景（第194轮）：前置提示词只留服务端（与转视角同规），管理端分类「转全景」可调优
	tpl({
		id: "panorama.main",
		name: "720°全景·前置提示词",
		capability: "image",
		purpose: "image.panorama",
		category: "转全景",
		nodeTypes: ["image"],
		variables: ["补充要求"],
		isDefault: true,
		order: 25,
		body:
			"把 @Image1 的场景扩展为完整的 720° 全景：输出一张 equirectangular（等距圆柱投影）全景图，" +
			"宽高比严格为 2:1，覆盖水平 360°、垂直 180° 的完整视野。以原图内容为正前方（画面水平中央）的视角基准，" +
			"向左右两侧与正后方合理延伸出同一场景的其余部分；画面最左边缘与最右边缘必须无缝衔接（可首尾相连），" +
			"顶部为天空/顶面、底部为地面，天顶与地底区域按等距圆柱投影自然拉伸变形。" +
			"全图画风、光照方向、色调、材质与原图完全一致，场景连贯真实；" +
			"不要出现相机、拍摄者、水印、文字或画面分割线。{{补充要求}}",
	}),
	// ── 简一助手·上下文总结（第201轮）：会话达 8 万字封锁后仅剩两个动作，正文只留服务端（带 purpose
	// 的可执行模板 catalog 不下发正文/预览），管理端「提示词模板」分类「简一助手」可调优。
	// ⚠ 用户定稿：完整对话转录原样填入 {{对话内容}}，零采样零截断（勿加任何「智能压缩」）。
	tpl({
		id: "jianyi.summary",
		name: "简一助手·总结本次对话",
		capability: "text",
		purpose: "chat.summarize",
		category: "简一助手",
		nodeTypes: ["text"],
		variables: ["对话内容"],
		isDefault: true,
		order: 30,
		body: [
			"你是「简一助手」的对话总结员。下面是一段用户与助手的完整对话记录。",
			"请用简洁、条理清晰的中文对本次对话做一份总结性归纳，供用户回顾留档：",
			"1. 对话主题与目标；",
			"2. 讨论过的要点与结论（分条列出）；",
			"3. 已确定的结果或产出（如设定、文案、方案等，保留关键原文）；",
			"4. 未解决的问题或待办事项。",
			"只输出总结正文，不要输出任何额外说明或客套话。",
			"",
			"【对话记录】",
			"{{对话内容}}",
		].join("\n"),
	}),
	tpl({
		id: "jianyi.handoff",
		name: "简一助手·总结至新窗口继续",
		capability: "text",
		purpose: "chat.summarize",
		category: "简一助手",
		nodeTypes: ["text"],
		variables: ["对话内容"],
		order: 31,
		body: [
			"你是「简一助手」的上下文交接员。下面是一段用户与助手的完整对话记录。",
			"用户即将新开一个对话窗口继续这项工作。请生成一段**提示性语言**（交接提示词），用户会把它原样发给新窗口的助手，使其能够无缝接续：",
			"- 先说明背景：我们在做什么、关键设定与已确定的结论；",
			"- 保留必须延续的具体信息（人物/作品名称、编号、风格约定、输出格式要求等，逐条列出）；",
			"- 结尾明确说明接下来要继续做的事情，让新窗口助手可以直接开始。",
			"只输出这段交接提示词本身，不要输出任何额外说明。",
			"",
			"【对话记录】",
			"{{对话内容}}",
		].join("\n"),
	}),
	// ── AI 工具箱（第245轮）：大厅「工具」入口的两个独立小工具。带 purpose 的可执行模板——
	// catalog 不下发正文/预览（第200轮统一规则）；管理端「提示词模板」分类「AI 工具」可调优；补种入库无需版本号。
	tpl({
		id: "tool.novel2script",
		name: "AI 工具·小说转剧本",
		capability: "text",
		purpose: "script.toScenes",
		category: "AI 工具",
		nodeTypes: ["text"],
		variables: ["原文"],
		isDefault: true,
		order: 40,
		body: [
			"你是资深漫剧/短剧编剧。把下面的小说原文改写成标准的分场影视剧本，供后续分集、分镜与视频化使用。",
			"",
			"【改写要求】",
			"1. 按场景切分：每一场以「第N场 · 地点 · 时间（日/夜·内/外）」单独一行开头。",
			"2. 场景开头先写一行简洁的场景说明（环境、氛围、在场人物），随后进入正文。",
			"3. 正文采用剧本格式：",
			"   - 动作/画面提示行以「▲」开头，用可拍摄的视觉语言描写动作与画面；",
			"   - 台词写作「角色名：台词」，一行一句；心理活动改写为可视化的动作、表情或旁白台词。",
			"4. 忠于原文剧情与人物性格，不遗漏关键情节与反转；冗长叙述与心理描写压缩为画面与台词。",
			"5. 人物名称全篇保持一致；人物首次出场时在动作行里带一句外貌/身份速写。",
			"6. 只输出剧本正文，不要任何解释、前言或总结。",
			"",
			"【小说原文】",
			"{{原文}}",
		].join("\n"),
	}),
	tpl({
		id: "tool.cover.main",
		name: "AI 工具·封面生成",
		capability: "image",
		purpose: "image.cover",
		category: "AI 工具",
		nodeTypes: ["image"],
		variables: ["描述"],
		isDefault: true,
		order: 41,
		body: [
			"为一部漫剧/短剧设计一张海报级高质量封面图。",
			"",
			"【画面要求】",
			"- 构图完整、主体突出，具备电影海报级的视觉冲击力与层次感（前景主体 / 中景氛围 / 背景环境）。",
			"- 光影质感精细，色彩有统一的整体氛围倾向；画面边缘干净，适合直接作为作品封面展示。",
			"- 不要出现任何文字、字幕、水印、logo 或边框。",
			"",
			"【封面内容】",
			"{{描述}}",
		].join("\n"),
	}),
	// ── 奇迹云 H3 推理模板（第249轮）：针对 MiniMax H3（Ref2VA 全参考模式）的智能推理款——
	// 输出仍是客户端可解析的 4 字段卡 JSON（与 smart.infer.multi 同契约，parseInferCards 零改动），
	// 区别在 video_prompts 按 H3 官方六段式（subject_definitions..non_diegetic_music）书写。
	// 补种入库无需版本号；管理端「提示词模板」分类「奇迹云」可调优（正文规范提炼自 H3 官方 Ref2VA 文档）。
	tpl({
		id: "qijicloud.h3.multi",
		name: "奇迹云 H3 推理（六段式）",
		capability: "text",
		purpose: "storyboard.toVideoPrompt",
		category: "奇迹云",
		nodeTypes: ["text", "script"],
		variables: ["原文"],
		isDefault: false,
		order: 9,
		body: [
			"你是 AI 漫剧超创导演，为 MiniMax H3 视频模型（全参考 Ref2VA 模式：参考图/参考视频/参考音频 + 音画同步生成）撰写分镜提示词。",
			"把整集剧本拆成若干张 4-15 秒的分镜大卡（对白密集的镜头取长、纯动作镜头取短），为每一卡同时产出：原剧本、宫格故事板提示词、H3 六段式视频提示词。",
			"",
			"【输出契约（必须严格遵守，客户端按此解析）】",
			"直接输出干净的 JSON 数组，不要任何解释、前言或 Markdown 代码块。数组每个对象恰含四个字段：",
			"- card_number：分镜序号（从 1 起的整数）。",
			"- original_script：该分镜对应的剧本原文，一字不改原样保留。",
			"- storyboard_prompts：本镜首帧/故事板的静态画面描述（中文，含构图、人物位置、环境光效、镜别），供文生图使用。",
			"- video_prompts：H3 六段式视频提示词（见下方规范），一个字符串，段与段之间用换行分隔。",
			"",
			"【video_prompts 六段式规范（H3 官方 Ref2VA 格式）】",
			"六段按固定顺序书写，每段以「段名:」起行；除对白与画面内文字外全部用英文书写。",
			"",
			"1. subject_definitions:",
			"   逐行定义需要单独追踪的参考内容并绑定引用标签：",
			"   - <Subject N>=从参考素材抽象出的可复用可见内容（人物/生物/场景/服装/道具等），写明其来源与主要特征，",
			"     如：<Subject 1> is the young woman in <Picture 1>, with long dark hair and a blue cardigan.",
			"   - <Picture N>=作为具体帧锚点或分镜规划参考的参考图；仅用于定义角色/场景/画风的图不单独立行，在对应 <Subject N> 里引用来源即可。",
			"   - <Video N>=整段视频级关系（剪辑源/续写起点/运镜节奏结构参考）。",
			"   - <Audio N>=参考音频（配音音色/台词/BGM/音效）；绑定说话人时复用其全局编号写 <Subject N> (Sx)。",
			"   标签一经定义，六段全程含义不变、不得重新编号。",
			"",
			"2. summary:",
			"   一小段英文概述目标视频与参考关系，以方括号任务类型前缀开头（多类型用 + 连接、不重复）：",
			"   [keyframe completion]（图作为首帧/关键帧/尾帧等具体帧锚点）/ [reference generation]（图视音仅作角色、场景、画风、动作、运镜、分镜等生成引导）/",
			"   [video editing] / [video continuation] / [audio reuse]（音频信号被直接复用）/ [audio reference]（仅参考音色、节奏、风格不复制信号）。",
			"   例：[reference generation + audio reference] The target video shows <Subject 1> ...",
			"",
			"3. retention_analysis:",
			"   每个引用标签一行，写明其在目标视频中的保留关系（关系标记为固定英文值）：",
			"   可见内容用 fully_preserved / partially_preserved / attribute_transfer / weak_reference；",
			"   音频用 fully_copy / partially_copy / reference / weak_reference。",
			"   例：<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - identity, hair, and costume are retained.",
			"   例：<Audio 1>: reference - the target speaker follows its voice timbre without copying the signal.",
			"",
			"4. detailed_description:",
			"   主体段（生成类通常 350-500 英文词；对白密集时优先完整放下全部台词时间轴）。要求：",
			"   - 开头先用一两句英文确立整体风格与光色基调，再进入 [Shot 1]。",
			"   - [Shot 1] 为开场镜无时间戳；后续切镜写 [Shot N] At MM:SS.mmm, ...；全部时间戳必须落在本卡时长（4-15 秒，与请求秒数对齐）之内。",
			"   - 每个 Shot 写清：当前构图与镜别、主体外观与画面位置、环境与光效、动作与状态变化、运镜（类型/幅度/速度）、当下声音，以及引用内容实际生效的位置；不要退化成剧情梗概或引用关系罗列。",
			"   - 重要 <Subject N> 首次清晰出现时描述其参考特征与画面位置，之后沿用同一标签不再重复定义；帧锚点用自然措辞（the shot begins from <Picture 2> 等）。",
			"   - 说话人给稳定编号 (S1)、(S2)…（按目标视频中实际发声顺序分配一次、全程复用）；角色说话写 <Subject N> (Sx)。",
			"   - 台词与歌词写 <d>[Chinese] ...</d>——**保留剧本台词的中文原文一字不改**，语言标注按台词实际语言；跨镜台词用 <scenetrans>、被结尾截断用 <cutoff> 标注。",
			"   - 画面内可见文字保留原语言原样描述。",
			"",
			"5. overall_soundscape:",
			"   一小段英文总结全片环境音与物理声（房间底噪、风声、脚步、衣料摩擦等）；与具体镜头同步的发声事件留在 detailed_description，不在此重复台词。",
			"",
			"6. non_diegetic_music:",
			"   描述仅观众可闻的配乐（乐器、速度、情绪走向与强弱发展）；无配乐写 N/A。",
			"",
			"【引用标签与素材图例的对应（重要）】",
			"生成阶段素材图例用 @Image1/@Video1/@Audio1 编号——它们与官方标签一一对应：@ImageN 即 <Picture N>、@VideoN 即 <Video N>、@AudioN 即 <Audio N>。",
			"你在 video_prompts 里一律写官方标签形式 <Picture N>/<Video N>/<Audio N>/<Subject N>，编号必须与分镜实际垫入素材的图例编号严格一致，绝不虚构不存在的参考素材。",
			"",
			"【时长】每卡时长按分镜信息量取 4-15 秒；detailed_description 的镜头时间戳与总时长必须自洽（最后一镜的内容不得超出总时长）。",
			"",
			"【本集剧本原文】",
			"{{原文}}",
		].join("\n"),
	}),
	// ── 画风 / 出图预设方案：第174轮起为独立实体（store/presets.ts → presets.json，catalog.presets 下发）。
	// 种子已随迁移移交 presets.ts；此处绝不再种（存量库首启由 presets.ts 连管理端改动一起搬走）。
];

const BUILTIN_TPL_IDS = new Set(DEFAULT_TEMPLATES.map((d) => d.id));

let store: Store = loadJson<Store>(FILE, { version: 0, templates: [] });
if (store.templates.length === 0) {
	store = { version: 1, seedVersion: SEED_VERSION, skillsRefreshVersion: SKILL_REFRESH_VERSION, resetVersion: RESET_VERSION, deletedSeedIds: [], templates: DEFAULT_TEMPLATES };
	saveJson(FILE, store);
} else {
	// 迁移：旧数据补齐 category/images 字段；补种缺失的内置预设（如画风），不覆盖已有改动。
	if (!store.deletedSeedIds) store.deletedSeedIds = [];
	const tomb = new Set(store.deletedSeedIds);
	let changed = false;
	for (const t of store.templates) {
		if (t.category === undefined) { t.category = ""; changed = true; }
		if (t.images === undefined) { t.images = []; changed = true; }
		if (!t.category) {
			const def = DEFAULT_TEMPLATES.find((d) => d.id === t.id);
			if (def?.category) { t.category = def.category; changed = true; }
		}
		// 一次性迁移（幂等，第108轮）：内置单卡模板的用途 视频提示词 → 单卡推理（用户自建单卡模板由管理端手动改）
		if (t.id === "smart.infer.single" && t.purpose === "storyboard.toVideoPrompt") {
			t.purpose = "storyboard.singleShot";
			changed = true;
		}
		// （宫格互斥组回填/旧种子正文升级已随预设拆分迁往 presets.ts——模板库不再持有预设条目）
	}
	for (const def of DEFAULT_TEMPLATES) {
		if (tomb.has(def.id)) continue;
		if (!store.templates.some((t) => t.id === def.id)) {
			store.templates.push(def);
			changed = true;
		}
	}
	// 内置模板一次性刷新：seedVersion 落后 → 用最新 DEFAULT 覆盖内置模板的定义性字段
	// （把 skills/*.md 全文录入正文等；保留用户自建模板与 enabled 状态）
	if ((store.seedVersion ?? 0) < SEED_VERSION) {
		for (const def of DEFAULT_TEMPLATES) {
			const t = store.templates.find((x) => x.id === def.id);
			if (!t) continue;
			for (const k of REFRESH_FIELDS) (t as any)[k] = (def as any)[k];
			t.updatedAt = new Date().toISOString();
		}
		store.seedVersion = SEED_VERSION;
		changed = true;
	}
	// 定向 skills 刷新：仅强制覆盖 SKILL_REFRESH_IDS 指定模板的正文（从 DEFAULT=readSkill 最新 md），
	// 不动其它模板/默认项（避免 SEED_VERSION 全量刷新误伤 fenjing 等的 isDefault/order/正文）。
	if ((store.skillsRefreshVersion ?? 0) < SKILL_REFRESH_VERSION) {
		for (const id of SKILL_REFRESH_IDS) {
			const t = store.templates.find((x) => x.id === id);
			const def = DEFAULT_TEMPLATES.find((d) => d.id === id);
			if (t && def && def.body.trim()) { t.body = def.body; t.updatedAt = new Date().toISOString(); }
		}
		store.skillsRefreshVersion = SKILL_REFRESH_VERSION;
		changed = true;
	}
	// 一次性重置：把模板库裁剪为 RESET_KEEP_IDS（删除 storyboard 三件套/画风/fenjing/用户自建等其余全部）。
	// 移除项不在 DEFAULT_TEMPLATES 内 → 补种不会再加回；gate by resetVersion，裁剪一次后管理员可正常新增。
	if ((store.resetVersion ?? 0) < RESET_VERSION) {
		const before = store.templates.length;
		store.templates = store.templates.filter((t) => RESET_KEEP_IDS.has(t.id));
		if (store.templates.length !== before) changed = true;
		store.resetVersion = RESET_VERSION;
		changed = true;
	}
	// 一次性受众语义迁移（第110轮）：旧语义下「直属用户始终可见平台模板」，新语义源站(platform)也是受众——
	// 把存量 select 补上 platform、none 换算为 select:[platform]，保证迁移瞬间所有用户可见性完全不变。
	if ((store.audienceVersion ?? 0) < 1) {
		for (const t of store.templates) {
			if (t.agentId) continue; // 自营模板无 shareScope 语义
			if (t.shareScope === "select" && !(t.shareAgentIds ?? []).includes(PLATFORM_AUDIENCE)) {
				t.shareAgentIds = [...(t.shareAgentIds ?? []), PLATFORM_AUDIENCE];
			} else if (t.shareScope === "none") {
				t.shareScope = "select";
				t.shareAgentIds = [PLATFORM_AUDIENCE];
			}
		}
		store.audienceVersion = 1;
		changed = true;
	}
	// 一次性定向删除：仅删除 REMOVE_IDS 指定模板 + 记墓碑（防补种回来），不动其它模板/用户自建。
	if ((store.removeVersion ?? 0) < REMOVE_VERSION) {
		if (!store.deletedSeedIds) store.deletedSeedIds = [];
		const rm = new Set(REMOVE_IDS);
		const before = store.templates.length;
		store.templates = store.templates.filter((t) => !rm.has(t.id));
		for (const id of REMOVE_IDS) if (!store.deletedSeedIds.includes(id)) store.deletedSeedIds.push(id);
		if (store.templates.length !== before) changed = true;
		store.removeVersion = REMOVE_VERSION;
		changed = true;
	}
	if (changed) persist();
}

function persist(bump = true): void {
	if (bump) store.version += 1;
	saveJson(FILE, store);
}

export function templatesVersion(): number {
	return store.version;
}

export function listTemplates(): TemplateDef[] {
	return store.templates;
}

/** 平台模板（无 agentId，管理端管理、所有用户可见） */
export function listPlatformTemplates(): TemplateDef[] {
	return store.templates.filter((t) => !t.agentId);
}

/** 某渠道商自营模板 */
export function listTemplatesByAgent(agentId: string): TemplateDef[] {
	return store.templates.filter((t) => t.agentId === agentId);
}

export function listEnabledTemplates(): TemplateDef[] {
	return store.templates.filter((t) => t.enabled);
}

/**
 * 某模板对某用户是否可见（第110轮：源站也是受众，直属用户不再豁免开放限制）：
 *  - 自营模板（有 agentId）：仅归属渠道商的用户可见。
 *  - 平台模板（无 agentId）：按 shareScope 授权——all/未设=全开；select=受众在 shareAgentIds 内
 *    （直属用户受众 = "platform"）；none=不开放给任何人。
 *  第124轮渠道商层级：select 按**归属链**判——链上任一受众被授权即可见（开放给某商=其下游体系可用）；
 *  自营模板仍只对归属商本商的用户可见（父/子商的自营模板互不可见）。
 *  第176轮：select 增按**渠道商分组**判（shareGroupIds，与 models.ts modelVisibleToAgent 同构），
 *  旧受众清单（shareAgentIds）存量继续生效（OR 判定）。
 */
export function templateVisibleToAgent(t: TemplateDef, agentId?: string): boolean {
	if (t.agentId) return t.agentId === agentId;
	const scope = t.shareScope ?? "all";
	if (scope === "all") return true;
	if (scope === "select") {
		const share = t.shareAgentIds ?? [];
		const shareGroups = t.shareGroupIds ?? []; // 第176轮：按渠道商分组（受众的生效分组命中即开放）
		return audienceChain(agentId).some(
			(aud) => share.includes(aud) || (shareGroups.length > 0 && shareGroups.includes(audienceGroupId(aud))),
		);
	}
	return false; // none
}

/**
 * 某用户可见的启用模板 = 其归属渠道商自营模板 + 授权可见的平台模板。
 * agentId 空（平台直属用户）得全部平台模板。
 */
export function listEnabledTemplatesForAgent(agentId?: string): TemplateDef[] {
	return store.templates.filter((t) => t.enabled && templateVisibleToAgent(t, agentId));
}

/** 某渠道商可见（被授权）的平台模板——供渠道商门户只读展示「平台开放给你的模板」 */
export function listSharedPlatformTemplatesForAgent(agentId: string): TemplateDef[] {
	return store.templates.filter((t) => !t.agentId && templateVisibleToAgent(t, agentId));
}

export function getTemplateDef(id: string): TemplateDef | undefined {
	return store.templates.find((t) => t.id === id);
}

/** 按 purpose 取默认可用模板（isDefault 优先，否则 order 最小的启用项）；可选按节点类型过滤 */
export function getDefaultTemplate(purpose: Purpose, nodeType?: string): TemplateDef | undefined {
	const pool = store.templates
		.filter((t) => t.enabled && t.purpose === purpose)
		.filter((t) => !nodeType || !t.nodeTypes?.length || t.nodeTypes.includes(nodeType))
		.sort((a, b) => a.order - b.order);
	return pool.find((t) => t.isDefault) ?? pool[0];
}

export function createTemplate(
	input: Partial<TemplateDef> & Pick<TemplateDef, "id" | "name" | "capability">,
): TemplateDef {
	const t = tpl({
		body: "",
		...input,
		id: input.id.trim(),
	});
	const idx = store.templates.findIndex((x) => x.id === t.id);
	if (idx >= 0) store.templates[idx] = t;
	else store.templates.push(t);
	persist();
	return t;
}

export function updateTemplate(
	id: string,
	patch: Partial<Omit<TemplateDef, "id" | "createdAt">>,
): TemplateDef | undefined {
	const t = getTemplateDef(id);
	if (!t) return undefined;
	Object.assign(t, patch, { updatedAt: new Date().toISOString() });
	// 开放范围清单归一（第176轮）：空数组=未设（undefined），两清单同尺（与 models.updateModel 同款）
	if ("shareAgentIds" in patch) t.shareAgentIds = t.shareAgentIds?.length ? t.shareAgentIds : undefined;
	if ("shareGroupIds" in patch) t.shareGroupIds = t.shareGroupIds?.length ? t.shareGroupIds : undefined;
	persist();
	return t;
}

export function deleteTemplate(id: string): boolean {
	const before = store.templates.length;
	store.templates = store.templates.filter((t) => t.id !== id);
	if (store.templates.length !== before) {
		// 内置模板记墓碑，重启后不再补种（使删除可持久）
		if (BUILTIN_TPL_IDS.has(id)) {
			if (!store.deletedSeedIds) store.deletedSeedIds = [];
			if (!store.deletedSeedIds.includes(id)) store.deletedSeedIds.push(id);
		}
		persist();
		return true;
	}
	return false;
}

/**
 * 第174轮「提示词与预设分开」迁移出口：把模板库里的**平台**预设类模板
 * （无 purpose 且 分类∈{画风,预设方案}）整体取出并从模板库删除，返回给 presets.ts 建库。
 * 渠道商自营模板（agentId 非空）不动——自营预设不属于平台预设库（已知边界）。
 * 每启都调、天然幂等（搬空后再调恒返回 []，不落盘不 bump）。
 */
export function extractPlatformPresetTemplates(): TemplateDef[] {
	const isPreset = (t: TemplateDef) => !t.agentId && !t.purpose && (t.category === "画风" || t.category === "预设方案");
	const out = store.templates.filter(isPreset);
	if (out.length === 0) return [];
	store.templates = store.templates.filter((t) => !isPreset(t));
	persist();
	return out;
}
