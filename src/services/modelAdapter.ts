/**
 * 统一 Model Hub 适配层。Seedance / Kling / Wan / Lib Image / GVLM 等收敛为同一契约。
 * 一鱼多吃：驱动底部操作面板（modes + paramsSchema）、积分预估（estimateCost）、Agent 能力声明。
 *
 * 节点对外只展示结果（图片/视频/文本/脚本/音频）；“换模型 = 换 schema”，
 * 底部面板随选中模型动态重渲，结果显示不变。
 */
import type { NodeType } from "@/types";

export type ParamType = "text" | "textarea" | "enum" | "number" | "boolean";

export interface ParamField {
	key: string;
	label: string;
	type: ParamType;
	options?: string[];
	default?: unknown;
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
	group?: string;
}

/** 能力模式（面板顶部 tab）：一个模型可带多个能力，各自一套参数表单。 */
export interface CapabilityMode {
	key: string;
	label: string;
	inputHint?: string;
	paramsSchema: ParamField[];
}

export interface SubmitResult {
	taskId: string;
}

export interface PollResult {
	status: "queued" | "running" | "success" | "failed";
	progress: number;
	resultUri?: string;
	error?: string;
}

export interface ModelAdapter {
	key: string;
	displayName: string;
	vendor: string;
	/** 该模型可服务的节点类型 */
	nodeTypes: NodeType[];
	modes: CapabilityMode[];
	/** 基准积分（单次/单位） */
	baseCost: number;
	estimateCost(modeKey: string, params: Record<string, unknown>): number;
	submit(
		input: Record<string, unknown>,
		params: Record<string, unknown>,
	): Promise<SubmitResult>;
	poll(taskId: string): Promise<PollResult>;
}

const registry = new Map<string, ModelAdapter>();

export function registerAdapter(adapter: ModelAdapter): void {
	registry.set(adapter.key, adapter);
}
export function getAdapter(key: string): ModelAdapter | undefined {
	return registry.get(key);
}
export function listAdapters(): ModelAdapter[] {
	return [...registry.values()];
}
/** 某节点类型可选的模型列表（底部面板的模型选择器数据源） */
export function listAdaptersForNodeType(type: NodeType): ModelAdapter[] {
	return [...registry.values()].filter((a) => a.nodeTypes.includes(type));
}

/** 本地联调用的 mock 提交/轮询，不真正调模型。 */
function mockIO(): Pick<ModelAdapter, "submit" | "poll"> {
	return {
		async submit() {
			const rand = Math.random().toString(36).slice(2, 8);
			return { taskId: `task-${Date.now().toString(36)}-${rand}` };
		},
		async poll() {
			return { status: "success", progress: 100, resultUri: "about:blank" };
		},
	};
}

