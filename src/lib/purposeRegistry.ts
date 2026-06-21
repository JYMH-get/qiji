/**
 * Purpose 映射注册表 —— 「表格按键 ⇄ 画布节点」的唯一事实来源。
 *
 * 背景（CLAUDE.md §5 已锁定「表格按键 ⇄ 画布节点一一映射」「单数据源双视图」）：
 *  - 节点侧（nodeMetadata.NODE_REGISTRY）按**能力**分类：text/script/image/video/audio/file。
 *  - 表格侧按键按**用途**分类：分析剧本 / 生成三视图 / 开始分镜 / 视频生成 …
 *  - 二者的桥就是契约里的 `Purpose`（contract.ts）。映射链：
 *        表格按键 → purpose → capability → 画布节点类型
 *  - 用户说的"文本类节点中的资产分析节点" = (text 能力节点) + (purpose=script.analyze)。
 *
 * 本表是**规范映射（稳定契约）**，不是实现进度表——某 purpose 当前是否已接线、是否还在 mock，
 * 不在这里记录（那会过时）。表格视图与画布节点都应从本表读取语义，避免两侧各写一份。
 *
 * 节点能力链（与 NODE_REGISTRY 端口一致）：
 *   text(出 text) → script(收 text 出 shot/分镜) → image(收 shot 出 frame) →
 *   video(收 frame 出 clip) → audio(收 clip 出 audio)
 */

import type { Purpose, Capability, AssetType } from "@/contract";

/** 画布基础节点类型（与 nodeMetadata.NODE_REGISTRY 对齐；不含 group） */
export type CanvasNodeType = "text" | "script" | "image" | "video" | "audio" | "file";

/** 表格模式各业务界面标识 */
export type WorkbenchView =
	| "script" // 剧本（剧本推理）
	| "character" // 角色
	| "scene" // 场景
	| "creature" // 生物
	| "prop" // 物品
	| "video" // 视频分集
	| "storyboard"; // 分镜板

/** 各界面对应的路由（与 EditorSidebar 导航一致） */
export const VIEW_ROUTE: Record<WorkbenchView, string> = {
	script: "/frame1693",
	character: "/frame16285",
	scene: "/frame16550",
	creature: "/frame16780",
	prop: "/frame161000",
	video: "/frame161195",
	storyboard: "/frame-storyboard",
};

export interface PurposeMeta {
	purpose: Purpose;
	/** 模型能力（决定管理端路由到哪类上游） */
	capability: Capability;
	/** 对应的画布节点类型——这是「按键 ⇄ 节点」映射的核心 */
	nodeType: CanvasNodeType;
	/** 资产大类（仅 asset.* 用途有） */
	assetType?: AssetType;
	/** 是否变体（变体走图生图 image-edit + 保 DNA 前缀；否则文生图） */
	isVariant?: boolean;
	/** 表格界面里的按键文案；"" = 该 purpose 暂无表格按键（覆盖空洞，待补） */
	buttonLabel: string;
	/** 该按键所属的表格界面 */
	view: WorkbenchView;
	/** 一句话说明 */
	description: string;
}

/**
 * purpose → 元信息。覆盖 contract.ts 中全部 13 个 Purpose。
 * buttonLabel 为 "" 的条目表示当前表格侧尚无对应按键（已知覆盖空洞）。
 */
