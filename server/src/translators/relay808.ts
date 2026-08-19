/**
 * Skylee（api.808relay.com）图片渠道翻译器（第230轮接入，异步 submit+poll）。
 *
 * 上游架构（按站点「API 接入文档」+ /llms.txt 实拉，2026-08-15）：
 *   POST /v1/images/generations?async=true
 *     body { model, prompt, n, response_format:"url", size?, quality?, image_urls?[], extra_body? }
 *     → 提交回执 { id, task_id, status:"queued" }（文档明示「同时兼容 id 和 task_id」→ 防御式 task_id||id）
 *   GET  /v1/images/tasks/{task_id}?response_format=url
 *     → { status, data:[{ url | b64_json }] }（文档只写「返回 URL 时读 data[0].url、返回 Base64 时读
 *       data[0].b64_json」，未公布状态词枚举 → 防御式状态族，未知词=生成中继续轮询）
 *
 * ⚠ **同步回执短路（勿删）**：文档没承诺所有款式都支持 ?async=true——若上游忽略该参数直接返回成品
 *   （回执里已带 data[0].url/b64_json 而无 task_id），提交段就地把结果登记进 SYNC_DONE，返回
 *   合成 taskId（`sync:` 前缀），首次 poll 立刻取回。这样无论上游认不认 async，管线都走同一条路。
 *
 * 鉴权：Authorization: Bearer（渠道 ch-skylee / 环境 SKYLEE_API_KEY）；Base URL 填根域（不带 /v1）。
 *
 * 参考图（文档「图片调用」节定稿语义）：
 *   - 输入一律走 **image_urls**（公网 URL 或 `data:image/...;base64,` Data URL；本地文件才用
 *     /v1/images/edits 的 multipart image[]——我方素材恒是 OSS 公网直链，不走该形态）；
 *   - `response_format` **只控制结果**（url / b64_json），绝不用它描述输入；
 *   - ⚠ 与既有 openai-image 翻译器（第118轮定稿 `images[].image_url`）**字段名不同**，故独立协议不复用。
 * 素材数量闸：由管理端 matLimits 前置硬闸（routes.ts）把关——文档未公布逐模型参考图上限，
 *   这里只拦「图片接口收到视频/音频素材」（明确报错，绝不静默丢——@ImageN 图例按位对齐）。
 *
 * 款式形态（KIND）：
 *   - gpt：像素尺寸枚举 size + quality（auto/low/medium/high）；
 *   - gemini：size 取比例串 + quality 1K/2K/4K（我方 resolution 档映射；4K 按 New API 惯例补
 *     extra_body.google.image_config——与简梦Z 图片同尺，上游不认会明确报错，无静默风险）；
 *   - mj：仅比例串（Relax/Fast、HD 与否属**上游账号档位**，文档未给请求字段——价目见站点，我方单档占位价）。
 *     ⚠ Midjourney「一次任务返回四张图」：本管线一个任务落**一个**资产（取 data[0]），
 *       其余张数记进日志 ④ 段供排查——多图落盘需扩展通用轮询管线，属已知边界。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import { resolveNamed, injectReferenceTags } from "./jianmeng.ts";
import type { VideoSubmit, VideoPoll } from "./jianmeng.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import type { OnUpstream } from "./openai.ts";
import type { GenerateRequest } from "../contract.ts";

/** 款式形态：决定 size/quality 怎么发 */
type SkyKind = "gpt" | "gemini" | "mj";

/** 上游公开模型名 → 款式形态（未知名=按 gpt 形态直发，OpenAI 风格最通用）。
 *  ⚠ 键必须与站点模型名逐字一致，含 `[zz]` 方括号与 lite 款名里的那个空格。 */
const KIND: Record<string, SkyKind> = {
	"gpt-image-2": "gpt",
	"gpt-image-2-low": "gpt",
	"gpt-image-2-openai-compact": "gpt",
	"gpt-image-2-token": "gpt",
	"gemini-3-pro-image-preview": "gemini",
	"gemini-3.1-flash-image-preview": "gemini",
	"[zz]gemini-3-pro-image-preview": "gemini",
	"[zz]gemini-3.1-flash-image-preview": "gemini",
	"[zz] gemini-3.1-flash-lite-image": "gemini",
	"midjourney-v7": "mj",
	"midjourney-v8.1": "mj",
	"midjourney-v8.2": "mj",
};

const GPT_SIZES = ["1024x1024", "1536x1024", "1024x1536", "1536x2048", "2048x1536"];
const GPT_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];

