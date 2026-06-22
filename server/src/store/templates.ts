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
import type { Capability, Purpose } from "../contract.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 读取 skills/ 下的提示词原稿作模板正文（仅 seed/刷新时用，之后正文持久化在 templates.json）。
 * 路径：server/src/store → 上溯到仓库根的 skills/。缺失则返回 ""（调用方给兜底正文）。
 */
function readSkill(relPath: string): string {
	for (const base of ["../../../skills", "../../skills"]) {
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
	/** 绑定的输出 schema id（结构化输出强制） */
	schemaId?: string;
	/** 链式复合：跑完本段后把输出注入下一段并再调一次（增量B 编排） */
	chainNextId?: string;
	/** 注入到下一段的变量名（默认"上一步"） */
	chainPipeVar?: string;
	/** 该 (capability + 各 nodeType) 下默认选中 */
	isDefault?: boolean;
	enabled: boolean;
	order: number;
	createdAt: string;
	updatedAt: string;
}

interface Store {
	version: number;
	/** 内置模板种子版本：bump 后启动时刷新内置模板正文（不动用户自建模板） */
	seedVersion?: number;
	templates: TemplateDef[];
}

const FILE = "templates.json";
/** 内置模板有重大更新（如把 skills/*.md 全文录入正文）时 +1，触发一次性刷新 */
const SEED_VERSION = 2;
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
	tpl({
		id: "storyboard.split.basic",
		name: "分镜拆分（基础）",
		capability: "text",
		purpose: "storyboard.split",
		category: "分镜生图",
		nodeTypes: ["script"],
		variables: ["原文", "历史资产", "视觉风格", "分镜数量", "单镜时长", "当前时间"],
		schemaId: "storyboard.v1",
		isDefault: true,
		order: 2,
		// 正文权威来源：skills/剧本2分镜/剧本划分分镜.md（{{text}} 归一为 {{原文}}，追加运行期约束）
		body: (readSkill("剧本2分镜/剧本划分分镜.md").replace(/\{\{\s*text\s*\}\}/g, "{{原文}}") ||
			"你是分镜脚本师。把本集原文拆成分镜，每镜含剧情/台词/动态视频提示词/引用资产/时长。\n本集原文：\n{{原文}}") +
			"\n\n【生成约束】历史资产（引用匹配）：{{历史资产}}；视觉风格：{{视觉风格}}；目标分镜数量：{{分镜数量}}（为「自动」时按节奏自定、宁多勿漏）；单分镜最大时长：{{单镜时长}}秒；当前时间：{{当前时间}}。",
	}),
	// 分镜 → 视频提示词（权威全文：skills/分镜2视频/视频分镜提示词.md；当前 UI 暂未调用，备用/未来）
	tpl({
		id: "storyboard.tovideo.basic",
		name: "视频分镜提示词（基础）",
		capability: "text",
		purpose: "storyboard.toVideoPrompt",
		category: "分镜生图",
		nodeTypes: ["script"],
		variables: ["原文", "所需资产", "前文上下文"],
		schemaId: "videoPrompt.v1",
		isDefault: true,
		order: 3,
		body: readSkill("分镜2视频/视频分镜提示词.md")
			.replace(/\{\{\s*text\s*\}\}/g, "{{原文}}")
			.replace(/\{\{\s*requiredAssets\s*\}\}/g, "{{所需资产}}")
			.replace(/\{\{\s*context\s*\}\}/g, "{{前文上下文}}") ||
			[
				"你是 AI 漫剧超创导演。把下方分镜重构为可驱动视频大模型的提示词，每 15 秒卡拆 5-8 个镜头。",
				"保留代码公式：{角色:名}/{场景:名}/{音频:角色名}…。无字幕、无 BGM、仅音效。",
				"所需资产：{{所需资产}}；前文上下文：{{前文上下文}}。\n当前分镜：\n{{原文}}",
			].join("\n"),
	}),
	// ── 内部模板（不进选择器；调用时显式传 templateId）──
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
	tpl({
		id: "asset.prompt.optimize",
		name: "出图提示词优化（内部）",
		capability: "text",
		purpose: "script.analyze",
		category: "内部",
		nodeTypes: ["text"],
		variables: ["原提示词"],
		order: 11,
		body: [
			"你是 AI 出图提示词工程师。请在不改变资产身份与 DNA 的前提下，润色优化下面这段【出图提示词】，",
			"使其更精确、更利于 3D/国漫风格出图：补全画质/构图/光影/镜头细节，保留纯白背景与禁止红线，",
			"不要新增剧情动作或无关元素。只输出优化后的提示词正文，不要任何解释。",
			"",
			"【原提示词】：",
			"{{原提示词}}",
		].join("\n"),
	}),
	// ── 画风预设（无 purpose，不可执行；body = 视觉风格描述符，新建项目时选用，可附参考图）──
	tpl({
		id: "style.3d-guoman",
		name: "3D国漫 (动漫半写实)",
		capability: "image",
		category: "画风",
		order: 1,
		body: "3D国风动画",
	}),
	tpl({
		id: "style.2d-hand",
		name: "2D手绘 (二次元日系)",
		capability: "image",
		category: "画风",
		order: 2,
		body: "2D日漫剧场版",
	}),
	tpl({
		id: "style.realistic",
		name: "真人写实 (电影级大片)",
		capability: "image",
		category: "画风",
		order: 3,
		body: "电影级写实",
	}),
];

let store: Store = loadJson<Store>(FILE, { version: 0, templates: [] });
if (store.templates.length === 0) {
	store = { version: 1, seedVersion: SEED_VERSION, templates: DEFAULT_TEMPLATES };
	saveJson(FILE, store);
} else {
	// 迁移：旧数据补齐 category/images 字段；补种缺失的内置预设（如画风），不覆盖已有改动。
	let changed = false;
	for (const t of store.templates) {
		if (t.category === undefined) { t.category = ""; changed = true; }
		if (t.images === undefined) { t.images = []; changed = true; }
		if (!t.category) {
			const def = DEFAULT_TEMPLATES.find((d) => d.id === t.id);
			if (def?.category) { t.category = def.category; changed = true; }
		}
	}
	for (const def of DEFAULT_TEMPLATES) {
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

export function listEnabledTemplates(): TemplateDef[] {
	return store.templates.filter((t) => t.enabled);
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
	persist();
	return t;
}

export function deleteTemplate(id: string): boolean {
	const before = store.templates.length;
	store.templates = store.templates.filter((t) => t.id !== id);
	if (store.templates.length !== before) {
		persist();
		return true;
	}
	return false;
}
