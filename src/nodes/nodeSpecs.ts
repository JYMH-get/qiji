/**
 * nodeSpecs —— 画布节点的**规范化模板**（单一事实来源）。
 *
 * 背景（CLAUDE.md 第72轮 画布重做）：旧画布节点按**能力**划分（text/script/image/
 * video/audio/file_*，声明式 JSON 插件）。本次改为按**业务步骤**组织——把资产模式的
 * 每一步封装成一类节点。一个 `NodeSpec` 完整描述一类节点（输入/输出/显示/模型能力/
 * 用途/裂变/参数/执行方式），**加新节点只需在 NODE_SPECS 里加一条**。
 *
 * 设计原则：结果即显示、左输入右输出、面板整合。
 *
 * 依赖约束：本文件只依赖 `@/contract` 的纯类型（Capability/Purpose），不 import 任何
 * store/service，避免循环依赖——这样 services/adapters 可反向 import 本文件派生能力映射。
 */

import type { Capability, Purpose } from "@/contract";
import type { CanvasNode, CanvasEdge, CanvasGroup } from "@/types";
import { IMAGE_QUALITIES, IMAGE_ASPECTS, IMAGE_RESOLUTIONS, VIDEO_RESOLUTIONS, VIDEO_ASPECTS } from "@/lib/genParams";
import { EPISODE_SPLIT_MODES } from "@/lib/episodeSplit";
import { SMART_INFER_SINGLE_TPL } from "@/lib/smartInferPrompts";

/** ResultView 如何渲染节点结果 */
export type DisplayKind = "text" | "image" | "video" | "audio" | "file" | "chat" | "shotgroup" | "pano";

/** 节点执行方式：run=调模型 / script=本地确定性脚本(不调模型) / upload / chat / seed */
export type NodeKind = "run" | "script" | "upload" | "chat" | "seed";

/** 端口数据格式（连线格式交集校验用，见 src/dag/validate.ts） */
export type PortFormat = "text" | "image" | "video" | "audio";

export interface NodePort {
	name: string;
	label: string;
	formats: PortFormat[];
}

/** 裂变：节点成功后按结构化结果创建子节点（自动连线 + 填提示词，但不自动运行） */
export interface SpawnSpec {
	/** 子节点类型（NODE_SPECS 里的 type） */
	childType: string;
	/** 从结构化结果里取哪个集合 */
	source: "assets" | "episodes" | "shots" | "cards";
}

/** 面板参数字段（与 ParamControls 兼容的精简版） */
export interface SpecParamField {
	key: string;
	label: string;
	type: "text" | "textarea" | "enum" | "number" | "boolean";
	options?: string[];
	default?: unknown;
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
}

