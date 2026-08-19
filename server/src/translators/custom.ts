/**
 * custom.ts —— 通用「翻译官」引擎：按自定义协议（store/protocols.ts）的数据配置执行上游调用。
 *
 * 三种执行方式（由协议 mode 决定）：
 *  - sync            请求 → response.textPath 取正文（文本）。
 *  - async-immediate 请求 → response.assetUrlPath 取链接 → 下载字节（图/音/视频一次性）。
 *  - async-poll      请求(submit) → response.taskIdPath 取任务 id；poll.* 轮询直到 successWhen。
 *
 * 模板：path/headers/body 里的 {{变量}} 用请求上下文替换。可用变量：
 *   apiKey / baseUrl / upstreamModel / prompt / taskId(轮询)，以及 params.* / variables.*。
 * body 为 JSON 串：引号内 "{{x}}" 自动 JSON 转义（安全塞任意文本），裸 {{x}} 原样插入（数字/布尔/片段）。
 */
import type { GenerateRequest } from "../contract.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import type { OnUpstream, ImageResult } from "./openai.ts";
import { resolveNamed, injectReferenceTags, type VideoSubmit, type VideoPoll } from "./jianmeng.ts";
import type { CustomProtocol } from "../store/protocols.ts";

// 第169轮：提交/同步生成类请求改走共享安全闸 submitSignal()（取消短超时，勿回退）；
// 轮询与结果下载保留各自短超时（轮询瞬时失败由上层循环重试、下载失败即明确报错）。
const POLL_TIMEOUT_MS = 120000;
const DOWNLOAD_TIMEOUT_MS = 120000;

type Ctx = Record<string, unknown>;

function buildCtx(req: GenerateRequest, up: Upstream, extra?: Ctx): Ctx {
	// 垫素材三模态全暴露：按「id 是真理，url 是缓存」解析（id→资产台账 OSS 永久直链，url 兜底，
	// 拒收 .localhost 伪域）——与内置视频翻译器同一把闸（resolveNamed），保证发上游的链接公网可达且不过期。
	const images = resolveNamed(req.inputs?.images);
	const videos = resolveNamed(req.inputs?.videos);
	const audios = resolveNamed(req.inputs?.audios);
	const prompt = String(req.variables?.prompt ?? req.promptOverride ?? "");
	return {
		apiKey: up.apiKey,
		baseUrl: up.baseUrl,
		upstreamModel: up.upstreamModel,
		prompt,
		// prompt 自动注入 @ImageN/@VideoN/@AudioN 引用（简梦式上游需要 @tag 素材才生效；已有引用则幂等跳过）
		promptTagged: injectReferenceTags(prompt, { images, videos, audios }),
		inputs: {
			// 裸 {{inputs.imageUrls}} → JSON 数组；{{inputs.imageUrls.0}} → 第一条链接（首帧/单图上游）
			imageUrls: images.map((x) => x.url),
			videoUrls: videos.map((x) => x.url),
			audioUrls: audios.map((x) => x.url),
			imageCount: images.length,
			videoCount: videos.length,
			audioCount: audios.length,
		},
		params: (req.params ?? {}) as Ctx,
		variables: (req.variables ?? {}) as Ctx,
		...extra,
	};
}

/** 点路径取值：a.b.0.c（数组下标为数字段）；取不到返回 undefined */
export function pickPath(obj: unknown, path?: string): unknown {
	if (!path) return undefined;
	let cur: unknown = obj;
	for (const seg of path.split(".")) {
		if (cur == null) return undefined;
		if (Array.isArray(cur)) cur = cur[Number(seg)];
		else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
		else return undefined;
	}
	return cur;
}

function valAt(ctx: Ctx, expr: string): unknown {
	return pickPath(ctx, expr.trim());
}

