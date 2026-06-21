/**
 * 提示词模板存储（文件持久化）—— 数据化的 catalog 模板，正文权威留管理端。
 *
 * 仿 store/models.ts：每个模板带 purpose（用途/schema 路由）+ nodeTypes（节点类型白名单，
 * 控制"用在哪个节点"）+ body 正文 + variables。管理端可增删改 + 编辑正文 + 绑定节点。
 * 改动后 bump 版本（并入 catalog version，触发用户端热更新）。
 *
 * 链式复合（chainNextId/chainPipeVar）字段先在此落数据，编排在 dispatchGenerate 实现（增量B）。
 */
import { loadJson, saveJson } from "./db.ts";
import type { Capability, Purpose } from "../contract.ts";

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
	templates: TemplateDef[];
}

const FILE = "templates.json";

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
		variables: ["视觉风格", "原文", "历史资产", "已有视觉圣经", "当前时间"],
		schemaId: "asset.extract.v1",
		isDefault: true,
		order: 1,
		body: [
			"你是漫剧资产拆分专家。视觉风格：{{视觉风格}}。",
			"请阅读以下原文，提取角色/场景/生物/道具及视觉圣经、分集，只提取核心且高频出现的资产。",
			"已有视觉圣经（如有，需继承不漂移）：{{已有视觉圣经}}",
			"历史资产（如有，需复用而非重复新建）：{{历史资产}}",
			"当前时间：{{当前时间}}",
			"",
			"原文：",
			"{{原文}}",
		].join("\n"),
	}),
	tpl({
		id: "storyboard.split.basic",
		name: "分镜拆分（基础）",
		capability: "text",
		purpose: "storyboard.split",
		category: "分镜生图",
		nodeTypes: ["script"],
		variables: ["原文", "历史资产", "当前时间"],
		schemaId: "storyboard.v1",
		isDefault: true,
		order: 2,
		body: [
			"你是分镜脚本师。将本集原文拆成分镜，每镜含剧情、台词（≤30字，不增不删，无则填'无'）、",
			"动态视频提示词、引用的角色/场景/道具、时长（≤15秒）。",
			"历史资产（用于引用匹配）：{{历史资产}}",
			"当前时间：{{当前时间}}",
			"",
			"本集原文：",
			"{{原文}}",
		].join("\n"),
	}),
	// 分镜 → 视频提示词（第26轮新增；权威全文见 skills/分镜2视频/视频分镜提示词.md，待粘贴入下方 body）
	tpl({
		id: "storyboard.tovideo.basic",
		name: "视频分镜提示词（基础）",
		capability: "text",
		purpose: "storyboard.toVideoPrompt",
		category: "分镜生图",
		nodeTypes: ["script"],
		variables: ["分镜内容", "所需资产", "前文上下文"],
		schemaId: "videoPrompt.v1",
		isDefault: true,
		order: 3,
		body: [
			"你是 AI 漫剧超创导演。把下方分镜重构为可直接驱动视频大模型的提示词，",
			"每 15 秒卡拆 5-8 个镜头(动态时间轴，精确到小数点)。",
			"必须保留代码公式：人物 {角色:名}、场景 {场景:名}、",
			"台词 {音频:角色名}的音色[情绪]:“…”、内心 {音频:OS-角色名}、旁白 {音频:VO-旁白}、音效 音效:“…”。",
			"无字幕、无 BGM、仅保留音效。",
			"",
			"本批次所需资产：{{所需资产}}",
			"前文上下文：{{前文上下文}}",
			"",
			"当前分镜：",
			"{{分镜内容}}",
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
	store = { version: 1, templates: DEFAULT_TEMPLATES };
	saveJson(FILE, store);
} else {
	// 迁移：旧数据补齐 category/images 字段；补种缺失的内置预设（如画风），不覆盖已有改动。
	let changed = false;
	for (const t of store.templates) {
		if (t.category === undefined) { t.category = ""; changed = true; }
		if (t.images === undefined) { t.images = []; changed = true; }
		// 内置模板若未分类，回填默认分类
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