export interface NodeSpec {
	/** 节点类型（全局唯一，dotted 命名如 image.gen） */
	type: string;
	label: string;
	/** lucide 图标名（pluginRegistry.iconMap 映射） */
	iconName: string;
	accentVar: string;
	category: "analyze" | "generate" | "input" | "chat";
	/** 输入端口（左） */
	inputs: NodePort[];
	/** 输出端口（右） */
	outputs: NodePort[];
	/** 结果如何显示 */
	display: DisplayKind;
	/** 模型能力（驱动面板模型选择）；null = 无模型（上传/种子） */
	capability: Capability | null;
	/** 运行用途（决定上游模板/路由）；null = 不执行 */
	purpose: Purpose | null;
	/** 结构化输出契约 id（元信息，当前解析走宽松解析器，不强制下发） */
	schemaId?: string;
	/** 成功后裂变子节点 */
	spawn?: SpawnSpec;
	/**
	 * 内置提示词：调用大模型前拼接在用户输入前作为指令（仅 ai.chat 用作系统指令）。
	 * 资产/分集/分镜/故事板等步骤的提示词与资产模式一致，走管理端 catalog 模板（见 useTemplateVars）。
	 */
	builtinPrompt?: string;
	/**
	 * 节点未显式选模板时的默认模板 id（如 智能推理=单分镜模板）。
	 * 面板模板胶囊显示它的真名，执行时随请求下发；用户可在模板下拉里改选同 purpose 的其它模板。
	 */
	defaultTemplateId?: string;
	/**
	 * 模板下拉可选的用途集合（缺省=仅 spec.purpose）。输出是同一套解析的节点可跨用途选模板
	 * （如 智能推理：storyboard.toVideoPrompt + storyboard.split 共用卡解析），选中哪条就按哪条用途执行。
	 */
	templatePurposes?: Purpose[];
	/**
	 * 与**资产模式一致**：调模型时发 `variables{原文,视觉风格}` + 默认 catalog 模板（不发整段 prompt），
	 * 由管理端模板拼接提示词、客户端用同一套解析器解析。文本处理节点(资产拆分/分集/智能推理/故事板)用。
	 */
	useTemplateVars?: boolean;
	/** 成功后把完整文本结果落到一个下游「文本」节点（结果由下一个文本节点承载） */
	emitResultText?: boolean;
	/** 面板暴露的参数（无 catalog 模型时的兜底参数表单） */
	params?: SpecParamField[];
	/** 执行方式 */
	kind: NodeKind;
	description?: string;
	/** 是否在调色板（左侧工具栏 / 右键新建）展示；上传走右键/拖放，不占工具栏 */
	inPalette?: boolean;
}

// 每个节点只有一个输入点(in)与一个输出点(out)；输入点 formats = 该节点可接收的所有格式的并集，
// 实际素材分流靠上游产物类型（媒体按 asset.kind / 文本按上游节点类型），不依赖端口名。
const IN_TEXT: NodePort = { name: "in", label: "输入", formats: ["text"] };
const OUT_TEXT: NodePort = { name: "out", label: "输出", formats: ["text"] };
const IN_TEXT_IMAGE: NodePort = { name: "in", label: "输入", formats: ["text", "image"] };
const IN_ALL: NodePort = { name: "in", label: "输入", formats: ["text", "image", "video", "audio"] };
const OUT_IMAGE: NodePort = { name: "out", label: "输出", formats: ["image"] };
const OUT_VIDEO: NodePort = { name: "out", label: "输出", formats: ["video"] };

// 出图要求与资产模式一一对应：模型(面板选) + 质量 + 比例 + 分辨率（执行时 比例×分辨率→size）
const IMG_PARAMS: SpecParamField[] = [
	{ key: "quality", label: "质量", type: "enum", options: IMAGE_QUALITIES, default: "high" },
	{ key: "aspect", label: "比例", type: "enum", options: IMAGE_ASPECTS.map((a) => a.v), default: "16:9" },
	{ key: "resolution", label: "分辨率", type: "enum", options: IMAGE_RESOLUTIONS.map((r) => r.v), default: "2k" },
];

// 生视频要求与资产模式一一对应：模型(面板选) + 时长 + 分辨率 + 比例
const VIDEO_PARAMS: SpecParamField[] = [
	{ key: "duration", label: "时长", type: "number", default: 15, min: 4, max: 15, step: 1, unit: "s" },
	{ key: "resolution", label: "分辨率", type: "enum", options: VIDEO_RESOLUTIONS, default: "720p" },
	{ key: "aspect_ratio", label: "比例", type: "enum", options: VIDEO_ASPECTS, default: "16:9" },
];

// 剧集分集（纯脚本，不调模型）：与资产模式一致的 4 种确定性切分方式
const EPISODE_PARAMS: SpecParamField[] = [
	{ key: "splitMode", label: "分集方式", type: "enum", options: [...EPISODE_SPLIT_MODES], default: "n-n" }, // 默认 n-n（第121轮用户定）
];

/**
 * 8 类节点 = 7 业务步骤 + 1 文本种子（第87轮删「生成故事板」）。
 * 顺序即调色板顺序（流水线：种子 → 拆分/分集 → 生成 → 对话/上传）。
 */