/** 非 JSON 场景（path/headers）：{{x}} → 值的字符串形式 */
function interpPlain(tpl: string, ctx: Ctx): string {
	return tpl.replace(/\{\{([^}]+)\}\}/g, (_m, expr) => {
		const v = valAt(ctx, expr);
		return v == null ? "" : String(v);
	});
}

/** JSON body 场景：引号内 "{{x}}" → JSON 转义(无外引号)；裸 {{x}} → JSON.stringify(值) */
function interpJson(tpl: string, ctx: Ctx): string {
	return tpl.replace(/\{\{([^}]+)\}\}/g, (m, expr, offset: number) => {
		const v = valAt(ctx, expr);
		const before = tpl[offset - 1];
		const after = tpl[offset + m.length];
		const quoted = before === '"' && after === '"';
		if (quoted) {
			// 处于字符串字面量内 → 转义内容、去掉 JSON.stringify 的外层引号
			return JSON.stringify(v == null ? "" : String(v)).slice(1, -1);
		}
		// 裸位置（数字/布尔/对象片段）：字符串也给合法 JSON 值
		if (v == null) return "null";
		if (typeof v === "string") return JSON.stringify(v);
		return JSON.stringify(v);
	});
}

function mapHeaders(headers: Record<string, string>, ctx: Ctx): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(headers || {})) out[k] = interpPlain(val, ctx);
	return out;
}

const maskToken = (t: string) => (t && t.length > 8 ? `${t.slice(0, 4)}****${t.slice(-4)}` : t ? "****" : "");
/** 日志脱敏：请求头里出现的 apiKey 明文替换成掩码 */
function maskHeaders(headers: Record<string, string>, apiKey: string): Record<string, string> {
	if (!apiKey) return headers;
	const masked = maskToken(apiKey);
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) out[k] = v.split(apiKey).join(masked);
	return out;
}

const tryJson = (s?: string) => { if (!s) return undefined; try { return JSON.parse(s); } catch { return s; } };

interface HttpOut { ok: boolean; status: number; data: unknown; }
async function doRequest(
	baseUrl: string, method: "POST" | "GET", pathTpl: string,
	headersTpl: Record<string, string>, bodyTpl: string | undefined,
	ctx: Ctx, apiKey: string, onUpstream?: OnUpstream, timeoutMs?: number,
): Promise<HttpOut> {
	const url = baseUrl + interpPlain(pathTpl, ctx);
	const headers = mapHeaders(headersTpl, ctx);
	const body = method === "POST" && bodyTpl ? interpJson(bodyTpl, ctx) : undefined;
	onUpstream?.({ request: { url, method, headers: maskHeaders(headers, apiKey), body: tryJson(body) } });
	// timeoutMs 未传 = 提交语义（走共享安全闸）；轮询显式传 POLL_TIMEOUT_MS
	const resp = await fetch(url, { method, headers, body, signal: timeoutMs != null ? AbortSignal.timeout(timeoutMs) : submitSignal() });
	const raw = await resp.text();
	const data = tryJson(raw);
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	return { ok: resp.ok, status: resp.status, data };
}

const errFrom = (data: unknown, path: string | undefined, status: number): string => {
	const e = pickPath(data, path);
	return (e != null ? String(e) : "") || `上游返回 HTTP ${status}`;
};

// ─────────────── sync 文本 ───────────────
export interface CustomTextOutcome { status: "success" | "failed"; result?: { text: string }; error?: string; }
export async function runCustomText(
	req: GenerateRequest, up: Upstream, proto: CustomProtocol,
	onDelta?: (full: string) => void, onUpstream?: OnUpstream,
): Promise<CustomTextOutcome> {
	const ctx = buildCtx(req, up);
	const r = await doRequest(up.baseUrl, proto.request.method, proto.request.path, proto.request.headers, proto.request.body, ctx, up.apiKey, onUpstream);
	if (!r.ok) return { status: "failed", error: errFrom(r.data, proto.response.errorPath, r.status) };
	const text = pickPath(r.data, proto.response.textPath);
	if (text == null) return { status: "failed", error: `未从响应取到正文（textPath=${proto.response.textPath || "未配置"}）` };
	const s = String(text);
	onDelta?.(s);
	return { status: "success", result: { text: s } };
}