/** "WxH" / "W:H" → 宽高比数值；解析不出 null */
function aspectValOf(s: string): number | null {
	const m = s.match(/^(\d+)\s*[x:×]\s*(\d+)$/i);
	if (!m) return null;
	const w = Number(m[1]), h = Number(m[2]);
	return w > 0 && h > 0 ? w / h : null;
}
/** 像素尺寸/比例串 → 允许列表里最接近的比例项（按宽高比数值距离；解析不出回退首项） */
function nearestRatio(sizeRaw: string, allowed: string[]): string {
	if (allowed.includes(sizeRaw)) return sizeRaw;
	const a = aspectValOf(sizeRaw);
	if (a == null) return allowed[0];
	return allowed.reduce((best, r) => (Math.abs(aspectValOf(r)! - a) < Math.abs(aspectValOf(best)! - a) ? r : best), allowed[0]);
}
/** gpt 形态尺寸：枚举内/auto 原样；像素不在枚举 → 同比例（±0.01）里取宽度最近档；无同比例 → auto；空=不发 */
function gptSizeOf(sizeRaw: string): string | null {
	if (!sizeRaw) return null;
	if (sizeRaw === "auto" || GPT_SIZES.includes(sizeRaw)) return sizeRaw;
	const a = aspectValOf(sizeRaw);
	if (a == null) return "auto";
	const same = GPT_SIZES.filter((s) => Math.abs(aspectValOf(s)! - a) < 0.01);
	if (!same.length) return "auto";
	const w = Number(sizeRaw.match(/^(\d+)/)?.[1] ?? 0);
	return same.reduce((best, s) => (Math.abs(Number(s.split("x")[0]) - w) < Math.abs(Number(best.split("x")[0]) - w) ? s : best), same[0]);
}

/** 上游错误 → 人话（OpenAI 风格 {error:{message}}；字符串/裸 message 逐个兜底） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const msg =
		(typeof data?.error === "string" ? data.error : data?.error?.message) ||
		data?.message ||
		"";
	if (httpStatus === 401 || httpStatus === 403) return `Skylee 上游密钥无效或无权限${msg ? `：${msg}` : ""}，请联系运营检查渠道密钥`;
	if (httpStatus === 402) return "Skylee 上游额度不足，请联系运营充值后重试";
	if (httpStatus === 429) return "Skylee 上游请求过频或负载饱和，请稍后重试";
	if (msg) return String(msg);
	return `${fallback} HTTP ${httpStatus}`;
}

/**
 * 从「图片结果对象」里取可下载地址：url 优先；只有 b64_json 时合成 data: URL
 * （通用轮询循环用 fetch 取字节，undici 支持 data: 协议）。取不到返回 ""。
 */