export const NODE_SPECS: NodeSpec[] = [
	{
		type: "text.seed",
		label: "文本",
		iconName: "Type",
		accentVar: "var(--node-seed)",
		category: "input",
		// 可手动输入（种子），也可接收上游文本（如智能推理裂变出的每卡原剧本内容）
		inputs: [IN_TEXT],
		outputs: [OUT_TEXT],
		display: "text",
		capability: null,
		purpose: null,
		kind: "seed",
		inPalette: true,
		description: "手动输入文本，作为各步骤的创意种子（不调模型）；也可承接上游文本",
	},
	{
		type: "asset.split",
		label: "资产拆分",
		iconName: "Boxes",
		accentVar: "var(--node-asset)",
		category: "analyze",
		inputs: [IN_TEXT],
		outputs: [OUT_TEXT],
		display: "text",
		capability: "text",
		purpose: "script.analyze",
		schemaId: "asset.extract.v1",
		spawn: { childType: "image.gen", source: "assets" },
		useTemplateVars: true,
		kind: "run",
		inPalette: true,
		description: "剧本/小说 → 资产体系（角色/场景/生物/道具），并裂变出多个「生成图片」节点（自动连线、填好提示词）",
	},
	{
		type: "episode.split",
		label: "剧集分集",
		iconName: "ListTree",
		accentVar: "var(--node-text)",
		category: "analyze",
		inputs: [IN_TEXT],
		outputs: [OUT_TEXT],
		display: "text",
		capability: null,
		purpose: null,
		// 每集裂变成一个「智能推理」节点承接本集原文（填好内容、不自动运行），运行即出该集分镜流水线
		spawn: { childType: "smart.infer", source: "episodes" },
		params: EPISODE_PARAMS,
		kind: "script",
		inPalette: true,
		description: "整部原文 → 分集（纯脚本，不调模型）：按第N集/双换行/n-n/n-1 四种方式，裂变出每集「智能推理」节点（承接本集原文，运行即出该集分镜流水线）",
	},
	{
		type: "smart.infer",
		label: "智能推理",
		iconName: "Sparkles",
		accentVar: "var(--node-storyboard)",
		category: "analyze",
		inputs: [IN_TEXT],
		outputs: [OUT_TEXT],
		display: "text",
		capability: "text",
		purpose: "storyboard.toVideoPrompt",
		spawn: { childType: "text.seed", source: "cards" },
		// 单镜头推理节点（第88轮简化：与资产拆分同形态——模板走下拉选择，无模式参数）。
		// 默认单分镜模板；正文留服务端。
		defaultTemplateId: SMART_INFER_SINGLE_TPL,
		// 允许用途全集（多卡/单卡/智能拆分，输出共用同一套卡解析）。⚠ 实际可选集按**上游类型**动态收敛
		//（lib/inferUpstream.smartInferContext：上游智能推理→仅单卡；上游剧集分集→仅多卡+拆分；其他→全部），
		// 面板下拉过滤、执行允许集/默认回退、模板联动门禁都用它，这里只是静态超集。
		templatePurposes: ["storyboard.toVideoPrompt", "storyboard.unified", "storyboard.singleShot", "storyboard.unifiedShot", "storyboard.split"],
		useTemplateVars: true,
		kind: "run",
		inPalette: true,
		description: "单镜头推理：对一段分镜原文一次出 故事板提示词 + 视频提示词，裂变「文本→生成图片→生成视频」流水线；模板下拉可换（如整集多分镜）",
	},
	// 「生成故事板」节点已删（第87轮）：智能推理一次出全（分镜+故事板提示词+视频提示词），
	// 单独的 storyboard.toImagePrompt 节点无实际用途；旧画布残留节点由 sanitizeCanvas 载入时清除。
	{
		type: "image.gen",
		label: "生成图片",
		iconName: "ImageIcon",
		accentVar: "var(--node-image)",
		category: "generate",
		inputs: [IN_TEXT_IMAGE],
		outputs: [OUT_IMAGE],
		display: "image",
		capability: "image",
		purpose: "asset.character.image",
		params: IMG_PARAMS,
		kind: "run",
		inPalette: true,
		description: "文生图 / 图生图，调用图片模型",
	},
	{
		type: "image.depth",
		label: "转深度",
		iconName: "Layers",
		accentVar: "var(--node-image)",
		category: "generate",
		// 专用转深度节点（第198轮）：**纯本地推理、无模型能力、永不走生图管线**——
		// 此前占位节点是普通 image.gen，用户点「生成」会真调生图模型扣费（真机事故）。
		// 运行 = 重新转深度（优先上游连线图片，其次创建时记录的原图）。
		inputs: [{ name: "in", label: "原图", formats: ["image"] }],
		outputs: [OUT_IMAGE],
		display: "image",
		capability: null,
		purpose: null,
		kind: "script",
		inPalette: false,
		description: "本地推理生成黑白深度图（近白远黑，不调模型零计费）；运行=重新转深度。由图片节点「转深度」创建",
	},
	{
		type: "video.gen",
		label: "生成视频",
		iconName: "Clapperboard",
		accentVar: "var(--node-video)",
		category: "generate",
		inputs: [IN_ALL],
		outputs: [OUT_VIDEO],
		display: "video",
		capability: "video",
		purpose: "video.generate",
		params: VIDEO_PARAMS,
		kind: "run",
		inPalette: true,
		description: "调用视频模型，可垫图片/音频/视频素材",
	},
	{
		type: "video.depth",
		label: "转深度",
		iconName: "Layers",
		accentVar: "var(--node-video)",
		category: "generate",
		// 专用视频转深度节点（第206轮，与 image.depth 同规矩）：**纯本地逐帧推理、无模型能力、
		// 永不走生视频管线**——运行 = 重新转深度（优先上游连线视频，其次创建时记录的原视频）。
		// 按源视频**原帧率**逐帧（不抽帧，第206轮补充用户定稿；容器解析 fps，失败回退 30）。
		inputs: [{ name: "in", label: "原视频", formats: ["video"] }],
		outputs: [OUT_VIDEO],
		display: "video",
		capability: null,
		purpose: null,
		kind: "script",
		inPalette: false,
		description: "本地按原帧率逐帧推理生成灰度深度视频（近白远黑，不调模型零计费）；运行=重新转深度。由视频节点「转深度」创建",
	},
	{
		type: "ai.chat",
		label: "AI对话",
		iconName: "Bot",
		accentVar: "var(--node-chat)",
		category: "chat",
		inputs: [IN_TEXT_IMAGE],
		outputs: [OUT_TEXT],
		display: "chat",
		capability: "text",
		purpose: "chat.reply",
		builtinPrompt: "你是简一助手，一个专业、友好的漫剧创作 AI 助手。请用中文简洁清晰地回答用户。",
		kind: "chat",
		inPalette: true,
		description: "单轮问答（一问一答）；串联多个对话节点即带上游记忆，可逐节点跳过某轮；答完自动新建下游对话节点",
	},
	{
		type: "shot.group",
		label: "分镜组",
		iconName: "LayoutGrid",
		accentVar: "var(--node-storyboard)",
		category: "input",
		// 纯组合展示节点：不参与连线（拼接产物由新图片节点承载并可连线）
		inputs: [],
		outputs: [],
		display: "shotgroup",
		capability: null,
		purpose: null,
		kind: "seed",
		inPalette: false,
		description: "多张图片按宫格固定布局组成分镜组：可拖动排序/改比例/改宫格数/显示序号/拼接成大图/解组。由多选图片节点「合并为分镜组」或图片「宫格切分」创建",
	},
	{
		type: "pano.view",
		label: "720全景查看",
		iconName: "Globe",
		accentVar: "var(--node-storyboard)",
		category: "input",
		// 纯查看节点：吃上游 equirect 全景图，节点内 WebGL 交互查看（拖动转视角/滚轮视场/双击全屏）
		inputs: [{ name: "in", label: "全景图", formats: ["image"] }],
		outputs: [],
		display: "pano",
		capability: null,
		purpose: null,
		kind: "seed",
		inPalette: false,
		description: "720°全景查看节点：连接一张 equirect 2:1 全景图，节点上直接拖动查看（跳过扭曲平面图）；双击放大全屏，可截取当前视角/四/六/八/十二视图。由「转全景」自动连出",
	},
	{
		type: "upload",
		label: "上传本地",
		iconName: "Upload",
		accentVar: "var(--node-file)",
		category: "input",
		inputs: [],
		// 输出格式为联合：实际可连性由 dag/validate 按文件真实类型 + 端口格式交集决定
		outputs: [{ name: "out", label: "素材", formats: ["image", "video", "audio", "text"] }],
		display: "file",
		capability: null,
		purpose: null,
		kind: "upload",
		inPalette: true,
		description: "本地上传图片/视频/音频/文本，自适应显示与输出（无上游）",
	},
];

