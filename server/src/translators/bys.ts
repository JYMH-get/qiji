/**
 * BYS（Boyesir AI · www.boyesir.icu）视频渠道翻译器（第252轮接入，异步 submit+poll）。
 *
 * 上游（官方文档 https://www.boyesir.icu/docs，2026-08-21 实读）：
 *   提交：POST /v1/videos/generations
 *         body { model, prompt, duration?, ratio?, resolution?, images?[] }
 *         → { task_id: "canvas_vid_xxxx", status: "queued" }
 *   查询：GET /v1/tasks/{task_id}
 *         → { status: "processing" }
 *         → { status: "succeeded", result: { videos: ["https://.../xxx.mp4"] } }
 *         → { status: "failed", error: "参考图包含真实人物，平台不支持" }
 *   建议 5~10 秒轮询一次（生成通常 1~5 分钟）→ BUILTIN_POLL_INTERVALS 取 6s。
 *
 * 鉴权：`Authorization: Bearer sk-`（控制台 → 令牌创建；渠道 ch-bys / 环境 BYS_API_KEY）。
 * ⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/videos/generations、/v1/tasks/{id}）。
 *
 * ── 能力缺口（接入前已与用户确认，勿"按惯例"补字段）─────────────────────────
 * ⚠ 文档请求体**只有 `images` 参考图数组**：没有参考视频、没有参考音频、没有首尾帧字段，
 *   也没有 @tag 类引用语法 → 视频/音频素材**前置明确拒单**（绝不静默丢——丢一条即
 *   @ImageN 图例整段错位，第118轮规则）；模型一律不声明 methods（无 frames 方法）。
 *   图例注入照常（纯文本说明，上游按图序理解）。
 * ⚠ `images` 无文档上限 → 按各底模惯例在 CAPS 表里给（2.0 系 9 张、2.5 系 10 张、
 *   Kling 3 张…），超限明确报错；上游若另有更严限制会明确报错并自动退款。
 *
 * ── 参数（§9 第188/215轮定稿：原样透传，绝不夹钳/就近取档）───────────────────
 *   duration：显式值原样透传（文档「超范围自动钳到最近档位」是**上游**行为，我方不代劳）；
 *     ⚠ 缺省补该模型 CAPS.durMax——与兜底价（cost = 每秒价 × 最长时长，「默认按最高」第134轮）
 *     严格对齐，避免「按最长扣费、上游按默认短时长出片」的少交货。
 *   ratio / resolution：显式原样透传，缺省 ratio=16:9、resolution 不发（走上游默认）。
 *   ⚠ resolution 一律照发（不像 congge 那样省略）：本家多数模型分辨率是**可选参数**而非编在
 *     模型名里（`dvc-seedance-2.0` 一个名吃 480p/720p/1080p/4K）；名字里已含档位的款（sdas-gf 系）
 *     由 routes 换名时发同值，与名字一致不冲突。
 *
 * 成片：result.videos[0] 直链，**保留 48 小时**（文档「文件保留」）→ 轮询循环完成即转存 OSS。
 * 计费：上游预扣 + 失败（含 502/504）自动全额退回；402=额度不足且不产生费用。
 *
 * 【模型清单情报源】GET https://www.boyesir.icu/v1/models（需 Bearer sk-，New API 系网关，
 *   仅返回 id 无能力/价格元数据）+ 价格表在 https://www.boyesir.icu/docs 页面 HTML 内。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import { resolveNamed, injectReferenceTags } from "./jianmeng.ts";
import type { VideoSubmit, VideoPoll } from "./jianmeng.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import { numberParam, stringParam } from "./paramPass.ts";
import type { OnUpstream } from "./openai.ts";
import type { GenerateRequest } from "../contract.ts";

/** 各上游模型的能力（文档价格表的时长列 + 按底模惯例推定的参考图上限；未列名=管理端自建，不守卫直发） */
interface BysCaps {
	/** 参考图上限（文档未给，按底模惯例；超限明确报错） */
	imgMax: number;
	/** 最长时长（文档价格表「时长（秒）」列）——缺省 duration 时补它，与兜底价口径一致 */
	durMax: number;
}
const CAPS: Record<string, BysCaps> = {
	// ── Seedance 2.0 系（图 9 惯例）──
	"seedance-2.0-mini": { imgMax: 9, durMax: 12 },
	"seedance-fast-2.0": { imgMax: 9, durMax: 12 },
	"dvc-seedance-2.0": { imgMax: 9, durMax: 15 },
	"sd_2.0_special": { imgMax: 9, durMax: 12 },
	"sdas-gf-seedance-2.0-720p": { imgMax: 9, durMax: 15 },
	"sdas-gf-seedance-2.0-1080p": { imgMax: 9, durMax: 15 },
	"sdas-gf-seedance-2.0-2k": { imgMax: 9, durMax: 15 },
	"sdas-gf-seedance-2.0-4k": { imgMax: 9, durMax: 15 },
	"mindou-seedance-video": { imgMax: 9, durMax: 15 },
	"lec-seedance-fast-ht-720p": { imgMax: 9, durMax: 15 },
	"seedance2.0": { imgMax: 9, durMax: 29 },
	"lec-seedance-2-0-933-stable": { imgMax: 9, durMax: 15 },
	// ── Seedance 2.5 系（图 10）──
	"lec-ac-seedance-2-5": { imgMax: 10, durMax: 30 },
	"seedance2.5-10图": { imgMax: 10, durMax: 30 },
	// ── MiniMax H3 / Kling / Omni ──
	"lec-minimax-h3": { imgMax: 9, durMax: 15 },
	"lec-h3video-2k": { imgMax: 9, durMax: 15 },
	"kling-3.0-turbo": { imgMax: 3, durMax: 12 },
	"omni-flash-ext": { imgMax: 5, durMax: 10 },
};