function num(params: Record<string, unknown>, key: string, fallback: number) {
	const v = Number(params[key]);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** GVLM 3.1 — 文本创意节点（创意种子：剧情/场景/角色设定，派生文生视频/图片反推/文生音乐） */
export const gvlmTextAdapter: ModelAdapter = {
	key: "gvlm-text",
	displayName: "GVLM 3.1",
	vendor: "Lib",
	nodeTypes: ["text"],
	baseCost: 2,
	modes: [
		{
			key: "compose",
			label: "自己编写",
			inputHint: "直接输入创意文本，作为后续节点的创意种子",
			paramsSchema: [
				{
					key: "tone",
					label: "语气",
					type: "enum",
					options: ["中性", "悬疑", "热血", "治愈", "搞笑"],
					default: "中性",
				},
				{
					key: "length",
					label: "篇幅",
					type: "enum",
					options: ["短", "中", "长"],
					default: "中",
				},
			],
		},
		{
			key: "to-video-prompt",
			label: "文生视频提示",
			inputHint: "将创意扩写为可直接驱动视频生成的提示词",
			paramsSchema: [
				{
					key: "shotStyle",
					label: "镜头风格",
					type: "enum",
					options: ["电影感", "纪实", "动漫", "广告片"],
					default: "电影感",
				},
			],
		},
		{
			key: "image-reverse",
			label: "图片反推提示",
			inputHint: "从参考图片反推提示词",
			paramsSchema: [],
		},
		{
			key: "to-music-prompt",
			label: "文生音乐提示",
			inputHint: "生成用于音乐/音效节点的描述",
			paramsSchema: [
				{
					key: "mood",
					label: "情绪",
					type: "enum",
					options: ["舒缓", "紧张", "史诗", "温暖"],
					default: "舒缓",
				},
			],
		},
	],
	estimateCost() {
		return this.baseCost;
	},
	...mockIO(),
};

/** GVLM 3.1 — 脚本生成器（剧本→分镜脚本 / 角色→分镜脚本） */
export const gvlmScriptAdapter: ModelAdapter = {
	key: "gvlm-script",
	displayName: "GVLM 3.1",
	vendor: "Lib",
	nodeTypes: ["script"],
	baseCost: 6,
	modes: [
		{
			key: "script-to-shots",
			label: "剧本→分镜脚本",
			inputHint: "输入剧本/文案，生成可爆破的分镜脚本",
			paramsSchema: [
				{
					key: "shotCount",
					label: "分镜数量",
					type: "number",
					default: 6,
					min: 1,
					max: 30,
					step: 1,
				},
			],
		},
		{
			key: "role-to-shots",
			label: "角色→分镜脚本",
			inputHint: "从角色设定出发生成分镜脚本",
			paramsSchema: [
				{
					key: "shotCount",
					label: "分镜数量",
					type: "number",
					default: 6,
					min: 1,
					max: 30,
					step: 1,
				},
			],
		},
	],
	estimateCost() {
		return this.baseCost;
	},
	...mockIO(),
};

/** Lib Image — 图片节点（文生图 / 图生图编辑） */
export const libImageAdapter: ModelAdapter = {
	key: "lib-image",
	displayName: "Lib Image",
	vendor: "Lib",
	nodeTypes: ["image"],
	baseCost: 18,
	modes: [
		{
			key: "text2image",
			label: "文生图",
			inputHint: "根据提示词生成图片",
			paramsSchema: [
				{
					key: "style",
					label: "风格",
					type: "enum",
					options: ["写实", "动漫", "水彩", "赛博朗克", "国风"],
					default: "动漫",
				},
				{
					key: "ratio",
					label: "比例",
					type: "enum",
					options: ["自适应", "1:1", "16:9", "9:16", "4:3"],
					default: "自适应",
				},
				{
					key: "quality",
					label: "画质",
					type: "enum",
					options: ["标准", "高清", "2K"],
					default: "标准",
				},
				{
					key: "quantity",
					label: "数量",
					type: "number",
					default: 1,
					min: 1,
					max: 4,
					step: 1,
				},
			],
		},
		{
			key: "image2image",
			label: "图生图编辑",
			inputHint: "基于参考图做重绘/编辑",
			paramsSchema: [
				{
					key: "strength",
					label: "重绘强度",
					type: "number",
					default: 0.6,
					min: 0,
					max: 1,
					step: 0.05,
				},
				{
					key: "quality",
					label: "画质",
					type: "enum",
					options: ["标准", "高清", "2K"],
					default: "标准",
				},
				{
					key: "quantity",
					label: "数量",
					type: "number",
					default: 1,
					min: 1,
					max: 4,
					step: 1,
				},
			],
		},
	],
	estimateCost(_modeKey, params) {
		return this.baseCost * num(params, "quantity", 1);
	},
	...mockIO(),
};

const videoModes: CapabilityMode[] = [
	{
		key: "text2video",
		label: "文生视频",
		inputHint: "根据提示词生成视频",
		paramsSchema: videoParams(),
	},
	{
		key: "image2video",
		label: "图生视频",
		inputHint: "以上游图片节点作首帧生成视频",
		paramsSchema: videoParams(),
	},
	{
		key: "first-last-frame",
		label: "首尾帧",
		inputHint: "指定首/尾帧补间生成",
		paramsSchema: videoParams(),
	},
	{
		key: "omni-ref",
		label: "全能参考",
		inputHint: "多图/角色库参考生成",
		paramsSchema: videoParams(),
	},
];

function videoParams(): ParamField[] {
	return [
		{
			key: "ratio",
			label: "比例",
			type: "enum",
			options: ["16:9", "9:16", "1:1"],
			default: "16:9",
		},
		{
			key: "resolution",
			label: "分辨率",
			type: "enum",
			options: ["480P", "720P", "1080P"],
			default: "720P",
		},
		{
			key: "duration",
			label: "时长",
			type: "enum",
			options: ["5s", "10s"],
			default: "5s",
		},
		{
			key: "camera",
			label: "运镜",
			type: "enum",
			options: ["无", "推", "拉", "摇", "移"],
			default: "无",
		},
	];
}

function videoCost(base: number, params: Record<string, unknown>): number {
	const durFactor = params.duration === "10s" ? 2 : 1;
	const res = params.resolution;
	const resFactor = res === "1080P" ? 2 : res === "480P" ? 0.5 : 1;
	return Math.round(base * durFactor * resFactor);
}

/** Seedance 2.0 — 视频节点默认模型 */
export const seedanceAdapter: ModelAdapter = {
	key: "seedance-2",
	displayName: "Seedance 2.0",
	vendor: "ByteDance",
	nodeTypes: ["video"],
	baseCost: 135,
	modes: videoModes,
	estimateCost(_modeKey, params) {
		return videoCost(this.baseCost, params);
	},
	...mockIO(),
};

/** Kling 3.0 — 视频可选模型 */
export const klingAdapter: ModelAdapter = {
	key: "kling-3",
	displayName: "Kling 3.0",
	vendor: "Kuaishou",
	nodeTypes: ["video"],
	baseCost: 120,
	modes: videoModes,
	estimateCost(_modeKey, params) {
		return videoCost(this.baseCost, params);
	},
	...mockIO(),
};

/** Wan 2.6 — 视频可选模型 */
export const wanAdapter: ModelAdapter = {
	key: "wan-2",
	displayName: "Wan 2.6",
	vendor: "Alibaba",
	nodeTypes: ["video"],
	baseCost: 90,
	modes: videoModes,
	estimateCost(_modeKey, params) {
		return videoCost(this.baseCost, params);
	},
	...mockIO(),
};

/** Lib Audio — 音频节点（配音 / 音效 / BGM） */
export const libAudioAdapter: ModelAdapter = {
	key: "lib-audio",
	displayName: "Lib Audio",
	vendor: "Lib",
	nodeTypes: ["audio"],
	baseCost: 12,
	modes: [
		{
			key: "voice",
			label: "配音",
			inputHint: "文本转语音",
			paramsSchema: [
				{
					key: "voiceType",
					label: "音色",
					type: "enum",
					options: ["青年男", "青年女", "少年", "旁白"],
					default: "旁白",
				},
			],
		},
		{
			key: "sfx",
			label: "音效",
			inputHint: "生成环境/动效音效",
			paramsSchema: [
				{
					key: "duration",
					label: "时长",
					type: "number",
					default: 5,
					min: 1,
					max: 30,
					step: 1,
					unit: "s",
				},
			],
		},
		{
			key: "bgm",
			label: "BGM",
			inputHint: "生成背景音乐",
			paramsSchema: [
				{
					key: "mood",
					label: "情绪",
					type: "enum",
					options: ["舒缓", "紧张", "史诗", "温暖"],
					default: "舒缓",
				},
			],
		},
	],
	estimateCost() {
		return this.baseCost;
	},
	...mockIO(),
};

/** Phase 0 遗留：回声占位适配器，便于本地联调 */
export const mockAdapter: ModelAdapter = {
	key: "mock",
	displayName: "Mock 模型（占位）",
	vendor: "—",
	nodeTypes: [],
	baseCost: 1,
	modes: [
		{
			key: "echo",
			label: "回声",
			paramsSchema: [],
		},
	],
	estimateCost() {
		return this.baseCost;
	},
	...mockIO(),
};

for (const a of [
	gvlmTextAdapter,
	gvlmScriptAdapter,
	libImageAdapter,
	seedanceAdapter,
	klingAdapter,
	wanAdapter,
	libAudioAdapter,
	mockAdapter,
]) {
	registerAdapter(a);
}