const SPEC_BY_TYPE: Record<string, NodeSpec> = Object.fromEntries(
	NODE_SPECS.map((s) => [s.type, s]),
);

export function listNodeSpecs(): NodeSpec[] {
	return NODE_SPECS;
}

export function getNodeSpec(type: string): NodeSpec | undefined {
	return SPEC_BY_TYPE[type];
}

/** 已知节点类型（用于加载旧项目时清空无法识别的旧节点） */
export function isKnownNodeType(type: string): boolean {
	return type === "group" || type in SPEC_BY_TYPE;
}

const RAW_CAPS = new Set<string>(["text", "image", "video", "audio", "video-enhance", "video-erase", "image-enhance"]);

/**
 * 节点类型 → 模型能力（面板模型下拉/默认模型用）。
 * 兼容三种入参：① 新业务节点类型（查 spec）；② 直接传能力名（text/image/...，原样返回）；
 * ③ 未知 → 回退 text。
 */
export function capabilityForNodeType(type: string): Capability {
	const spec = SPEC_BY_TYPE[type];
	if (spec) return spec.capability ?? "text";
	if (RAW_CAPS.has(type)) return type as Capability;
	return "text";
}

/** 某能力对应的全部节点类型（真实 catalog 模型的 nodeTypes 白名单用） */
export function nodeTypesForCapability(cap: Capability): string[] {
	return NODE_SPECS.filter((s) => s.capability === cap).map((s) => s.type);
}

