/**
 * 模型存储（文件持久化）—— 数据化的 catalog 模型 + 翻译格式。
 *
 * 每个模型带 protocol（决定走哪个翻译器）+ 上游覆盖（baseUrl/apiKey/upstreamModel）。
 * 管理端可自定义加载第三方模型、查看/编辑翻译格式。改动后 bump catalog 版本。
 */
import { loadJson, saveJson } from "./db.ts";
import type { ParamField, Capability } from "../contract.ts";

/** 翻译协议：决定 dispatch 路由到哪个翻译器 */
export type Protocol =
	| "echo"
	| "openai-chat"
	| "anthropic-messages"
	| "openai-image"
	| "gemini-image"
	| "jianmeng-video"
	| "stub";

export interface ModelDef {
	id: string;
	label: string;
	capability: Capability;
	protocol: Protocol;
	/** 发给上游的真实模型名（默认 = id） */
	upstreamModel?: string;
	/** 上游地址覆盖（默认走网关） */
	baseUrl?: string;
	/** 上游密钥覆盖（默认走网关 key）；管理端列表中脱敏 */
	apiKey?: string;
	params: ParamField[];
	cost: number;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

interface Store {
	version: number;
	models: ModelDef[];
}

const FILE = "models.json";

const TEXT_PARAMS: ParamField[] = [
	{ key: "temperature", label: "温度", type: "number", default: 0.7, min: 0, max: 2, step: 0.1 },
	{ key: "maxTokens", label: "最大长度", type: "number", default: 2048, min: 1, max: 8192, step: 256, unit: "tokens" },
];
const IMG_SIZE: ParamField = {
	key: "size",
	label: "尺寸",
	type: "enum",
	options: ["1024x1024", "2048x2048", "3840x2160", "2160x3840"],
	default: "1024x1024",
};
const ASPECT: ParamField = {
	key: "aspectRatio",
	label: "宽高比",
	type: "enum",
	options: ["1:1", "16:9", "9:16", "4:3", "3:4"],
	default: "1:1",
};

function def(
	id: string,
	label: string,
	capability: Capability,
	protocol: Protocol,
	params: ParamField[],
	cost: number,
	extra?: Partial<ModelDef>,
): ModelDef {
	const now = new Date().toISOString();
	return { id, label, capability, protocol, params, cost, enabled: true, createdAt: now, updatedAt: now, ...extra };
}

/** 简梦 JA 视频模型参数（秒计费档可调时长，15s 档固定）*/
const JA_VIDEO_PARAMS = (fixed15: boolean): ParamField[] => [
	{ key: "duration", label: "时长", type: "number", default: fixed15 ? 15 : 6, min: fixed15 ? 15 : 4, max: 15, step: 1, unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16", "1:1", "21:9", "3:4", "4:3"], default: "16:9" },
];

/** 简梦 JA 视频默认模型（baseUrl 走 config.jianmeng；apiKey 由管理端/环境 JIANMENG_API_KEY 提供） */
const JIANMENG_VIDEO_MODELS: ModelDef[] = [
	def("JA-sd2-fast-720", "简梦 Seedance2 快速 720p", "video", "jianmeng-video", JA_VIDEO_PARAMS(false), 30),
	def("JA-sd2-fast-480", "简梦 Seedance2 快速 480p", "video", "jianmeng-video", JA_VIDEO_PARAMS(false), 20),
	def("JA-sd2-pro-720", "简梦 Seedance2 专业 720p", "video", "jianmeng-video", JA_VIDEO_PARAMS(false), 45),
	def("JA-sd2-pro-480", "简梦 Seedance2 专业 480p", "video", "jianmeng-video", JA_VIDEO_PARAMS(false), 30),
	def("JA-sd2-fast-15s", "简梦 Seedance2 快速 15s", "video", "jianmeng-video", JA_VIDEO_PARAMS(true), 40),
	def("JA-sd2-pro-15s", "简梦 Seedance2 专业 15s", "video", "jianmeng-video", JA_VIDEO_PARAMS(true), 60),
	def("JA-sd2-pro-1080p", "简梦 Seedance2 1080p · 15s", "video", "jianmeng-video", JA_VIDEO_PARAMS(true), 90),
];

const DEFAULT_MODELS: ModelDef[] = [
	def("echo-text", "回声文本（联调）", "text", "echo", [], 1),
	def("stub-image", "占位生图（联调）", "image", "stub", [IMG_SIZE], 1),
	def("gpt-5.5", "GPT-5.5", "text", "openai-chat", TEXT_PARAMS, 10),
	def("gpt-5.4", "GPT-5.4", "text", "openai-chat", TEXT_PARAMS, 8),
	def("gpt-5.4-mini", "GPT-5.4 mini", "text", "openai-chat", TEXT_PARAMS, 4),
	def("gpt-5.3-codex", "GPT-5.3 Codex", "text", "openai-chat", TEXT_PARAMS, 8),
	def("claude-opus-4-7", "Claude Opus 4.7", "text", "anthropic-messages", [], 12),
	def("claude-sonnet-4-6", "Claude Sonnet 4.6", "text", "anthropic-messages", [], 6),
	def("claude-haiku-4-5-20251001", "Claude Haiku 4.5", "text", "anthropic-messages", [], 3),
	def("gpt-image-2", "GPT Image 2", "image", "openai-image", [IMG_SIZE], 20),
	def("gemini-3-pro-image-preview", "Gemini 3 Pro Image（香蕉 Pro）", "image", "gemini-image", [ASPECT], 18),
	def("gemini-3.1-flash-image-preview", "Gemini 3.1 Flash Image（香蕉 2）", "image", "gemini-image", [ASPECT], 9),
	def("stub-video", "占位视频（联调）", "video", "stub", [
		{ key: "duration", label: "时长", type: "number", default: 4, min: 4, max: 15, step: 1, unit: "s" },
		{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16", "1:1"], default: "16:9" },
	], 9),
	def("stub-audio", "占位音频（联调）", "audio", "stub", [], 12),
	...JIANMENG_VIDEO_MODELS,
];

let store: Store = loadJson<Store>(FILE, { version: 0, models: [] });
if (store.models.length === 0) {
	store = { version: 1, models: DEFAULT_MODELS };
	saveJson(FILE, store);
} else {
	// 迁移：补种缺失的内置模型（如简梦视频），不覆盖管理端已有改动
	let changed = false;
	for (const d of DEFAULT_MODELS) {
		if (!store.models.some((m) => m.id === d.id)) {
			store.models.push(d);
			changed = true;
		}
	}
	if (changed) persist();
}

function persist(bump = true): void {
	if (bump) store.version += 1;
	saveJson(FILE, store);
}

export function catalogVersion(): string {
	return `v${store.version}`;
}

export function listModels(): ModelDef[] {
	return store.models;
}

export function listEnabledModels(): ModelDef[] {
	return store.models.filter((m) => m.enabled);
}

export function getModelDef(id: string): ModelDef | undefined {
	return store.models.find((m) => m.id === id);
}

export function createModel(input: Partial<ModelDef> & Pick<ModelDef, "id" | "label" | "capability" | "protocol">): ModelDef {
	const now = new Date().toISOString();
	const m: ModelDef = {
		id: input.id.trim(),
		label: input.label,
		capability: input.capability,
		protocol: input.protocol,
		upstreamModel: input.upstreamModel || undefined,
		baseUrl: input.baseUrl || undefined,
		apiKey: input.apiKey || undefined,
		params: input.params ?? [],
		cost: input.cost ?? 10,
		enabled: input.enabled ?? true,
		createdAt: now,
		updatedAt: now,
	};
	const idx = store.models.findIndex((x) => x.id === m.id);
	if (idx >= 0) store.models[idx] = m;
	else store.models.push(m);
	persist();
	return m;
}

export function updateModel(id: string, patch: Partial<Omit<ModelDef, "id" | "createdAt">>): ModelDef | undefined {
	const m = getModelDef(id);
	if (!m) return undefined;
	Object.assign(m, patch, { updatedAt: new Date().toISOString() });
	persist();
	return m;
}

export function deleteModel(id: string): boolean {
	const before = store.models.length;
	store.models = store.models.filter((m) => m.id !== id);
	if (store.models.length !== before) {
		persist();
		return true;
	}
	return false;
}
