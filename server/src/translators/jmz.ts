/**
 * 简梦Z（zexitongxue.com）视频渠道翻译器（第152轮接入，异步 submit+poll）。
 *
 * 上游架构（按官方「视频生成 API」文档 + 实时模型目录 /ai-api/models?type=video，2026-07-23 实测）：
 *   POST /v1/videos   body { model, prompt, aspect_ratio, duration,
 *                            reference_image_urls?, reference_videos?, audio_urls?,
 *                            start_frame?/end_frame?(首尾帧), resolution?(仅 grok 多档) }
 *     → 提交回执文档未给样例——按查询同款形状取 task_id（防御式 task_id||id）。
 *     字段别名众多（image_url/imageUrl/images/seconds/ratio…）——**只发一套主字段**（第147轮规则）：
 *     多图=reference_image_urls（文档多素材示例主字段）、视频=reference_videos、音频=audio_urls（数组形态，
 *     豆包线音频上限 5 条，单值 audio_url 装不下）；⚠ 幂等未承诺：超时/网络错误不自动重试，明确报错交用户确认。
 *   GET  /v1/videos/{task_id} → { task_id, model, status, progress, result_url }
 *     ⚠ 文档只展示了 status:"success" 一种终态——失败/进行中的状态词未公布 → 防御式状态族：
 *     success/succeeded/completed=成功（取 result_url，可能是火山 *.volces.com 官方临时 CDN 直链 →
 *     通用轮询循环 rehostVideo 转存永久 OSS）；failed/failure/error/cancelled/canceled=失败；
 *     其余（pending/queued/running/processing/未知词）一律当生成中继续轮询（任务有 2h 总超时兜底）。
 *     另有带鉴权的 GET /v1/videos/{id}/content 下载端点——rehost 不带请求头故不用它，属已知边界。
 *
 * 鉴权：Authorization: Bearer（渠道 ch-jmz / 环境 JMZ_API_KEY）；Base URL 填根域（不带 /v1）。
 *
 * 模型能力静态表 CAPS（键=上游公开模型名；2026-07-23 实时目录 note/duration_profile/max_reference_images 实测）：
 *   - 豆包三线（doubao-seedance-2-0-480p/720p/1080p）：图9 视3 音5（文档「多素材参考」节）+ **首尾帧**
 *     （目录 note 明示支持 → frames 方法，字段取别名表首位 start_frame/end_frame）；4-15s。
 *   - seedance-2.0-480p-pro：目录 note 明示「不支持视频/音频参考及首尾帧」→ 视0 音0；时长 5/10/15 三档。
 *   - grok：目录 note「支持 720P 文生/单图/多图和 1080P 单图」→ 视0 音0；时长 6/10/15、**多图（≥2）只有 6/10**
 *     （duration_rules.multi_image）；resolution 可选档（唯一非固定分辨率线）——1080p 须恰好 1 张参考图。
 *   - 其余 seedance pro/fast 线：图上限按目录 max_reference_images（9 或 431 线=4）；视/音能力目录未注明 →
 *     **不本地拦**（undefined=上游兜底，与苏打水 gf2 同规则；明确写明不支持的才 0）。
 * 守卫**绝不静默丢**（超限/明确不支持一律报错，防 @ImageN 图例错位——与其它视频渠道同规则）。
 * 提示词引用：该家无 @ 引用语法 → injectReferenceTags 注入的 @Image1/@Video1/@Audio1 图例作普通说明文字。
 * 「带故事板」（params.firstFrameUrl）：omni 追加 reference_image_urls **末尾**+说明行（不前插防图例错位；
 *   满上限放弃——软性附加项）；frames 方法则作首帧候选之首（首帧=firstFrameUrl>素材第1图、尾帧=下一张，
 *   缺任一/多余图/带视频音频一律明确报错——与苏打水/星辰 frames 同尺）。
 * 比例：文档未给枚举表、示例仅 16:9/9:16 → **不收敛原样透传**（种子参数只开两档，管理端加档即放行）。
 * 分辨率：绝大多数线由模型名固定 → 一律不发；仅 grok（CAPS.resolutions）且值≠默认档（720p）才发
 *   （第122轮规则：不发=走上游默认；grok 1080p 本轮种子未开档——字段实测实锤后管理端加档即可）。
 * 计费：豆包线上游按 Token 计费（39.1-43.35 元/百万 Token，任务完成按 usage 多退少补——上游侧机制，
 *   与我方无关）；我方一律按次/按秒占位价（管理端定真价）。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import { resolveNamed, injectReferenceTags } from "./jianmeng.ts";
import type { VideoSubmit, VideoPoll } from "./jianmeng.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import { numberParam } from "./paramPass.ts";
import type { OnUpstream } from "./openai.ts";
import type { GenerateRequest } from "../contract.ts";

/** 单模型能力（键=上游公开模型名）。未知上游名（管理端自建）不守卫直发（上游自校验） */
interface JmzCaps {
	imgMax: number;
	/** 参考视频/音频上限：0=目录明确不支持（本地拦）；undefined=能力未注明（不拦，上游兜底） */
	vidMax?: number;
	audMax?: number;
	/** 离散时长档（就近取档，并列取小）；与 durMin/durMax 二选一 */
	durations?: number[];
	durMin?: number;
	durMax?: number;
	durDefault: number;
	/** grok：多图参考（≥2 张）时的时长档（duration_rules.multi_image） */
	multiImgDurations?: number[];
	/** 可随请求下发 resolution 的档（首位=默认档不发）；缺省=分辨率由模型名固定、一律不发 */
	resolutions?: string[];
	/** 支持首尾帧方法（豆包三线；字段 start_frame/end_frame） */
	frames?: boolean;
}