/**
 * 清洗画布：丢弃无法识别的旧节点类型（旧画布重做），级联删除两端不存在的边、
 * 清理分组 childIds（空分组连同其分组节点一并删除）。加载旧项目时调用。
 */
export function sanitizeCanvas(
	nodes: Record<string, CanvasNode>,
	edges: Record<string, CanvasEdge>,
	groups: Record<string, CanvasGroup>,
): { nodes: Record<string, CanvasNode>; edges: Record<string, CanvasEdge>; groups: Record<string, CanvasGroup> } {
	const cleanNodes: Record<string, CanvasNode> = {};
	for (const [id, n] of Object.entries(nodes)) {
		if (isKnownNodeType(n.type)) cleanNodes[id] = n;
	}
	// 清理分组：只保留分组节点仍在、且至少 1 个子节点存活的分组
	const cleanGroups: Record<string, CanvasGroup> = {};
	for (const [id, g] of Object.entries(groups)) {
		if (!cleanNodes[id]) continue;
		const childIds = g.childIds.filter((c) => cleanNodes[c]);
		if (childIds.length === 0) { delete cleanNodes[id]; continue; }
		cleanGroups[id] = { ...g, childIds };
	}
	const present = new Set(Object.keys(cleanNodes));
	const cleanEdges: Record<string, CanvasEdge> = {};
	for (const [id, e] of Object.entries(edges)) {
		if (present.has(e.source) && present.has(e.target)) cleanEdges[id] = e;
	}
	return { nodes: cleanNodes, edges: cleanEdges, groups: cleanGroups };
}
