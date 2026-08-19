/**
 * 简梦H（ZhengAPI zhengapi.top）图片渠道翻译器（第154轮接入，同步单请求——复用 createImageTask 图片管线）。
 *
 * 上游架构（按官方「ZhengAPI 图片生成接口文档」，2026-07 版；Base `https://zhengapi.top`，Bearer）——两种形态：
 *   ① grok 系（grok-imagine-1.0 / -edit）：`POST /v1/images/generations`（OpenAI images 风格，同步）
 *      body { model, prompt, n:1, image?(⚠ **纯 base64 无 data: 前缀**，单张) } → { data:[{ url | b64_json }] }。
 *      -edit 为图生图专用变体（无图明确报错）；⚠ image 是单值字段——多图无处安放，>1 张明确报错绝不静默丢。
 *   ② firefly 系（nano-banana/-pro/nano-banana2/gpt-image）：`POST /v1/chat/completions`——
 *      **模型 ID 拼分辨率+比例**：`{基名}-{1k|2k|4k}-{比例 x 形}`（如 firefly-nano-banana-2k-16x9；
 *      比例档按家族各异，见 FIREFLY_RATIOS；分辨率=我方 resolution 档）；管理端自建若已带完整后缀不重复拼。
 *      messages 多模态：image_url 项在前（**data:image/...;base64 含前缀**，公网 URL 未文档化 → 服务端取字节内联）、
 *      text 在后；文档主线是 SSE 流式，但注意事项④明示 **stream:false 非流式同样可用**（同站 grok 视频终端文档
 *      更是把同步路径列为推荐）→ 我们走 stream:false 单响应（零 SSE 解析面），从 choices[0].message.content
 *      提取图片 URL（直链 / markdown ![image](url) / 相对路径 /v1/... 需拼 baseUrl 三形态都吃）再下载落资产
 *      （下载按文档示例裸 GET 不带鉴权头）；错误三形态：HTTP 错误体 {error:{message}} / 200 信封 error /
 *      reasoning_content 带 ❌ 标记；content 无 URL=明确失败带摘录（报错优于编造）。
 *   参考图张数：firefly 未文档化上限（chat 形态天然收多张、按序传入）→ 不本地拦（上游兜底，待真机实锤
 *   是否全部参考）；grok 恒 ≤1。提示词注入 @Image 图例作普通说明文字（该家图片接口无引用语法）。
 *   价格未公布 → 全员按次占位价（管理端定真价）。视频（grok/sora/veo/kling/runway 系 chat 流式）本轮**未接**
 *   ——用户指令为图片渠道；要接视频另起一轮（同站同鉴权，走 SSE/同步 chat 形态）。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import { resolveNamed, injectReferenceTags } from "./jianmeng.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import { numberParam, stringParam } from "./paramPass.ts";
import { resolveContentType } from "./contentType.ts";
import type { OnUpstream, ImageResult } from "./openai.ts";
import type { GenerateRequest } from "../contract.ts";

/** firefly 家族比例档（文档「模型 ID 命名规则」表；键=基名匹配段）。比例串用 : 存、拼 ID 时换 x */
const FIREFLY_RATIOS: { match: (m: string) => boolean; ratios: string[] }[] = [
	{ match: (m) => m.includes("nano-banana2"), ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9", "3:2", "5:4", "4:5", "2:3", "8:1", "1:4", "1:8"] },
	{ match: (m) => m.includes("gpt-image"), ratios: ["1:1", "16:9", "9:16", "21:9", "4:3", "3:2", "4:5", "3:4", "2:3", "5:4"] },
	{ match: () => true, ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9", "5:4", "4:5"] }, // nano-banana / pro / 未知 firefly
];
/** 已带完整后缀（-1k-16x9 / -auto 等）的自建上游名不重复拼 */
const FULL_ID_RE = /-(1k|2k|4k)-(auto|\d+x\d+)$/i;

/** "WxH"/"W:H" → 数值宽高比 */
function aspectValOf(s: string): number | null {
	const m = s.match(/^(\d+)\s*[x:×]\s*(\d+)$/i);
	if (!m) return null;
	const w = Number(m[1]), h = Number(m[2]);
	return w > 0 && h > 0 ? w / h : null;
}
/** 像素尺寸/比例串 → 家族档里最接近的比例（按宽高比数值距离；解析不出回退 1:1） */
function nearestRatio(sizeRaw: string, allowed: string[]): string {
	if (allowed.includes(sizeRaw)) return sizeRaw;
	const a = aspectValOf(sizeRaw);
	if (a == null) return allowed.includes("1:1") ? "1:1" : allowed[0];
	return allowed.reduce((best, r) => (Math.abs(aspectValOf(r)! - a) < Math.abs(aspectValOf(best)! - a) ? r : best), allowed[0]);
}

/** 取参考图字节 → base64（垫图发前内联；不可达明确报错指名，绝不静默丢——防 @Image 图例错位） */
async function fetchRefB64(ref: { url: string; name?: string }, idx: number): Promise<{ ok: true; b64: string; mime: string } | { ok: false; error: string }> {
	try {
		const r = await fetch(ref.url, { signal: AbortSignal.timeout(60000) });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const mime = (r.headers.get("content-type") || "image/png").split(";")[0].trim();
		const buf = Buffer.from(await r.arrayBuffer());
		return { ok: true, b64: buf.toString("base64"), mime };
	} catch (e) {
		return { ok: false, error: `参考图无法获取：第${idx + 1}张「${ref.name || ref.url.slice(0, 60)}」（${(e as Error).message}）——请重新上传素材后重试` };
	}
}

/** 从 chat content 提取图片 URL：markdown ![..](url) > 直链 > 相对路径 /v1/...（拼 baseUrl） */
function extractImageUrl(content: string, baseUrl: string): string | null {
	const md = content.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
	if (md) return md[1];
	const direct = content.match(/https?:\/\/[^\s<>"'`)\]]+/);
	if (direct) return direct[0];
	const rel = content.match(/\/v1\/[^\s<>"'`)\]]+/);
	if (rel) return `${baseUrl}${rel[0]}`;
	return null;
}

/** 上游错误 → 人话（错误体 {error:{message,code,type}}；401/429 等映射） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const msg = (typeof data?.error === "string" ? data.error : data?.error?.message) || data?.message || "";
	if (httpStatus === 401 || httpStatus === 403) return `简梦H 上游密钥无效或无权限${msg ? `：${msg}` : ""}，请联系运营检查渠道密钥`;
	if (httpStatus === 402) return "简梦H 上游额度不足，请联系运营充值后重试";
	if (httpStatus === 429) return "简梦H 上游请求过频或额度暂不可用，请稍后重试";
	if (httpStatus === 503) return "简梦H 上游队列已满，请稍后重试";
	if (msg) return String(msg);
	return `${fallback} HTTP ${httpStatus}`;
}

/**
 * 结果 URL → 下载字节（文档示例裸 GET 不带鉴权；直链有时效，拿到立即下载落资产）。
 * ⚠ 多次尝试（勿改回单次）：该站结果托管 AWS s3-accelerate 海外直链，国内机房对该域名的
 * TLS 握手呈**间歇性黑洞**（2026-07-23 生产实测：同机同域名 7.7s 成功与 30s 挂死交替，
 * 而通用国际出口 1.2MB/s 正常）——挂住的连接等多久都不会活，换新连接重试才有效。
 * 故前几次短超时快速失败换连接、末次长超时兜底；仅超时/网络错误/5xx 重试，4xx（签名过期等）终态。
 */
async function downloadResult(url: string, kind: "image" | "video" = "image"): Promise<ImageResult> {
	const label = kind === "video" ? "简梦H 成片下载失败" : "简梦H 结果下载失败";
	const timeouts = kind === "video" ? [120000, 120000, 300000] : [60000, 60000, 180000];
	let lastErr = "";
	for (const ms of timeouts) {
		try {
			const resp = await fetch(url, { signal: AbortSignal.timeout(ms) });
			if (!resp.ok) {
				lastErr = `HTTP ${resp.status}`;
				if (resp.status < 500) return { ok: false, error: `${label}：HTTP ${resp.status}` };
				continue; // 5xx=边缘节点瞬时故障，换连接再试
			}
			const contentType = resolveContentType(resp.headers.get("content-type"), kind === "video" ? "video/mp4" : "image/png");
			// arrayBuffer 也在 try 内：正文阶段超时中断同样按可重试处理（旧版漏在 try 外会裸抛英文错误）
			return { ok: true, data: Buffer.from(await resp.arrayBuffer()), contentType };
		} catch (e) {
			lastErr = (e as Error).message;
		}
	}
	return { ok: false, error: `${label}：${timeouts.length} 次尝试均未完成（${lastErr}）——结果托管在 AWS 海外直链，国内线路间歇不通，请重试本次生成` };
}

const b64Mime = (b64: string): string => (b64.startsWith("/9j/") ? "image/jpeg" : "image/png");

/** 图片生成（同步单请求）：grok 系走 /v1/images/generations、firefly 系走 /v1/chat/completions（stream:false） */
export async function translateJmhImage(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<ImageResult> {
	if (!up.apiKey) {
		return { ok: false, error: "简梦H 未配置上游密钥（管理端「简梦H（ZhengAPI）」渠道或环境 JMH_API_KEY）" };
	}
	const imgs = resolveNamed(req.inputs?.images);
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs });
	const headers = { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` };
	const logHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` };

	if (up.upstreamModel.startsWith("firefly-")) {
		// ── firefly 系：chat/completions + 模型 ID 拼 分辨率+比例 后缀 ──
		let model = up.upstreamModel;
		if (!FULL_ID_RE.test(model)) {
			const res = ["1k", "2k", "4k"].includes(String(req.params?.resolution ?? "").toLowerCase())
				? String(req.params!.resolution).toLowerCase()
				: "2k";
			const ratios = FIREFLY_RATIOS.find((f) => f.match(model))!.ratios;
			const ratio = nearestRatio(String(req.params?.size ?? ""), ratios).replace(":", "x");
			model = `${model}-${res}-${ratio}`;
		}
		// 参考图 → data URI 内联（文档口径 base64 含前缀；公网 URL 未文档化不赌）；按序在前、text 收尾
		const content: any[] = [];
		for (let i = 0; i < imgs.length; i++) {
			const r = await fetchRefB64(imgs[i], i);
			if (!r.ok) return { ok: false, error: r.error };
			content.push({ type: "image_url", image_url: { url: `data:${r.mime};base64,${r.b64}` } });
		}
		content.push({ type: "text", text: prompt });
		const body = { model, messages: [{ role: "user", content }], stream: false };

		onUpstream?.({ request: { url: `${up.baseUrl}/v1/chat/completions`, method: "POST", headers: logHeaders, body: { ...body, messages: [{ role: "user", content: content.map((c) => (c.type === "image_url" ? { type: "image_url", image_url: { url: `data:...base64（${Math.round(c.image_url.url.length / 1024)}KB）` } } : c)) }] } } });
		let resp: Response;
		try {
			resp = await fetch(`${up.baseUrl}/v1/chat/completions`, {
				method: "POST", headers, body: JSON.stringify(body),
				signal: submitSignal(), // 同步阻塞出图——第169轮取消短超时（详见 submitTimeout.ts）
			});
		} catch (e) {
			return { ok: false, error: `简梦H 提交失败：${(e as Error).message}` };
		}
		const data: any = await resp.json().catch(() => ({}));
		onUpstream?.({ response: { httpStatus: resp.status, body: data } });
		if (!resp.ok || data?.error) {
			return { ok: false, error: upstreamError(data, resp.status, "简梦H 出图") };
		}
		const msg = data?.choices?.[0]?.message ?? {};
		const contentStr = String(msg?.content ?? "");
		// reasoning_content 带 ❌=生成失败（文档错误形态③）
		const reasoning = String(msg?.reasoning_content ?? "");
		const url = extractImageUrl(contentStr, up.baseUrl);
		if (!url) {
			if (reasoning.includes("❌")) {
				return { ok: false, error: `简梦H 出图失败：${reasoning.split("❌").pop()?.trim() || "上游标记生成失败"}` };
			}
			return { ok: false, error: `简梦H 出图未返回图片链接${contentStr ? `：${contentStr.slice(0, 200)}` : "（响应内容为空）"}` };
		}
		return downloadResult(url);
	}

	// ── grok 系（及管理端自建未知上游名——OpenAI images 形态最通用）：/v1/images/generations ──
	if (imgs.length > 1) {
		return { ok: false, error: `模型「${up.upstreamModel}」的参考图字段为单值（image 纯 base64），最多 1 张（当前 ${imgs.length} 张），请精简图片素材或换用 firefly 系款式` };
	}
	if (up.upstreamModel.endsWith("-edit") && imgs.length === 0) {
		return { ok: false, error: `模型「${up.upstreamModel}」是图生图专用款式，必须携带 1 张参考图，请添加图片素材或换用文生款式` };
	}
	const body: Record<string, unknown> = { model: up.upstreamModel, prompt, n: 1 };
	if (imgs.length === 1) {
		const r = await fetchRefB64(imgs[0], 0);
		if (!r.ok) return { ok: false, error: r.error };
		body.image = r.b64; // ⚠ 纯 base64 无 data: 前缀（与 firefly 相反，文档注意事项②）
	}
	onUpstream?.({ request: { url: `${up.baseUrl}/v1/images/generations`, method: "POST", headers: logHeaders, body: { ...body, ...(body.image ? { image: `base64（${Math.round(String(body.image).length / 1024)}KB）` } : {}) } } });
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/images/generations`, {
			method: "POST", headers, body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (e) {
		return { ok: false, error: `简梦H 提交失败：${(e as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: { ...data, ...(data?.data?.[0]?.b64_json ? { data: [{ b64_json: `base64（${Math.round(String(data.data[0].b64_json).length / 1024)}KB）` }] } : {}) } } });
	if (!resp.ok || data?.error) {
		return { ok: false, error: upstreamError(data, resp.status, "简梦H 出图") };
	}
	const item = data?.data?.[0] ?? {};
	if (typeof item.url === "string" && /^https?:\/\//i.test(item.url)) {
		return downloadResult(item.url);
	}
	if (typeof item.b64_json === "string" && item.b64_json) {
		const buf = Buffer.from(item.b64_json, "base64");
		return { ok: true, data: buf, contentType: b64Mime(item.b64_json) };
	}
	return { ok: false, error: "简梦H 出图响应中没有可用的图片地址或数据" };
}

/* ═══════════ 视频（第155轮）：chat/completions SSE 流式单请求（同站「视频生成接口文档」统一形态） ═══════════
 * 按官方统一视频文档：6 家族全走 `POST /v1/chat/completions` + `stream:true`（文档定死；流内 delta.content
 * 吐视频 URL，生成 1~10 分钟、流结束即有结果——**不是 submit+poll**，复用 createImageTask 管线按 video 能力落资产）。
 *   **模型 ID 按家族现拼**（VID_CAPS 表；管理端自建已带 -Ns 段不重复拼）：
 *     grok  → grok-imagine-1.0-video-{landscape|portrait}-{6|10}s（朝向由比例定：9:16=portrait 其余 landscape）
 *     sora2 → firefly-sora2[-pro]-{4|8|12}s-{16x9|9x16}（⚠ 不发 resolution，文档明示）
 *     veo31 → firefly-veo31[-ref|-fast]-{4|6|8}s-{比例x形}-{720p|1080p}
 *     kling3/omni → firefly-kling3[omni]-{时长}s-{比例x形}-{分辨率}（kling3 恒 15s）
 *     runway45 → firefly-runway45-{5|10}s-{比例x形}-720p（7 比例含 21:9/9:21）
 *   body 另带顶层 aspect_ratio / video_length / resolution?（与 ID 后缀同值双下发，文档统一请求结构）。
 *   ⚠ 旧版「grok-imagine-1.0-video 终端对接文档」（2026-05-31）说"不拼后缀+video_config+stream:false"——与
 *   统一文档矛盾，**以新统一文档为准**（拼后缀+顶层字段+流式）；真机若报 model_not_found 再回退旧形态。
 *   素材：仅图片参考（chat 多模态 data URI 按序在前、text 收尾；视频/音频参考全渠道不支持=明确拒）；
 *   content 数组顺序即语义：1 图=首帧、2 图=首尾帧、多图=多参考（grok≤7 引用记号 @图N——注入的 @ImageN
 *   转写 @图N；veo31-ref≤3）。veo31/-fast/kling3 文档有首尾帧示例 → 声明 frames 方法（恰好 2 帧，同房规）。
 *   流解析：整流读完（resp.text()——SSE 连接随生成结束自然关闭）再逐行抽 delta.content/reasoning_content；
 *   非 SSE JSON 响应兜底直读 message.content（同站 grok 旧文档的 stream:false 形态天然兼容）；
 *   URL 提取五形态（<video src>/<source src>/markdown/直链/相对路径）；下载裸 GET（签名直链不带鉴权头）。
 *   价格未公布 → 按秒占位价（上线前管理端定真价）。 */

interface JmhVidCaps {
	durations: number[];
	ratios: string[];
	/** 分辨率档（首位=默认）；缺省=不发 resolution 且 ID 不带分辨率段（sora2） */
	resolutions?: string[];
	imgMax?: number;
	/** 首尾帧方法（veo31/-fast/kling3 文档示例） */
	frames?: boolean;
}
/** 视频能力表（键=上游基名；2026-07 统一视频文档「模型列表+ID 拼接规则」）；上游调整时同步维护 */
const VID_CAPS: Record<string, JmhVidCaps> = {
	"grok-imagine-1.0-video": { durations: [6, 10], ratios: ["16:9", "9:16", "3:2"], resolutions: ["720p", "480p"], imgMax: 7 },
	"firefly-sora2": { durations: [4, 8, 12], ratios: ["16:9", "9:16"] },
	"firefly-sora2-pro": { durations: [4, 8, 12], ratios: ["16:9", "9:16"] },
	"firefly-veo31": { durations: [4, 6, 8], ratios: ["16:9", "9:16"], resolutions: ["1080p", "720p"], imgMax: 2, frames: true },
	"firefly-veo31-ref": { durations: [4, 6, 8], ratios: ["16:9", "9:16"], resolutions: ["1080p", "720p"], imgMax: 3 },
	"firefly-veo31-fast": { durations: [4, 6, 8], ratios: ["16:9", "9:16"], resolutions: ["1080p", "720p"], imgMax: 2, frames: true },
	"firefly-kling3": { durations: [15], ratios: ["16:9", "9:16"], resolutions: ["1080p", "720p"], imgMax: 2, frames: true },
	"firefly-kling3omni": { durations: [5, 8, 10], ratios: ["16:9", "9:16"], resolutions: ["1080p", "720p"] },
	"firefly-runway45": { durations: [5, 10], ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "9:21"], resolutions: ["720p"] },
};
/** 已带完整时长段（-6s- / -6s 结尾）的自建上游名不重复拼 */
const FULL_VID_ID_RE = /-\d+s(-|$)/;
/** 视频 URL 提取（统一文档四形态 + 相对路径）：<video src> > <source src> > markdown > 直链 > /v1/... 拼 baseUrl */
function extractVideoUrl(content: string, baseUrl: string): string | null {
	const vtag = content.match(/<video[^>]*\ssrc=["']([^"']+)["']/i) || content.match(/<source[^>]*\ssrc=["']([^"']+)["']/i);
	if (vtag) return /^https?:\/\//i.test(vtag[1]) ? vtag[1] : `${baseUrl}${vtag[1]}`;
	return extractImageUrl(content, baseUrl);
}

/** 整流解析：SSE 逐行抽 delta.content/reasoning_content 与流内 error；非 SSE 响应按 JSON/裸文本兜底 */
function parseChatStream(raw: string): { content: string; reasoning: string; error?: string } {
	if (!/^data:\s?/m.test(raw)) {
		try {
			const j = JSON.parse(raw);
			if (j?.error) return { content: "", reasoning: "", error: (typeof j.error === "string" ? j.error : j.error?.message) || "上游返回错误" };
			const m = j?.choices?.[0]?.message ?? {};
			return { content: String(m?.content ?? ""), reasoning: String(m?.reasoning_content ?? "") };
		} catch {
			return { content: raw, reasoning: "" }; // 裸文本（可能直接就是 URL）
		}
	}
	let content = "", reasoning = "";
	let error: string | undefined;
	for (const line of raw.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const s = line.slice(5).trim();
		if (!s || s === "[DONE]") continue;
		try {
			const c = JSON.parse(s);
			if (c?.error) {
				error = (typeof c.error === "string" ? c.error : c.error?.message) || "上游流内错误";
				continue;
			}
			const d = c?.choices?.[0]?.delta ?? c?.choices?.[0]?.message ?? {};
			if (d?.content) content += String(d.content);
			if (d?.reasoning_content) reasoning += String(d.reasoning_content);
		} catch { /* 半截行/心跳噪声忽略 */ }
	}
	return { content, reasoning, error };
}

/** 视频生成（SSE 单请求）：拼模型 ID → chat/completions 整流读完 → 提链下载落 video 资产 */
export async function translateJmhVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<ImageResult> {
	if (!up.apiKey) {
		return { ok: false, error: "简梦H 未配置上游密钥（管理端「简梦H（ZhengAPI）」渠道或环境 JMH_API_KEY）" };
	}
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);
	if (vids.length || auds.length) {
		return { ok: false, error: `简梦H 视频模型仅支持图片参考（当前携带 视频 ${vids.length} 个/音频 ${auds.length} 个），请移除后重试` };
	}

	const caps = FULL_VID_ID_RE.test(up.upstreamModel) ? undefined : VID_CAPS[up.upstreamModel];
	const isGrok = up.upstreamModel === "grok-imagine-1.0-video";

	// ⚠ 时长/比例/分辨率原样透传，绝不静默改写（§9 第188轮定稿，第215轮根除旧就近取档/能力表回退——
	//   按秒计费按请求参数扣，夹钳=多扣钱少交货）。显式值原样拼进模型 ID，非法档位由上游明确报错（失败自动退款）。
	const ratio = stringParam(req.params?.aspect_ratio, "16:9");
	const duration = numberParam(req.params?.duration, caps ? caps.durations[caps.durations.length - 1] : 8);
	let resolution: string | undefined;
	if (caps?.resolutions) {
		resolution = stringParam(req.params?.resolution, caps.resolutions[0]);
	} else if (!caps) {
		const rr = String(req.params?.resolution ?? "").trim();
		if (rr) resolution = rr;
	}

	// 模型 ID 现拼（家族规则见文件头）
	let model = up.upstreamModel;
	if (caps) {
		const rx = ratio.replace(":", "x");
		if (isGrok) {
			// grok 的 ID 语法只有 横/竖 两种朝向段——比例不在两档时无法编码，前置明确报错（非静默回退 landscape）
			if (ratio !== "16:9" && ratio !== "9:16") {
				return { ok: false, error: `该模型比例仅支持 16:9（横屏）/ 9:16（竖屏），当前「${ratio}」无法编码进上游模型 ID，请改用支持档位` };
			}
			model = `${model}-${ratio === "9:16" ? "portrait" : "landscape"}-${duration}s`;
		}
		else if (model.startsWith("firefly-sora2")) model = `${model}-${duration}s-${rx}`;
		else model = `${model}-${duration}s-${rx}-${resolution}`;
	}

	let prompt = buildPrompt(req);
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";
	let sendImgs: { url: string; name?: string }[];

	if (String(req.params?.method ?? "") === "frames") {
		// ── 首尾帧方法（veo31/-fast/kling3）：恰好两帧（首=带故事板>素材第1图、尾=下一张），只收图片 ──
		if (caps && !caps.frames) {
			return { ok: false, error: `模型「${up.upstreamModel}」不支持首尾帧方法，请改用全能参考或换用 veo31/kling3 款式` };
		}
		const pool: { url: string; name?: string }[] = [];
		if (firstFrameParam) pool.push({ url: firstFrameParam, name: "首帧" });
		for (const x of imgs) if (!pool.some((p) => p.url === x.url)) pool.push(x);
		if (pool.length < 2) {
			return { ok: false, error: "首尾帧方法需要两张图（首帧+尾帧）：请携带 2 张图片素材，或「带故事板」+1 张图片素材" };
		}
		if (pool.length > 2) {
			return { ok: false, error: `首尾帧方法只需两张图（首帧+尾帧），当前共 ${pool.length} 张，请精简图片素材或改用全能参考` };
		}
		sendImgs = pool; // 顺序即语义：首帧在前、尾帧在后（文档 content 数组规则）
	} else {
		// ── 全能参考（缺省）：多图按序在前（1 图=首帧、2 图=首尾帧、多图=多参考，上游按序解释）──
		if (caps?.imgMax != null && imgs.length > caps.imgMax) {
			return { ok: false, error: `模型「${up.upstreamModel}」参考图上限 ${caps.imgMax} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
		}
		prompt = injectReferenceTags(prompt, { images: imgs });
		sendImgs = [...imgs];
		// 整体/首帧参考（带故事板）：追加末尾+说明行（不前插防图例错位）；满上限放弃（软性附加项）
		const room = caps?.imgMax ?? 9;
		if (firstFrameParam && !sendImgs.some((x) => x.url === firstFrameParam) && sendImgs.length < room) {
			sendImgs.push({ url: firstFrameParam, name: "整体参考" });
			prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@Image${sendImgs.length}`;
		}
		// grok 引用记号是 @图N（文档 5.3）——注入的 @ImageN 转写
		if (isGrok) prompt = prompt.replace(/@Image(\d+)/g, "@图$1");
	}

	// 参考图取字节内联 data URI（与图片路径同规，死链明确报错指名）
	const content: any[] = [];
	for (let i = 0; i < sendImgs.length; i++) {
		const r = await fetchRefB64(sendImgs[i], i);
		if (!r.ok) return { ok: false, error: r.error };
		content.push({ type: "image_url", image_url: { url: `data:${r.mime};base64,${r.b64}` } });
	}
	content.push({ type: "text", text: prompt });

	const body: Record<string, unknown> = {
		model, messages: [{ role: "user", content }], stream: true,
		aspect_ratio: ratio, video_length: duration,
		...(resolution ? { resolution } : {}),
	};
	onUpstream?.({ request: { url: `${up.baseUrl}/v1/chat/completions`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body: { ...body, messages: [{ role: "user", content: content.map((c) => (c.type === "image_url" ? { type: "image_url", image_url: { url: `data:...base64（${Math.round(c.image_url.url.length / 1024)}KB）` } } : c)) }] } } });

	let resp: Response;
	let raw: string;
	try {
		resp = await fetch(`${up.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(), // 生成 1~10 分钟、整流读完为止——第169轮改用统一提交安全闸（详见 submitTimeout.ts）
		});
		raw = await resp.text();
	} catch (e) {
		return { ok: false, error: `简梦H 视频生成中断：${(e as Error).message}` };
	}
	if (!resp.ok) {
		let errBody: any = {};
		try { errBody = JSON.parse(raw); } catch { /* 保持空 */ }
		onUpstream?.({ response: { httpStatus: resp.status, body: errBody?.error ? errBody : { raw: raw.slice(0, 500) } } });
		return { ok: false, error: upstreamError(errBody, resp.status, "简梦H 视频生成") };
	}
	const parsed = parseChatStream(raw);
	onUpstream?.({ response: { httpStatus: resp.status, body: { content: parsed.content.slice(0, 1000), reasoning: parsed.reasoning.slice(-800), streamError: parsed.error } } });
	if (parsed.error) {
		return { ok: false, error: `简梦H 视频生成失败：${parsed.error}` };
	}
	const url = extractVideoUrl(parsed.content, up.baseUrl);
	if (!url) {
		if (parsed.reasoning.includes("❌")) {
			return { ok: false, error: `简梦H 视频生成失败：${parsed.reasoning.split("❌").pop()?.trim() || "上游标记生成失败"}` };
		}
		return { ok: false, error: `简梦H 视频生成未返回链接${parsed.content ? `：${parsed.content.slice(0, 200)}` : "（响应内容为空）"}` };
	}
	// 成片下载（签名直链裸 GET 不带鉴权头；有时效，当场取字节落永久资产）——与图片同走多次尝试（海外直链间歇黑洞）
	return downloadResult(url, "video");
}
