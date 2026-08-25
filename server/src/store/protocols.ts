/**
 * protocols.ts —— 自定义协议（「翻译官招募市场」）。
 *
 * 背景：模型的 `protocol` 字段决定用哪个「翻译官」把客户端请求翻成上游 API 调用。
 * 内置 9 个翻译官（echo/openai-chat/…）写死在 translators/ 里；本 store 提供**数据驱动**的
 * 自定义翻译官——管理端配请求模板 + 响应取值路径 + 轮询规则，dispatch 交给通用引擎
 * （translators/custom.ts）按数据执行。模型 `protocol` = 自定义协议 id 即启用。
 *
 * 与 models/templates 同范式：JSON 落盘 `data/protocols.json` + version 自增（管理端热更）。
 * 协议为服务端内部概念，不下发客户端 catalog。
 */
import { loadJson, saveJson } from "./db.ts";
import type { Capability } from "../contract.ts";

/** 内置协议 id（只读展示，不可增删改；模型协议下拉里恒列出） */
export const BUILTIN_PROTOCOLS = [
	"echo", "openai-chat", "anthropic-messages",
	"openai-image", "gemini-image",
	"jianmeng-video", "openai-video", "volc-mediakit", "sudashui-video", "aistars-video", "aistars-image", "huaying-video", "dimensio-video", "aivide-video", "jianmengp-video", "musem-video", "jmz-video", "jmz-image", "jmt-video", "jmf-video", "overseas-video", "suanli-video", "jmh-image", "jmh-video", "yali-image", "skylee-image", "congge-image", "congge-video", "autodl-video", "qijicloud-comfy", "bys-video", "qiqi-video", "stub",
] as const;
const BUILTIN_SET = new Set<string>(BUILTIN_PROTOCOLS);
export function isBuiltinProtocol(id: string): boolean {
	return BUILTIN_SET.has(id);
}

/**
 * 执行方式：
 *  - sync            一次请求即拿最终结果（文本）——走文本任务，textPath 取正文。
 *  - async-immediate 一次请求即拿最终资产链接（图/音/视频一次性）——assetUrlPath 取链接，下载落资产。
 *  - async-poll      submit 拿 taskId → 轮询直到完成（视频/异步图像）——taskIdPath + poll.*。
 */
export type ProtocolMode = "sync" | "async-immediate" | "async-poll";

export interface ProtocolRequest {
	method: "POST" | "GET";
	/** 相对 baseUrl 的路径，可含 {{变量}}（如 /v1/chat/completions） */
	path: string;
	/** 请求头，值可含 {{变量}}（如 Authorization: "Bearer {{apiKey}}"） */
	headers: Record<string, string>;
	/** 请求体 JSON 模板串，含 {{变量}}；GET 忽略。引号内 "{{x}}" 自动转义，裸 {{x}} 原样插入 */
	body?: string;
}

export interface ProtocolResponse {
	/** sync：正文所在点路径（如 choices.0.message.content） */
	textPath?: string;
	/** async-immediate / async-poll 完成：结果资产链接的点路径 */
	assetUrlPath?: string;
	/** async-poll：submit 响应里的上游任务 id 点路径 */
	taskIdPath?: string;
	/** 错误信息点路径（HTTP 非 2xx 或失败时取） */
	errorPath?: string;
}

export interface ProtocolPoll {
	method: "POST" | "GET";
	/** 轮询路径，可含 {{taskId}} */
	path: string;
	headers: Record<string, string>;
	body?: string;
	/** 状态点路径 */
	statusPath: string;
	/** 状态值命中即成功（如 completed / succeeded） */
	successWhen: string;
	/** 状态值命中即失败（如 failed / error） */
	failWhen?: string;
	/** 进度点路径（0-100 或 0-1；可空） */
	progressPath?: string;
	/** 完成时结果资产链接点路径（不填沿用 response.assetUrlPath） */
	assetUrlPath?: string;
	/** 完成时封面链接点路径（视频用，可空） */
	coverPath?: string;
	errorPath?: string;
	/** 轮询间隔/超时（毫秒）；缺省 8000 / 视频 2h */
	intervalMs?: number;
	timeoutMs?: number;
}

export interface CustomProtocol {
	id: string;
	name: string;
	capability: Capability;
	mode: ProtocolMode;
	enabled: boolean;
	request: ProtocolRequest;
	response: ProtocolResponse;
	/** 仅 async-poll */
	poll?: ProtocolPoll;
	note?: string;
	createdAt: string;
	updatedAt: string;
}

interface Store {
	version: number;
	protocols: CustomProtocol[];
}