// ─────────────── async-immediate 一次性资产（下载字节，交给 createImageTask 落资产） ───────────────
export async function runCustomImmediate(
	req: GenerateRequest, up: Upstream, proto: CustomProtocol, onUpstream?: OnUpstream,
): Promise<ImageResult> {
	const ctx = buildCtx(req, up);
	const r = await doRequest(up.baseUrl, proto.request.method, proto.request.path, proto.request.headers, proto.request.body, ctx, up.apiKey, onUpstream);
	if (!r.ok) return { ok: false, error: errFrom(r.data, proto.response.errorPath, r.status) };
	const link = pickPath(r.data, proto.response.assetUrlPath);
	if (typeof link !== "string" || !link) return { ok: false, error: `未从响应取到资产链接（assetUrlPath=${proto.response.assetUrlPath || "未配置"}）` };
	try {
		const dl = await fetch(link, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
		if (!dl.ok) return { ok: false, error: `下载结果资产 HTTP ${dl.status}` };
		const contentType = dl.headers.get("content-type") || "application/octet-stream";
		const data = Buffer.from(await dl.arrayBuffer());
		return { ok: true, data, contentType };
	} catch (e) {
		return { ok: false, error: `下载结果资产失败：${(e as Error).message}` };
	}
}

// ─────────────── async-poll（视频/异步资产：submit → poll） ───────────────
export async function customSubmit(
	req: GenerateRequest, up: Upstream, proto: CustomProtocol, onUpstream?: OnUpstream,
): Promise<VideoSubmit> {
	const ctx = buildCtx(req, up);
	const r = await doRequest(up.baseUrl, proto.request.method, proto.request.path, proto.request.headers, proto.request.body, ctx, up.apiKey, onUpstream);
	if (!r.ok) return { ok: false, error: errFrom(r.data, proto.response.errorPath, r.status) };
	const taskId = pickPath(r.data, proto.response.taskIdPath);
	if (taskId == null || taskId === "") return { ok: false, error: `未从响应取到任务 id（taskIdPath=${proto.response.taskIdPath || "未配置"}）` };
	return { ok: true, taskId: String(taskId) };
}

export async function customPoll(
	up: Upstream, taskId: string, proto: CustomProtocol, onUpstream?: OnUpstream,
): Promise<VideoPoll> {
	const poll = proto.poll;
	if (!poll) return { status: "failed", error: "协议缺少轮询配置" };
	const ctx = buildCtx({} as GenerateRequest, up, { taskId });
	const r = await doRequest(up.baseUrl, poll.method, poll.path, poll.headers, poll.body, ctx, up.apiKey, onUpstream, POLL_TIMEOUT_MS);
	if (!r.ok) return { status: "failed", error: errFrom(r.data, poll.errorPath, r.status) };
	const status = String(pickPath(r.data, poll.statusPath) ?? "");
	if (poll.failWhen && status === poll.failWhen) {
		return { status: "failed", error: errFrom(r.data, poll.errorPath, r.status) || `上游状态：${status}` };
	}
	if (status === poll.successWhen) {
		const link = pickPath(r.data, poll.assetUrlPath || proto.response.assetUrlPath);
		if (typeof link !== "string" || !link) return { status: "failed", error: "完成但未取到结果资产链接（assetUrlPath）" };
		const cover = pickPath(r.data, poll.coverPath);
		return { status: "completed", videoUrl: link, coverUrl: typeof cover === "string" ? cover : undefined };
	}
	const rawProg = Number(pickPath(r.data, poll.progressPath));
	const progress = Number.isFinite(rawProg) ? (rawProg <= 1 ? Math.round(rawProg * 100) : Math.round(rawProg)) : 0;
	return { status: "running", progress };
}