export const PURPOSE_REGISTRY: Record<Purpose, PurposeMeta> = {
	"script.toScenes": {
		purpose: "script.toScenes",
		capability: "text",
		nodeType: "text",
		buttonLabel: "",
		view: "script",
		description: "小说原文 → 分场剧本",
	},
	"script.analyze": {
		purpose: "script.analyze",
		capability: "text",
		nodeType: "text",
		buttonLabel: "分析剧本",
		view: "script",
		description: "剧本 → 资产体系（角色/场景/生物/道具/分集）",
	},
	"storyboard.split": {
		purpose: "storyboard.split",
		capability: "text",
		nodeType: "script",
		buttonLabel: "开始分镜",
		view: "storyboard",
		description: "单集 → 分镜 + 分镜提示词",
	},
	"asset.character.image": {
		purpose: "asset.character.image",
		capability: "image",
		nodeType: "image",
		assetType: "character",
		buttonLabel: "生成三视图",
		view: "character",
		description: "角色基础形象（文生图）",
	},
	"asset.character.variant": {
		purpose: "asset.character.variant",
		capability: "image",
		nodeType: "image",
		assetType: "character",
		isVariant: true,
		buttonLabel: "造型预设·生成",
		view: "character",
		description: "角色变体（图生图，保 DNA + 角色变体前缀）",
	},
	"asset.scene.image": {
		purpose: "asset.scene.image",
		capability: "image",
		nodeType: "image",
		assetType: "scene",
		buttonLabel: "生成形象",
		view: "scene",
		description: "场景基础形象（文生图）",
	},
	"asset.scene.variant": {
		purpose: "asset.scene.variant",
		capability: "image",
		nodeType: "image",
		assetType: "scene",
		isVariant: true,
		buttonLabel: "",
		view: "scene",
		description: "场景变体（图生图，保 DNA + 场景变体前缀）",
	},
	"asset.creature.image": {
		purpose: "asset.creature.image",
		capability: "image",
		nodeType: "image",
		assetType: "creature",
		buttonLabel: "生成形象",
		view: "creature",
		description: "生物基础形象（文生图）",
	},
	"asset.creature.variant": {
		purpose: "asset.creature.variant",
		capability: "image",
		nodeType: "image",
		assetType: "creature",
		isVariant: true,
		buttonLabel: "",
		view: "creature",
		description: "生物变体（图生图，保 DNA + 生物变体前缀）",
	},
	"asset.prop.image": {
		purpose: "asset.prop.image",
		capability: "image",
		nodeType: "image",
		assetType: "prop",
		buttonLabel: "生成形象",
		view: "prop",
		description: "物品基础形象（文生图）",
	},
	"asset.prop.variant": {
		purpose: "asset.prop.variant",
		capability: "image",
		nodeType: "image",
		assetType: "prop",
		isVariant: true,
		buttonLabel: "",
		view: "prop",
		description: "物品变体（图生图，保 DNA + 道具变体前缀）",
	},
	"video.generate": {
		purpose: "video.generate",
		capability: "video",
		nodeType: "video",
		buttonLabel: "视频生成",
		view: "storyboard",
		description: "分镜 + 垫素材 → 视频片段",
	},
	"audio.tts": {
		purpose: "audio.tts",
		capability: "audio",
		nodeType: "audio",
		buttonLabel: "",
		view: "character",
		description: "文本转语音（用角色 voiceHint）",
	},
};

/**
 * 画布节点类型 → 代表性默认 purpose。
 * 用于画布节点经 runPurpose 收口时确定 purpose（节点未显式带 params.purpose 时）。
 * 约束：每项的 PURPOSE_REGISTRY[p].nodeType 必须等于其键，确保 submit 的节点类型不变。
 * 节点将来可在 params.purpose 显式指定（如 text 节点选 script.toScenes），覆盖此默认。
 */
export const NODE_DEFAULT_PURPOSE: Record<CanvasNodeType, Purpose> = {
	text: "script.analyze",
	script: "storyboard.split",
	image: "asset.character.image",
	video: "video.generate",
	audio: "audio.tts",
	file: "script.analyze", // file 节点无生成语义（一般不执行 submit），占位
};

// ── 查询助手 ──────────────────────────────────────────────

/** 取某 purpose 的元信息 */
export function getPurposeMeta(purpose: Purpose): PurposeMeta {
	return PURPOSE_REGISTRY[purpose];
}

/** 全部 purpose 元信息（用于遍历/盘点） */
export function listPurposes(): PurposeMeta[] {
	return Object.values(PURPOSE_REGISTRY);
}

/** 某画布节点类型承载的所有 purpose（一节点多用途，靠 purpose 区分语义） */
export function purposesByNode(nodeType: CanvasNodeType): PurposeMeta[] {
	return listPurposes().filter((m) => m.nodeType === nodeType);
}

/** 某资产大类的 purpose（基础 + 变体） */
export function purposesByAsset(assetType: AssetType): PurposeMeta[] {
	return listPurposes().filter((m) => m.assetType === assetType);
}

/** 取某资产大类的「基础形象」或「变体」purpose */
export function assetImagePurpose(assetType: AssetType, variant = false): Purpose {
	const hit = listPurposes().find(
		(m) => m.assetType === assetType && !!m.isVariant === variant
	);
	if (!hit) throw new Error(`无 ${assetType} ${variant ? "变体" : "基础"} purpose`);
	return hit.purpose;
}

/** 某表格界面里所有挂了按键的 purpose（buttonLabel 非空） */
export function purposesByView(view: WorkbenchView): PurposeMeta[] {
	return listPurposes().filter((m) => m.view === view && m.buttonLabel !== "");
}

/** 当前尚无表格按键的 purpose（已知覆盖空洞，用于盘点/补齐） */
export function unwiredPurposes(): PurposeMeta[] {
	return listPurposes().filter((m) => m.buttonLabel === "");
}