/** 上游错误 → 人话（文档错误体含具体原因；OpenAI 风格 {error:{message}} 与裸 message 都探） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const raw =
		data?.error?.message ??
		(typeof data?.error === "string" ? data.error : undefined) ??
		data?.message ??
		data?.msg ??
		data?.detail;
	const msg = typeof raw === "string" ? raw.trim() : "";
	if (msg) return msg;
	if (httpStatus === 402) return `${fallback}：渠道额度不足（HTTP 402）`;
	if (httpStatus === 401) return `${fallback}：密钥无效或已失效（HTTP 401）`;
	return `${fallback} HTTP ${httpStatus}`;
}

const SUCCESS_STATES = new Set(["succeeded", "success", "completed", "complete", "done", "finished"]);
const FAILED_STATES = new Set(["failed", "fail", "error", "cancelled", "canceled", "timeout", "expired"]);
const QUEUED_STATES = new Set(["queued", "pending", "waiting"]);

/** 结果域 == 渠道 baseUrl 域时才附鉴权头（密钥绝不外发第三方 CDN，第153轮规则） */
function authHeadersFor(url: string, up: Upstream): Record<string, string> | undefined {
	try {
		if (new URL(url).hostname === new URL(up.baseUrl).hostname) return { Authorization: `Bearer ${up.apiKey}` };
	} catch { /* 非法 URL 由下载环节明确报错 */ }
	return undefined;
}