const DOUBAO_CAPS: JmzCaps = { imgMax: 9, vidMax: 3, audMax: 5, durMin: 4, durMax: 15, durDefault: 5, frames: true };
const SD_PRO_CAPS = (imgMax: number, durMax = 15, durDefault = 5): JmzCaps => ({ imgMax, durMin: 4, durMax, durDefault });
/** 能力表（2026-07-23 实时目录）；上游调整时同步维护 */
const CAPS: Record<string, JmzCaps> = {
	"dolo": { imgMax: 9, durMin: 1, durMax: 15, durDefault: 10 },
	"dolo-2": { imgMax: 9, durations: [5, 15], durDefault: 5 },
	"grok": { imgMax: 9, vidMax: 0, audMax: 0, durations: [6, 10, 15], multiImgDurations: [6, 10], durDefault: 6, resolutions: ["720p", "1080p"] },
	"seedance-2.0-480p-pro": { imgMax: 9, vidMax: 0, audMax: 0, durations: [5, 10, 15], durDefault: 5 },
	"seedance-2.0-480p-pro2": SD_PRO_CAPS(9),
	"seedance-2.0-720p-pro": SD_PRO_CAPS(9),
	"seedance-2.0-720-pro-enhance": SD_PRO_CAPS(9, 12, 4),
	"seedance-2.0-720p-pro-431": SD_PRO_CAPS(4),
	"seedance-fast-2.0-480p-pro": SD_PRO_CAPS(9),
	"seedance-fast-2.0-720p-pro": SD_PRO_CAPS(9),
	"seedance-fast-2.0-720p-pro-431": { imgMax: 4, durations: [4], durDefault: 4 },
	"doubao-seedance-2-0-480p": DOUBAO_CAPS,
	"doubao-seedance-2-0-720p": DOUBAO_CAPS,
	"doubao-seedance-2-0-1080p": DOUBAO_CAPS,
};