function pickImageUrl(payload: any): { url: string; count: number } {
	const arr: any[] =
		(Array.isArray(payload?.data) ? payload.data : null) ||
		(Array.isArray(payload?.data?.data) ? payload.data.data : null) ||
		(Array.isArray(payload?.images) ? payload.images : null) ||
		[];
	for (const it of arr) {
		const u = it?.url || it?.image_url?.url;
		if (typeof u === "string" && /^https?:\/\//i.test(u)) return { url: u, count: arr.length };
		const b64 = it?.b64_json || it?.b64;
		if (typeof b64 === "string" && b64.length > 64) {
			return { url: `data:image/png;base64,${b64.replace(/^data:[^,]*,/, "")}`, count: arr.length };
		}
	}
	const single = payload?.result_url || payload?.url;
	if (typeof single === "string" && /^https?:\/\//i.test(single)) return { url: single, count: 1 };
	return { url: "", count: arr.length };
}

/** 同步回执短路表：上游忽略 ?async=true 直接返成品时，把结果寄存在这里给首次 poll 取走 */
const SYNC_DONE = new Map<string, { url: string; at: number }>();
const SYNC_TTL_MS = 30 * 60 * 1000;
let syncSeq = 0;
function stashSync(url: string): string {
	const now = Date.now();
	for (const [k, v] of SYNC_DONE) if (now - v.at > SYNC_TTL_MS) SYNC_DONE.delete(k);
	const id = `sync:${now.toString(36)}-${++syncSeq}`;
	SYNC_DONE.set(id, { url, at: now });
	return id;
}

/** ① 提交图片生成任务 → 返回上游 task_id（或同步成品的合成 id） */
export async function submitRelay808Image(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "Skylee 未配置上游密钥（管理端「Skylee」渠道或环境 SKYLEE_API_KEY）" };
	}

	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);
	// 图片接口不吃视频/音频素材——明确报错，绝不静默丢（丢一条即 @ImageN 图例整段错位）
	if (vids.length || auds.length) {
		return { ok: false, error: `图片模型不支持参考视频/音频（本次携带 ${vids.length} 个视频、${auds.length} 个音频），请移除后重试` };
	}

	// prompt 注入 @ImageN 图例（该家无 @ 引用语法，图例作普通说明文字——与多数渠道同款）
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs });

	const kind: SkyKind = KIND[up.upstreamModel] ?? "gpt";
	const body: Record<string, unknown> = {
		model: up.upstreamModel,
		prompt,
		n: 1,
		response_format: "url",
	};
	// 参考图恒走 image_urls 数组（公网 URL / Data URL 同一字段——文档「图片调用」定稿）
	if (imgs.length) body.image_urls = imgs.map((x) => x.url);

	const sizeRaw = String(req.params?.size ?? "").trim();
	if (kind === "gpt") {
		const size = gptSizeOf(sizeRaw);
		if (size) body.size = size;
		const q = String(req.params?.quality ?? "");
		if (GPT_QUALITIES.has(q)) body.quality = q;
	} else if (kind === "gemini") {
		const ratio = sizeRaw ? nearestRatio(sizeRaw, RATIOS) : null;
		if (ratio) body.size = ratio;
		// 质量档=我方 resolution（1k/2k/4k → 1K/2K/4K）；档外不发=走上游默认（第122轮规则）
		const resRaw = String(req.params?.resolution ?? "").toUpperCase();
		if (["1K", "2K", "4K"].includes(resRaw)) {
			body.quality = resRaw;
			if (resRaw === "4K") {
				body.extra_body = { google: { image_config: { image_size: "4K", ...(ratio ? { aspect_ratio: ratio } : {}) } } };
			}
		}
	} else {
		// mj：仅比例串（档位属上游账号配置，文档未给请求字段）
		const ratio = sizeRaw ? nearestRatio(sizeRaw, RATIOS) : null;
		if (ratio) body.size = ratio;
	}

	const url = `${up.baseUrl}/v1/images/generations?async=true`;
	onUpstream?.({ request: { url, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		// 幂等未承诺：超时/网络错误不自动重试（可能已建任务重复计费），明确报错交用户确认
		return { ok: false, error: `Skylee 图片提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	if (!resp.ok) {
		return { ok: false, error: upstreamError(data, resp.status, "Skylee 图片提交") };
	}
	const taskId = data?.task_id || data?.id;
	// 上游认 async → 回执带任务号（注意：同步回执也可能带 id，故先看有没有成品）
	const sync = pickImageUrl(data);
	if (sync.url) return { ok: true, taskId: stashSync(sync.url) };
	if (taskId) return { ok: true, taskId: String(taskId) };
	return { ok: false, error: upstreamError(data, resp.status, "Skylee 图片提交未返回任务号") };
}

/** 成功/失败状态族（文档未公布图片任务状态词枚举 → 防御式收录常见同义词；未知词=生成中继续轮询） */
const OK_STATES = new Set(["success", "succeeded", "completed", "complete", "finished"]);
const FAIL_STATES = new Set(["failed", "failure", "error", "cancelled", "canceled"]);

/** ② 轮询图片任务（终态把上游原始响应并入日志 ④ 段） */
export async function pollRelay808Image(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	// 同步成品短路（上游忽略 ?async=true 时）——首次轮询即取回
	const stashed = SYNC_DONE.get(taskId);
	if (stashed) {
		SYNC_DONE.delete(taskId);
		return { status: "completed", videoUrl: stashed.url };
	}
	if (taskId.startsWith("sync:")) {
		// 寄存已过期/被取走（进程重启续轮询也会走到这里）——成品无从找回，明确失败以触发退款
		return { status: "failed", error: "Skylee 图片结果已失效（同步回执未能落盘），请重新生成" };
	}

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/images/tasks/${encodeURIComponent(taskId)}?response_format=url`, {
			headers: { Authorization: `Bearer ${up.apiKey}` },
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		// 网络抖动：当作仍在进行，让上层下一拍继续轮询
		return { status: "running", progress: 50 };
	}
	const body: any = await resp.json().catch(() => ({}));
	if (resp.status >= 500 || resp.status === 429) {
		return { status: "running", progress: 50 };
	}
	if (!resp.ok) {
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body } });
		return { status: "failed", error: upstreamError(body, resp.status, "Skylee 图片轮询") };
	}

	// 信封（data 为对象）与扁平两种形态都吃
	const d: any = body?.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : body;
	const st = String(d?.status ?? body?.status ?? "").toLowerCase();

	if (FAIL_STATES.has(st)) {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body } });
		const msg =
			d?.fail_reason ||
			(typeof d?.error === "string" ? d.error : d?.error?.message) ||
			body?.message;
		return { status: "failed", error: msg ? String(msg) : "Skylee 图片生成失败" };
	}

	const got = pickImageUrl(d);
	// 成功状态、或状态词缺失但成品已在（部分 New API 构建直接返最终 images 对象）→ 完成
	if (got.url && (OK_STATES.has(st) || !st)) {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body, imageCount: got.count } });
		// 结果链接若在本站域，带上 Bearer 下载（防私有直链 403）；第三方 CDN 绝不附头（防密钥外泄，第153轮规则）
		let resultHeaders: Record<string, string> | undefined;
		if (/^https?:\/\//i.test(got.url)) {
			try {
				const uh = new URL(got.url).hostname, bh = new URL(up.baseUrl).hostname;
				if (uh === bh || uh.endsWith(`.${bh}`) || bh.endsWith(`.${uh}`)) {
					resultHeaders = { Authorization: `Bearer ${up.apiKey}` };
				}
			} catch { /* 域解析失败=不附头 */ }
		}
		return { status: "completed", videoUrl: got.url, resultHeaders };
	}
	if (OK_STATES.has(st) && !got.url) {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body } });
		return { status: "failed", error: "Skylee 图片任务已完成，但响应中没有可用的结果地址" };
	}

	// queued/pending=排队；其余（含未知状态词）=生成中继续轮询（任务有 2h 总超时兜底）
	const p = parseInt(String(d?.progress ?? ""), 10);
	return {
		status: st === "queued" || st === "pending" ? "queued" : "running",
		progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50,
	};
}