/** ① 提交视频任务 → 上游 task_id */
export async function submitBysVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "BYS 未配置上游密钥（管理端「BYS（Boyesir AI）」渠道或环境 BYS_API_KEY）" };
	}

	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);

	// ⚠ 文档请求体只有 images —— 视频/音频素材前置明确拒（绝不静默丢）
	if (vids.length || auds.length) {
		return { ok: false, error: "BYS 只支持参考图素材（该渠道无参考视频/音频字段），请移除视频/音频素材后重试" };
	}

	// ⚠ 空提示词判定必须在注入图例**之前**——带素材时图例行追加在 "{}" 之后，注入后再判会被绕过（第249轮实锤）
	let prompt = buildPrompt(req);
	if (!prompt.trim() || prompt.trim() === "{}") {
		return { ok: false, error: "提示词不能为空（该渠道 prompt 为必填项），请填写视频描述后重试" };
	}
	prompt = injectReferenceTags(prompt, { images: imgs });

	const caps = CAPS[up.upstreamModel ?? ""];
	const images = imgs.map((x) => x.url);

	// 整体/首帧参考（带故事板→params.firstFrameUrl）：追加 images **末尾** + 提示词说明行
	// （不前插防 @ImageN 编号错位；图已满上限则放弃追加——软性附加项，与 congge/算力 同规）
	const firstFrame = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";
	if (firstFrame && !images.includes(firstFrame) && (!caps || images.length < caps.imgMax)) {
		images.push(firstFrame);
		prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@Image${images.length}`;
	}
	if (caps && images.length > caps.imgMax) {
		return { ok: false, error: `该模型参考图上限 ${caps.imgMax} 张（当前 ${images.length} 张），请精简图片素材后重试` };
	}

	// ⚠ 参数原样透传（§9）；duration 缺省补 CAPS.durMax（与兜底价「默认按最高」口径一致）
	const body: Record<string, unknown> = {
		model: up.upstreamModel,
		prompt,
		duration: numberParam(req.params?.duration, caps?.durMax ?? 10),
		ratio: stringParam(req.params?.aspect_ratio, "16:9"),
	};
	const resolution = stringParam(req.params?.resolution, "");
	if (resolution) body.resolution = resolution;
	if (images.length) body.images = images;

	const url = `${up.baseUrl}/v1/videos/generations`;
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
		// ⚠ 文档未承诺提交幂等：超时/网络错误不自动重试（可能已建任务重复计费），明确报错交用户确认
		return { ok: false, error: `BYS 提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });

	const taskId = data?.task_id ?? data?.id ?? data?.data?.task_id;
	if (!resp.ok || !taskId) {
		return { ok: false, error: upstreamError(data, resp.status, "BYS 视频提交") };
	}
	return { ok: true, taskId: String(taskId) };
}

/** ② 轮询：GET /v1/tasks/{task_id} → processing / succeeded(result.videos[]) / failed(error) */
export async function pollBysVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
			headers: { Authorization: `Bearer ${up.apiKey}` },
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		return { status: "running", progress: 50 }; // 网络抖动：下一拍继续
	}
	const data: any = await resp.json().catch(() => ({}));
	// 5xx/429 = 上游瞬时故障，不终态（任务有 2h 总超时兜底）
	if (resp.status >= 500 || resp.status === 429) {
		return { status: "running", progress: 50 };
	}
	if (!resp.ok) {
		// 401 密钥失效 / 404 任务不存在（文档：任务记录保留 2 小时）→ 终态失败（自动退款）
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: upstreamError(data, resp.status, "BYS 视频轮询") };
	}

	// 信封（data 为对象）与扁平两种形态都吃
	const d: any = data?.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data : data;
	const st = String(d?.status ?? data?.status ?? "").trim().toLowerCase();

	if (FAILED_STATES.has(st)) {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		const raw = d?.error ?? data?.error ?? d?.message ?? d?.fail_reason;
		const msg = typeof raw === "string" ? raw.trim() : raw?.message;
		return { status: "failed", error: msg ? String(msg) : "BYS 视频生成失败" };
	}

	if (SUCCESS_STATES.has(st)) {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		const httpUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);
		const list: any[] = Array.isArray(d?.result?.videos)
			? d.result.videos
			: Array.isArray(d?.videos)
				? d.videos
				: [];
		// 数组元素可能是裸 URL 串，也可能是 { url } 对象（防御）
		let videoUrl = "";
		for (const v of list) {
			if (httpUrl(v)) { videoUrl = v; break; }
			if (httpUrl(v?.url)) { videoUrl = v.url; break; }
		}
		if (!videoUrl && httpUrl(d?.result?.video_url)) videoUrl = d.result.video_url;
		if (!videoUrl && httpUrl(d?.video_url)) videoUrl = d.video_url;
		if (!videoUrl) return { status: "failed", error: "BYS 完成但未返回成片链接" };
		const coverRaw = d?.result?.cover_url ?? d?.cover_url;
		return {
			status: "completed",
			videoUrl,
			coverUrl: httpUrl(coverRaw) ? coverRaw : undefined,
			resultHeaders: authHeadersFor(videoUrl, up),
		};
	}

	// queued=排队；processing 及**未公布的未知状态词**=生成中继续轮询（未知一律不终态，第234轮规则）
	const p = Number(d?.progress ?? data?.progress);
	return {
		status: QUEUED_STATES.has(st) ? "queued" : "running",
		progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : QUEUED_STATES.has(st) ? 10 : 50,
	};
}