/** 上游错误 → 人话（错误体形态未公布：error 字符串/{message}/message 逐个兜底） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const msg =
		(typeof data?.error === "string" ? data.error : data?.error?.message) ||
		data?.message ||
		"";
	if (httpStatus === 401 || httpStatus === 403) return `简梦Z 上游密钥无效或无权限${msg ? `：${msg}` : ""}，请联系运营检查渠道密钥`;
	if (httpStatus === 402) return "简梦Z 上游额度不足，请联系运营充值后重试";
	if (httpStatus === 429) return "简梦Z 上游请求过频或负载饱和，请稍后重试";
	if (msg) return String(msg);
	return `${fallback} HTTP ${httpStatus}`;
}

/** ① 提交视频生成任务 → 返回上游 task_id */
export async function submitJmzVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "简梦Z 未配置上游密钥（管理端「简梦Z」渠道或环境 JMZ_API_KEY）" };
	}

	// 素材解析（id→OSS 直链优先，拒收 .localhost 伪域）
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);
	const caps = CAPS[up.upstreamModel];

	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";

	let prompt = buildPrompt(req);
	const body: Record<string, unknown> = { model: up.upstreamModel };
	let imgCountForRules = imgs.length; // grok 多图时长档/1080p 单图守卫按最终发出的图数判

	if (String(req.params?.method ?? "") === "frames") {
		// ── 首尾帧方法（豆包三线；字段取别名表首位 start_frame/end_frame）──
		if (caps && !caps.frames) {
			return { ok: false, error: `模型「${up.upstreamModel}」不支持首尾帧方法，请改用全能参考或换用豆包 Seedance 2.0 系模型` };
		}
		if (vids.length || auds.length) {
			return { ok: false, error: "首尾帧方法只接受图片素材（首帧+尾帧），请移除视频/音频素材后重试" };
		}
		// 首帧=「带故事板」firstFrameUrl > 素材第 1 图；尾帧=下一张未用图；缺任一/多余图明确报错（与苏打水/星辰同尺）
		const pool: string[] = [];
		if (firstFrameParam) pool.push(firstFrameParam);
		for (const x of imgs) if (!pool.includes(x.url)) pool.push(x.url);
		if (pool.length < 2) {
			return { ok: false, error: "首尾帧方法需要两张图（首帧+尾帧）：请携带 2 张图片素材，或「带故事板」+1 张图片素材" };
		}
		if (pool.length > 2) {
			return { ok: false, error: `首尾帧方法只需两张图（首帧+尾帧），当前共 ${pool.length} 张，请精简图片素材或改用全能参考` };
		}
		body.start_frame = pool[0];
		body.end_frame = pool[1];
		imgCountForRules = 2;
	} else {
		// ── 全能参考（缺省方法）──
		if (caps) {
			if (caps.vidMax === 0 && vids.length) {
				return { ok: false, error: `模型「${up.upstreamModel}」不支持参考视频（本次携带 ${vids.length} 个），请移除视频素材或换用豆包 Seedance 2.0 系模型` };
			}
			if (caps.audMax === 0 && auds.length) {
				return { ok: false, error: `模型「${up.upstreamModel}」不支持参考音频（本次携带 ${auds.length} 个），请移除音频素材或换用豆包 Seedance 2.0 系模型` };
			}
			if (imgs.length > caps.imgMax) {
				return { ok: false, error: `模型「${up.upstreamModel}」参考图上限 ${caps.imgMax} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
			}
			if (caps.vidMax != null && caps.vidMax > 0 && vids.length > caps.vidMax) {
				return { ok: false, error: `模型「${up.upstreamModel}」参考视频上限 ${caps.vidMax} 个（当前 ${vids.length} 个），请精简后重试` };
			}
			if (caps.audMax != null && caps.audMax > 0 && auds.length > caps.audMax) {
				return { ok: false, error: `模型「${up.upstreamModel}」参考音频上限 ${caps.audMax} 个（当前 ${auds.length} 个），请精简后重试` };
			}
		}

		// prompt 注入 @tag 图例（编号=各模态数组序；该家无引用语法，图例作普通说明文字）
		prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });

		// 整体/首帧参考（带故事板）：追加 reference_image_urls 末尾（不前插防图例错位）；满上限放弃（软性附加项）
		const images = imgs.map((x) => x.url);
		const imgRoom = caps ? caps.imgMax : 9;
		if (firstFrameParam && !images.includes(firstFrameParam) && images.length < imgRoom) {
			images.push(firstFrameParam);
			prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@Image${images.length}`;
		}
		imgCountForRules = images.length;

		if (images.length) body.reference_image_urls = images;
		if (vids.length) body.reference_videos = vids.map((x) => x.url);
		if (auds.length) body.audio_urls = auds.map((x) => x.url);
	}

	// ⚠ 时长/分辨率原样透传，绝不静默改写（§9 第188轮定稿，第215轮根除旧就近取档/夹紧/分辨率「档外不发」
	//   静默丢弃——按秒计费按请求参数扣，夹钳=多扣钱少交货）。档位由管理端模型参数把关，非法值由上游明确报错（失败自动退款）。
	// 分辨率：显式非空即发（=默认首档时不发，与旧「默认档由模型名固定」语义一致）；缺省不发。
	const resRaw = String(req.params?.resolution ?? "").trim();
	if (resRaw && resRaw !== caps?.resolutions?.[0]) {
		// grok 1080P 仅支持「单图」形态（实时目录 note）：须恰好 1 张参考图——业务前置守卫（明确报错非静默改写）
		if (up.upstreamModel === "grok" && caps?.resolutions?.includes(resRaw) && imgCountForRules !== 1) {
			return { ok: false, error: `grok 1080p 档仅支持恰好 1 张参考图（当前 ${imgCountForRules} 张），请调整素材或改用 720p` };
		}
		body.resolution = resRaw;
	}

	// 时长：缺省补默认档（有能力表=durDefault，未知模型=5）；显式值原样透传
	const duration = numberParam(req.params?.duration, caps ? caps.durDefault : 5);
	// 比例：文档未给枚举表（示例仅 16:9/9:16）→ 不收敛原样透传（客户端枚举已约束；管理端加档即放行）
	const aspect_ratio = String(req.params?.aspect_ratio ?? "16:9");

	body.prompt = prompt;
	body.aspect_ratio = aspect_ratio;
	body.duration = duration;

	onUpstream?.({ request: { url: `${up.baseUrl}/v1/videos`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/videos`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		// ⚠ 幂等未承诺：超时/网络错误不自动重试（可能已建任务重复计费），交给用户确认后再发
		return { ok: false, error: `简梦Z 提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	const taskId = data?.task_id || data?.id;
	if (!resp.ok || !taskId) {
		return { ok: false, error: upstreamError(data, resp.status, "简梦Z 提交") };
	}
	return { ok: true, taskId: String(taskId) };
}

/** 成功/失败状态族（文档只展示 success —— 防御式收录常见同义词；未知词=生成中继续轮询） */
const OK_STATES = new Set(["success", "succeeded", "completed"]);
const FAIL_STATES = new Set(["failed", "failure", "error", "cancelled", "canceled"]);

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④） */
export async function pollJmzVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/videos/${encodeURIComponent(taskId)}`, {
			headers: { Authorization: `Bearer ${up.apiKey}` },
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		// 网络抖动：当作仍在进行，让上层下一拍继续轮询
		return { status: "running", progress: 50 };
	}
	const data: any = await resp.json().catch(() => ({}));
	// 5xx/429 视为上游瞬时故障：不终态，下一拍重试（任务有 2h 总超时兜底）
	if (resp.status >= 500 || resp.status === 429) {
		return { status: "running", progress: 50 };
	}
	if (!resp.ok) {
		// 400 任务号不合法 / 401 密钥失效 / 404 任务不存在 → 终态失败
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: upstreamError(data, resp.status, "简梦Z 轮询") };
	}
	const st = String(data?.status || "").toLowerCase();
	if (OK_STATES.has(st)) {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		// 主字段 result_url；video_url 防御兜底。缺失=明确失败（/content 下载端点需带鉴权头，rehost 不适用——已知边界）
		const raw = data?.result_url || data?.video_url;
		const url = typeof raw === "string" && /^https?:\/\//i.test(raw) ? raw : "";
		if (!url) return { status: "failed", error: "简梦Z 任务已完成，但响应中没有可用的视频地址" };
		return { status: "completed", videoUrl: url };
	}
	if (FAIL_STATES.has(st)) {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		const msg =
			(typeof data?.error === "string" ? data.error : data?.error?.message) ||
			data?.fail_reason || data?.message;
		return { status: "failed", error: msg ? String(msg) : "简梦Z 视频生成失败" };
	}
	// pending/queued=排队；running/processing 及未知状态=生成中继续轮询（容忍上游扩状态）
	const p = Number(data?.progress);
	return { status: st === "queued" || st === "pending" ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}

/* ═══════════ 图片（第153轮）：POST /v1/images/generations/async + GET /v1/images/tasks/{id} ═══════════
 * 按官方「图片生成 API」文档 + 实时目录 /ai-api/models?type=image（2026-07-23 实测：4 款在册带价与图上限，
 * grok pro/lite/edit 不在目录但文档「有效生图模型」表列为有效——按文档 7 款全接）。
 *   提交回执**扁平**：{ id, task_id, status:"queued", progress, data:[] }（防御式 task_id||id）；
 *   查询回执**信封**：{ code:"success", message, data:{ task_id, status:"SUCCESS", progress:"100%",
 *     result_url, data:{ data:[{url}] } } }——状态大写、progress 是 "100%" 字符串、结果两处兜底取；
 *     失败状态词未公布 → 防御式状态族（同视频）；信封 code≠success 且无任务状态=查询失败终态。
 *   ⚠ **结果链接非公开**：下载须带 Bearer、成功结果仅保留约 2 小时 → poll 返回 resultHeaders
 *     （仅结果域=本站域才附头，防密钥外泄给第三方 CDN），通用轮询循环完成即取字节落永久资产（image 能力分支）。
 *   参考图：文档只给单图 image_url 示例——1 张发 image_url（主字段）；≥2 张发 image_urls
 *     （⚠ 按同站视频 API「素材与兼容字段」多图别名族推定，待真机实锤）；上限按目录/文档表（守卫绝不静默丢）。
 *   参数按款式分三形态：gpt-image-2=像素尺寸枚举+quality(low/medium/high/auto)；gemini 双子=比例串+
 *     quality(1K/2K/4K，由我方 resolution 档映射；4K 按文档示例补 extra_body.google.image_config)；
 *     grok 系=仅比例串（按模型默认质量）。客户端发的像素尺寸（SIZE_MAP 产物）→ 比例串由 gcd 约简/最近比例映射。
 *   GPT Image 2 分组：1K/2K/4K 能力由 API Key 所在分组决定（default/image2/image2 4k）——站方控制台配置，
 *     我方不传任何上游线路信息；要 4K 请运营把 Key 分到「image2 4k」分组。 */

interface JmzImgCaps { imgMax: number; kind: "gpt" | "gemini" | "grok" }
/** 图片能力表（键=上游公开模型名；文档「有效生图模型」表+实时目录 max_reference_images 一致）。
 *  未知上游名（管理端自建）不守卫、按 gpt 形态直发（OpenAI 风格最通用） */
const IMG_CAPS: Record<string, JmzImgCaps> = {
	"gpt-image-2": { imgMax: 14, kind: "gpt" },
	"gemini-3-pro-image-preview": { imgMax: 4, kind: "gemini" },
	"gemini-3.1-flash-image-preview": { imgMax: 4, kind: "gemini" },
	"grok-imagine-image": { imgMax: 1, kind: "grok" },
	"grok-imagine-image-pro": { imgMax: 1, kind: "grok" },
	"grok-imagine-image-lite": { imgMax: 0, kind: "grok" },
	"grok-imagine-image-edit": { imgMax: 3, kind: "grok" },
};

const GPT_IMG_SIZES = ["1024x1024", "1536x1024", "1024x1536", "2048x1152", "3840x2160", "2160x3840"];
const GPT_IMG_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const GEMINI_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"];

/** "WxH"/"W:H" → 数值宽高比；解析不出 null */
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
/** 像素尺寸 → gcd 约简比例串（"2048x1152"→"16:9"）；本就是比例串原样返回；解析不出 null */
function reducedRatioOf(sizeRaw: string): string | null {
	if (/^\d+\s*:\s*\d+$/.test(sizeRaw)) return sizeRaw.replace(/\s+/g, "");
	const m = sizeRaw.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
	if (!m) return null;
	let a = Number(m[1]), b = Number(m[2]);
	if (!(a > 0 && b > 0)) return null;
	const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
	const g = gcd(a, b);
	return `${a / g}:${b / g}`;
}
/** gpt 形态尺寸：枚举内/auto 原样；像素不在枚举 → 同比例（±0.01）里取宽度最近档；无同比例 → auto；空=不发 */
function gptSizeOf(sizeRaw: string): string | null {
	if (!sizeRaw) return null;
	if (sizeRaw === "auto" || GPT_IMG_SIZES.includes(sizeRaw)) return sizeRaw;
	const a = aspectValOf(sizeRaw);
	if (a == null) return "auto";
	const same = GPT_IMG_SIZES.filter((s) => Math.abs(aspectValOf(s)! - a) < 0.01);
	if (!same.length) return "auto";
	const w = Number(sizeRaw.match(/^(\d+)/)?.[1] ?? 0);
	return same.reduce((best, s) => (Math.abs(Number(s.split("x")[0]) - w) < Math.abs(Number(best.split("x")[0]) - w) ? s : best), same[0]);
}

/** ① 提交图片生成任务 → 返回上游 task_id */
export async function submitJmzImage(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "简梦Z 未配置上游密钥（管理端「简梦Z」渠道或环境 JMZ_API_KEY）" };
	}

	const imgs = resolveNamed(req.inputs?.images);
	const caps = IMG_CAPS[up.upstreamModel];
	if (caps) {
		if (caps.imgMax === 0 && imgs.length) {
			return { ok: false, error: `模型「${up.upstreamModel}」是纯文生模型、不支持参考图（本次携带 ${imgs.length} 张），请移除图片素材或换用其它款式` };
		}
		if (imgs.length > caps.imgMax) {
			return { ok: false, error: `模型「${up.upstreamModel}」参考图上限 ${caps.imgMax} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
		}
	}

	// prompt 注入 @Image 图例（该家无引用语法，作普通说明文字——与视频同款）
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs });

	const body: Record<string, unknown> = { model: up.upstreamModel, prompt, n: 1 };
	// 参考图：1 张=image_url（文档主字段）；≥2 张=image_urls（⚠ 按同站视频 API 多图别名族推定，待真机实锤）
	if (imgs.length === 1) body.image_url = imgs[0].url;
	else if (imgs.length > 1) body.image_urls = imgs.map((x) => x.url);

	const sizeRaw = String(req.params?.size ?? "");
	if (caps?.kind === "gemini") {
		const ratio = sizeRaw ? nearestRatio(sizeRaw, GEMINI_RATIOS) : null;
		if (ratio) body.size = ratio;
		// 质量=我方 resolution 档（1k/2k/4k → 1K/2K/4K）；档外不发=走上游默认（第122轮规则）；
		// 4K 按文档示例补 extra_body.google.image_config（示例即 4K 才带，1K/2K 示例无 extra_body）
		const resRaw = String(req.params?.resolution ?? "").toUpperCase();
		if (["1K", "2K", "4K"].includes(resRaw)) {
			body.quality = resRaw;
			if (resRaw === "4K") {
				body.extra_body = { google: { image_config: { image_size: "4K", ...(ratio ? { aspect_ratio: ratio } : {}) } } };
			}
		}
	} else if (caps?.kind === "grok") {
		// grok 系：建议传比例串（文档「如 1:1、16:9、9:16」为举例非枚举——约简后原样透传）；质量按模型默认、不发
		const ratio = sizeRaw ? reducedRatioOf(sizeRaw) : null;
		if (ratio) body.size = ratio;
	} else {
		// gpt-image-2（未知上游名同此形态直发）
		const size = gptSizeOf(sizeRaw);
		if (size) body.size = size;
		const q = String(req.params?.quality ?? "");
		if (GPT_IMG_QUALITIES.has(q)) body.quality = q;
	}

	onUpstream?.({ request: { url: `${up.baseUrl}/v1/images/generations/async`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/images/generations/async`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		// 幂等未承诺：超时/网络错误不自动重试（可能已建任务重复计费），交给用户确认后再发
		return { ok: false, error: `简梦Z 图片提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	const taskId = data?.task_id || data?.id;
	if (!resp.ok || !taskId) {
		return { ok: false, error: upstreamError(data, resp.status, "简梦Z 图片提交") };
	}
	return { ok: true, taskId: String(taskId) };
}

const IMG_OK_STATES = new Set(["SUCCESS", "SUCCEEDED", "COMPLETED"]);
const IMG_FAIL_STATES = new Set(["FAILURE", "FAILED", "ERROR", "CANCELLED", "CANCELED"]);

/** ② 轮询图片任务（信封回执；完成附 resultHeaders 供通用轮询循环带鉴权下载） */
export async function pollJmzImage(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/images/tasks/${encodeURIComponent(taskId)}`, {
			headers: { Authorization: `Bearer ${up.apiKey}` },
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		return { status: "running", progress: 50 };
	}
	const body: any = await resp.json().catch(() => ({}));
	if (resp.status >= 500 || resp.status === 429) {
		return { status: "running", progress: 50 };
	}
	if (!resp.ok) {
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body } });
		return { status: "failed", error: upstreamError(body, resp.status, "简梦Z 图片轮询") };
	}
	// 信封 data 为对象=查询回执；扁平（提交样式）容忍直读
	const d: any = body?.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : body;
	const st = String(d?.status ?? "").toUpperCase();
	if (IMG_OK_STATES.has(st)) {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body } });
		const raw = d?.result_url || d?.data?.data?.[0]?.url || d?.data?.[0]?.url;
		const url = typeof raw === "string" && /^https?:\/\//i.test(raw) ? raw : "";
		if (!url) return { status: "failed", error: "简梦Z 图片任务已完成，但响应中没有可用的结果地址" };
		// 结果链接非公开（须带 Bearer、约 2h 失效）→ 附下载头；仅本站域才附（防密钥外泄给第三方 CDN 域）
		let resultHeaders: Record<string, string> | undefined;
		try {
			const uh = new URL(url).hostname, bh = new URL(up.baseUrl).hostname;
			if (uh === bh || uh.endsWith(`.${bh}`) || bh.endsWith(`.${uh}`)) {
				resultHeaders = { Authorization: `Bearer ${up.apiKey}` };
			}
		} catch { /* 域解析失败=不附头 */ }
		return { status: "completed", videoUrl: url, resultHeaders };
	}
	if (IMG_FAIL_STATES.has(st)) {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body } });
		const msg =
			d?.fail_reason ||
			(typeof d?.error === "string" ? d.error : d?.error?.message) ||
			body?.message;
		return { status: "failed", error: msg ? String(msg) : "简梦Z 图片生成失败" };
	}
	// 信封 code 报错（如任务号不合法）且无可识别任务状态 → 终态失败
	if (body?.code != null && String(body.code).toLowerCase() !== "success" && !st) {
		return { status: "failed", error: body?.message ? String(body.message) : "简梦Z 图片任务查询失败" };
	}
	// 进度是 "100%" 字符串 → parseInt；QUEUED/PENDING=排队，其余（含未知词）=生成中继续轮询
	const p = parseInt(String(d?.progress ?? ""), 10);
	return { status: st === "QUEUED" || st === "PENDING" ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}
