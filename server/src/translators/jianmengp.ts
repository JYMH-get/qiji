/**
 * 简梦P（Sora/Veo 系）视频渠道翻译器（第147轮接入，异步 submit+poll）。
 *
 * 上游架构（按对外「Video API」文档，2026-07 版；⚠ 文档未给 Base URL——渠道/环境必须配置，缺失即明确报错）：
 *   POST /v1/videos   body { model, prompt, aspect_ratio, duration, resolution?(仅 veo31 系),
 *                            image_urls?, video_urls?, audio_urls?, generate_audio?, negative_prompt? }
 *     → { task_id, model, status:"queued", progress, created_at }
 *     字段别名（image_url/input_reference/reference_* / seconds / size 等）一概不用——只发主字段，天然规避
 *     「主字段与别名内容不一致」失败项；size 只是比例别名，比例一律走 aspect_ratio。
 *     ⚠ 文档未承诺提交幂等：超时/网络错误不自动重试（可能已建任务重复计费），明确报错交用户确认。
 *   GET  /v1/videos/{task_id} → { task_id, status:"queued|in_progress|completed|failed", progress, video_url, error }
 *     completed 取 video_url（必验 http(s)，时效未知 → 通用轮询循环 rehostVideo 转存永久 OSS）；
 *     未知状态一律当生成中继续轮询（容忍上游扩状态）。轮询建议 10-15s（文档 Failure Notes）→ index.ts 覆盖 12s。
 *
 * 模型能力矩阵（文档「Model Capability Matrix」，CAPS 静态表守卫；上游调整时同步维护）：
 *   sora2：720p 固定 · 16:9/9:16 · 时长 4/8/12 · 图≤1、无视频/音频参考
 *   Sora V3 系（pro/pro-1080p/fast）：分辨率由模型名固定（不随请求下发）· 六比例 · 时长 4-15 整数 ·
 *     图≤9/视≤3/音≤3 且合计≤12 · 音频参考必须搭配图/视频 · 提示词≤2500 字符（超限上游 400 且不建任务 → 前置拦截）
 *   gemini-omni-flash（第159轮新增）：720p/1080p（默认 720p，随请求下发）· 16:9/9:16 · 时长 4/6/8/10 ·
 *     图≤5（风格参考）/视≤1（源视频参考）、无音频参考。
 *   veo31-fast：720p/1080p（默认 1080p，随请求下发）· 16:9/9:16 · 时长 4/6/8 · 图≤2、无视频/音频；
 *     图片即帧参考（1 图=首帧、2 图=首+尾帧，上游按语义解释）——无独立「方法」维度。
 *   ⚠ veo31 / veo31-ref 已于第159轮按 2026-07 文档「Supported Models」清单下架（内置模型删除进墓碑，
 *     models.ts ⑤g）：veo31 仅存能力矩阵 → CAPS 守卫保留（管理端按矩阵重建同 id 即恢复接入）；
 *     veo31-ref 文档整体消失 → CAPS 条目一并删除（重建时按「未知上游名」不守卫直发、上游自校验）。
 * 守卫**绝不静默丢**（超限/缺搭配一律明确报错，防 @ImageN 图例错位——与苏打水/星辰/画影/Dimensio/Aivide 同规则）。
 * 提示词引用：文档无 @ 引用语法 → @Image1/@Video1/@Audio1 图例作普通说明文字随 prompt 发送（与画影/Aivide 同款）。
 * 「带故事板」（params.firstFrameUrl）：追加进 image_urls **末尾**+提示词说明行（不前插防素材图例错位；
 *   图已满上限放弃追加——软性附加项。veo31-fast 无素材图时它即首帧）。
 * generate_audio（Sora V3 默认 true）：**一律不发=走上游默认**（第122轮「撤销强制 bitrate_level」教训）；
 *   管理端给模型 params 声明后客户端值才透传。negative_prompt 同理（客户端显式带非空值才发）。
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

/** 单模型能力（键=上游模型名）。未知上游名（管理端自建）不守卫直发（翻译层放行，上游自校验） */
interface JmpCaps {
	imgMax: number;
	vidMax: number;
	audMax: number;
	/** 三类参考合计上限（Sora V3=12；无=不限合计） */
	totalMax?: number;
	/** 离散时长档（就近取档）；与 durMin/durMax 二选一 */
	durations?: number[];
	durMin?: number;
	durMax?: number;
	aspects: string[];
	/** 需随请求下发 resolution 的档位（veo31 系）；缺省=分辨率由模型名固定、不发该字段（Sora 系） */
	resolutions?: string[];
	/** 提示词字符上限（Sora V3=2500，超限上游 400 且不建任务 → 前置拦截） */
	promptMax?: number;
}