const FILE = "protocols.json";
let store: Store = loadJson<Store>(FILE, { version: 0, protocols: [] });
if (store.version === 0) {
	store = { version: 1, protocols: [] };
	saveJson(FILE, store);
}

function persist(bump = true): void {
	if (bump) store.version += 1;
	saveJson(FILE, store);
}

export function protocolsVersion(): number {
	return store.version;
}

export function listProtocols(): CustomProtocol[] {
	return store.protocols;
}

export function listEnabledProtocols(): CustomProtocol[] {
	return store.protocols.filter((p) => p.enabled);
}

export function getProtocolDef(id: string): CustomProtocol | undefined {
	return store.protocols.find((p) => p.id === id);
}

function normalizeReq(r: Partial<ProtocolRequest> | undefined): ProtocolRequest {
	return {
		method: r?.method === "GET" ? "GET" : "POST",
		path: (r?.path || "").trim(),
		headers: r?.headers && typeof r.headers === "object" ? r.headers : {},
		body: r?.body || undefined,
	};
}
function normalizePoll(p: Partial<ProtocolPoll> | undefined): ProtocolPoll | undefined {
	if (!p) return undefined;
	return {
		method: p.method === "POST" ? "POST" : "GET",
		path: (p.path || "").trim(),
		headers: p.headers && typeof p.headers === "object" ? p.headers : {},
		body: p.body || undefined,
		statusPath: (p.statusPath || "status").trim(),
		successWhen: (p.successWhen || "").trim(),
		failWhen: p.failWhen?.trim() || undefined,
		progressPath: p.progressPath?.trim() || undefined,
		assetUrlPath: p.assetUrlPath?.trim() || undefined,
		coverPath: p.coverPath?.trim() || undefined,
		errorPath: p.errorPath?.trim() || undefined,
		intervalMs: p.intervalMs != null ? Number(p.intervalMs) : undefined,
		timeoutMs: p.timeoutMs != null ? Number(p.timeoutMs) : undefined,
	};
}

export function createProtocol(
	input: Partial<CustomProtocol> & Pick<CustomProtocol, "id" | "name" | "capability" | "mode">,
): CustomProtocol {
	const id = input.id.trim();
	if (isBuiltinProtocol(id)) throw new Error(`协议 id 与内置协议冲突：${id}`);
	const now = new Date().toISOString();
	const p: CustomProtocol = {
		id,
		name: input.name.trim(),
		capability: input.capability,
		mode: input.mode,
		enabled: input.enabled ?? true,
		request: normalizeReq(input.request),
		response: {
			textPath: input.response?.textPath?.trim() || undefined,
			assetUrlPath: input.response?.assetUrlPath?.trim() || undefined,
			taskIdPath: input.response?.taskIdPath?.trim() || undefined,
			errorPath: input.response?.errorPath?.trim() || undefined,
		},
		poll: input.mode === "async-poll" ? normalizePoll(input.poll) : undefined,
		note: input.note?.trim() || undefined,
		createdAt: now,
		updatedAt: now,
	};
	const idx = store.protocols.findIndex((x) => x.id === p.id);
	if (idx >= 0) store.protocols[idx] = p;
	else store.protocols.push(p);
	persist();
	return p;
}

export function updateProtocol(id: string, patch: Partial<CustomProtocol>): CustomProtocol | undefined {
	const p = getProtocolDef(id);
	if (!p) return undefined;
	const next: CustomProtocol = { ...p };
	if (patch.name != null) next.name = String(patch.name).trim();
	if (patch.capability != null) next.capability = patch.capability;
	if (patch.mode != null) next.mode = patch.mode;
	if (patch.enabled != null) next.enabled = !!patch.enabled;
	if (patch.request) next.request = normalizeReq(patch.request);
	if (patch.response) next.response = {
		textPath: patch.response.textPath?.trim() || undefined,
		assetUrlPath: patch.response.assetUrlPath?.trim() || undefined,
		taskIdPath: patch.response.taskIdPath?.trim() || undefined,
		errorPath: patch.response.errorPath?.trim() || undefined,
	};
	if (patch.poll !== undefined) next.poll = normalizePoll(patch.poll || undefined);
	if (patch.note !== undefined) next.note = patch.note?.trim() || undefined;
	if (next.mode !== "async-poll") next.poll = undefined;
	next.updatedAt = new Date().toISOString();
	const idx = store.protocols.findIndex((x) => x.id === id);
	store.protocols[idx] = next;
	persist();
	return next;
}

export function deleteProtocol(id: string): boolean {
	const before = store.protocols.length;
	store.protocols = store.protocols.filter((p) => p.id !== id);
	if (store.protocols.length === before) return false;
	persist();
	return true;
}