const SORA_V3_CAPS: JmpCaps = {
	imgMax: 9, vidMax: 3, audMax: 3, totalMax: 12,
	durMin: 4, durMax: 15,
	aspects: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
	promptMax: 2500,
};
const VEO_CAPS = (imgMax: number): JmpCaps => ({
	imgMax, vidMax: 0, audMax: 0,
	durations: [4, 6, 8],
	aspects: ["16:9", "9:16"],
	resolutions: ["1080p", "720p"],
});
/** 能力表（2026-07 文档「Model Capability Matrix」）；上游放开/调整能力时同步维护 */
const CAPS: Record<string, JmpCaps> = {
	"sora2": { imgMax: 1, vidMax: 0, audMax: 0, durations: [4, 8, 12], aspects: ["16:9", "9:16"] },
	"sora-v3-pro": SORA_V3_CAPS,
	"sora-v3-pro-1080p": SORA_V3_CAPS,
	"sora-v3-fast": SORA_V3_CAPS,
	// gemini-omni-flash（2026-07 文档新增）：图=风格参考、视频=源视频参考；分辨率随请求下发（默认 720p 首档）
	"gemini-omni-flash": {
		imgMax: 5, vidMax: 1, audMax: 0,
		durations: [4, 6, 8, 10],
		aspects: ["16:9", "9:16"],
		resolutions: ["720p", "1080p"],
	},
	// veo31：模型已下架（第159轮）但文档能力矩阵仍在——守卫留给管理端重建场景；veo31-ref 文档消失、条目已删
	"veo31": VEO_CAPS(2),
	"veo31-fast": VEO_CAPS(2),
};

/** 上游错误 → 人话（错误体形态未定：error 可能是字符串或 {message}，message 兜底） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const msg =
		(typeof data?.error === "string" ? data.error : data?.error?.message) ||
		data?.message ||
		"";
	if (httpStatus === 401) return "简梦P 上游密钥无效或已停用，请联系运营检查渠道密钥";
	if (httpStatus === 402) return "简梦P 上游额度不足，请联系运营充值后重试";
	if (httpStatus === 429) return "简梦P 上游负载已饱和或请求过频，请稍后重试";
	if (msg) return String(msg);
	return `${fallback} HTTP ${httpStatus}`;
}

/** ① 提交视频生成任务 → 返回上游 task_id */
export async function submitJianmengpVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.baseUrl) {
		return { ok: false, error: "简梦P 未配置上游地址（管理端「简梦P」渠道 Base URL 或环境 JIANMENGP_BASE_URL）" };
	}
	if (!up.apiKey) {
		return { ok: false, error: "简梦P 未配置上游密钥（管理端「简梦P」渠道或环境 JIANMENGP_API_KEY）" };
	}

	// 素材解析（id→OSS 直链优先，拒收 .localhost 伪域）
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);
	const caps = CAPS[up.upstreamModel];

	if (caps) {
		if (caps.vidMax === 0 && vids.length) {
			return { ok: false, error: `模型「${up.upstreamModel}」不支持参考视频（本次携带 ${vids.length} 个），请移除视频素材或换用 Sora V3 系模型` };
		}
		if (caps.audMax === 0 && auds.length) {
			return { ok: false, error: `模型「${up.upstreamModel}」不支持参考音频（本次携带 ${auds.length} 个），请移除音频素材或换用 Sora V3 系模型` };
		}
		if (imgs.length > caps.imgMax) {
			return { ok: false, error: `模型「${up.upstreamModel}」参考图上限 ${caps.imgMax} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
		}
		if (vids.length > caps.vidMax) {
			return { ok: false, error: `模型「${up.upstreamModel}」参考视频上限 ${caps.vidMax} 个（当前 ${vids.length} 个），请精简后重试` };
		}
		if (auds.length > caps.audMax) {
			return { ok: false, error: `模型「${up.upstreamModel}」参考音频上限 ${caps.audMax} 个（当前 ${auds.length} 个），请精简后重试` };
		}
		if (caps.totalMax && imgs.length + vids.length + auds.length > caps.totalMax) {
			return { ok: false, error: `图片、视频与音频参考合计上限 ${caps.totalMax} 个（当前 ${imgs.length + vids.length + auds.length} 个），请精简素材后重试` };
		}
	}
	// 音频参考必须搭配至少一张图片或一个视频参考（文档 Reference Media Input Format，通用规则）
	if (auds.length && !imgs.length && !vids.length) {
		return { ok: false, error: "音频参考必须同时搭配至少一张参考图片或一个参考视频（上游要求），请补充图片/视频素材后重试" };
	}

	// prompt 注入 @tag 图例（编号=各模态数组序；该家无引用语法，图例作普通说明文字）
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });

	// 整体/首帧参考（带故事板→params.firstFrameUrl）：追加 image_urls 末尾（不前插防图例错位）；图满上限放弃
	const images = imgs.map((x) => x.url);
	const imgRoom = caps ? caps.imgMax : 9;
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";
	if (firstFrameParam && !images.includes(firstFrameParam) && images.length < imgRoom) {
		images.push(firstFrameParam);
		prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@Image${images.length}`;
	}

	// Sora V3 提示词≤2500 字符：超限上游 400 且不建任务 → 前置明确报错（含图例注入后的实际长度）
	if (caps?.promptMax && prompt.length > caps.promptMax) {
		return { ok: false, error: `提示词共 ${prompt.length} 个字符，超过该模型上限 ${caps.promptMax}（含素材图例），请精简提示词后重试` };
	}

	// ⚠ 时长/比例/分辨率原样透传，绝不静默改写（§9 第188轮定稿，第215轮根除旧就近取档/夹紧/能力表回退——
	//   按秒计费按请求参数扣，夹钳=多扣钱少交货）。档位由管理端模型参数把关，非法值由上游明确报错（失败自动退款）。
	//   缺省时长的默认档：离散档取末档（最长）/区间取上限（与旧缺省行为一致），未知模型 8。
	const durDefault = caps?.durations ? caps.durations[caps.durations.length - 1] : caps ? (caps.durMax ?? 15) : 8;
	const duration = numberParam(req.params?.duration, durDefault);
	const aspect_ratio = stringParam(req.params?.aspect_ratio, "16:9");

	const body: Record<string, unknown> = { model: up.upstreamModel, prompt, aspect_ratio, duration };
	// 分辨率：仅 veo31 系随请求下发（缺省=默认首档）；Sora 系由模型名固定，不发该字段
	if (caps?.resolutions) {
		body.resolution = stringParam(req.params?.resolution, caps.resolutions[0]);
	}
	if (images.length) body.image_urls = images;
	if (vids.length) body.video_urls = vids.map((x) => x.url);
	if (auds.length) body.audio_urls = auds.map((x) => x.url);
	// generate_audio / negative_prompt：仅客户端显式带值（=管理端声明了该参数）时透传，否则不发走上游默认
	if (typeof req.params?.generate_audio === "boolean") body.generate_audio = req.params.generate_audio;
	else if (req.params?.generate_audio === "true" || req.params?.generate_audio === "false") {
		body.generate_audio = req.params.generate_audio === "true";
	}
	if (typeof req.params?.negative_prompt === "string" && req.params.negative_prompt.trim()) {
		body.negative_prompt = req.params.negative_prompt.trim();
	}

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
		// ⚠ 文档未承诺提交幂等：超时/网络错误不自动重试（可能已建任务），交给用户确认后再发
		return { ok: false, error: `简梦P 提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	const taskId = data?.task_id || data?.id;
	if (!resp.ok || !taskId) {
		return { ok: false, error: upstreamError(data, resp.status, "简梦P 提交") };
	}
	return { ok: true, taskId: String(taskId) };
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④）。状态：queued|in_progress|completed|failed */
export async function pollJianmengpVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
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
		// 400 任务 ID 不合法 / 401 密钥失效 / 404 任务不存在 → 终态失败
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: upstreamError(data, resp.status, "简梦P 轮询") };
	}
	const st = String(data?.status || "").toLowerCase();
	if (st === "completed") {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		const url = typeof data?.video_url === "string" && /^https?:\/\//i.test(data.video_url) ? data.video_url : "";
		if (!url) return { status: "failed", error: "简梦P 任务已完成，但响应中没有可用的视频地址" };
		return { status: "completed", videoUrl: url };
	}
	if (st === "failed") {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		const msg = typeof data?.error === "string" ? data.error : data?.error?.message || data?.message;
		return { status: "failed", error: msg ? String(msg) : "简梦P 视频生成失败" };
	}
	// queued=排队；in_progress 及未知状态=生成中继续轮询（容忍上游扩状态）
	const p = Number(data?.progress);
	return { status: st === "queued" ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}
