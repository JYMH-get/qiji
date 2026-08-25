/**
 * 简梦P 视频渠道翻译器（第147轮接入；第242轮按 2026-08 新版文档全站重写，异步 submit+poll）。
 *
 * 情报源：无自助模型目录端点——更新靠用户提供新版文档（2026-08 版起 Base URL 明给：https://api.pixellelabs.com，
 *   渠道 Base URL 或环境 JIANMENGP_BASE_URL 配置；缺失即明确报错）。
 *
 * 上游（2026-08 版「视频生成接口说明」，Bearer 鉴权）：
 *   POST /v1/videos body { model, prompt, aspect_ratio, resolution, seconds(建议字符串，兼容数字),
 *                          reference_image_urls?, reference_videos?, audio_urls? }
 *     → { id, task_id, status:"processing", progress, created_at, seconds, size }
 *     素材字段选型（只发一套主字段，规避「主字段与别名不一致」失败项）：
 *       图片**只发 reference_image_urls**——文档明示「仅传 reference_image_urls（不传 image_url）时按数组
 *       顺序依次参考，即 @image1 至 @image9」，与 image_url+reference_image_urls 拆分语义等价且编号
 *       天然与我方图例一一对应；视频恒 reference_videos、音频恒 audio_urls 数组形态
 *       （单条别名 reference_video / audio_url / reference_images 一概不用）。
 *     ⚠ 文档未承诺提交幂等：超时/网络错误不自动重试（可能已建任务重复计费），明确报错交用户确认。
 *   GET  /v1/videos/{task_id} → { task_id, status:"queued|processing|completed|failed", progress, video_url }
 *     completed 的 video_url=本站下载端点 /v1/videos/{id}/content，**下载须带 Bearer**（文档「下载视频」
 *     curl 示例带 Authorization）→ poll 返回 resultHeaders **仅对本站域附头**（第153/161轮规则，密钥绝不
 *     外发第三方 CDN），由通用轮询循环带头下载转存永久 OSS。未知状态一律当生成中继续轮询。
 *
 * 能力与请求形状（按 CAPS.shape 双形态；第242轮补充用户令恢复 gemini/veo 两款）：
 *   h3（H3video-2k，2026-08 文档主形态）：分辨率仅 2K · 时长仅 15s · 六比例 · 图≤9/视≤3/音≤3 且
 *     **合计≤12** · **不支持尾帧图**；参考视频/音频时长约束（视频单条≤15s、音频单条 2-15s、各自总≤15s）
 *     服务端不探测、上游自校验。字段族=reference_image_urls/reference_videos/audio_urls + seconds 字符串 +
 *     resolution 必发；图例经 jmpLowerTags 转写小写 @image1/@video1/@audio1（文档明示语法，苏打水小写/
 *     Dimensio @image_file_N 同先例）。
 *   legacy（gemini-omni-flash / veo31-fast，第159轮 2026-07 文档形态原样恢复）：字段族=image_urls/
 *     video_urls/audio_urls + duration 数字（缺省=离散档末档）+ resolution（有 resolutions 才发，首档默认）；
 *     图例保持 @ImageN 大写作普通说明文字（旧文档无引用语法）。⚠ 新文档虽言「当前仅支持 H3video-2k」，
 *     用户令保留这两款——上游若真已下线=明确报错+失败自动退款，无静默风险。
 *   未知上游名（管理端自建）：不守卫直发，按 h3 形态（站方当前文档的主字段族）。
 * 守卫**绝不静默丢**（超限/不支持一律明确报错，防图例错位——与苏打水/星辰/画影同规则）。
 * seconds|duration/resolution/aspect_ratio 原样透传（§9 绝不静默改写）：显式值原样、缺省才补默认；
 *   计费恒走 costField=duration（客户端参数键保持 duration，h3 形态由翻译器换算为上游 seconds 字符串）。
 *   旧 generate_audio/negative_prompt 字段新文档已无 → 两形态均不再发送。
 * 「带故事板」（params.firstFrameUrl）：追加图片数组**末尾**+提示词说明行（不前插防素材图例错位；
 *   图已满上限放弃追加——软性附加项）。
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

/** 单模型能力（键=上游模型名）。未知上游名（管理端自建）不守卫直发（翻译层放行，上游自校验，按 h3 形态） */
interface JmpCaps {
	/** 请求形状：h3=2026-08 新文档字段族 / legacy=第159轮旧字段族（恢复款专用） */
	shape: "h3" | "legacy";
	imgMax: number;
	vidMax: number;
	audMax: number;
	/** 三类参考合计上限（H3video-2k=12）；无=不限合计 */
	totalMax?: number;
	/** legacy：离散时长档（缺省默认=末档） */
	durations?: number[];
	/** legacy：需随请求下发 resolution 的档位（缺省默认=首档）；缺省=不发该字段 */
	resolutions?: string[];
}

/** 能力表（h3 按 2026-08 文档「参数说明/使用说明」；legacy 两款按第159轮 2026-07 文档矩阵原样恢复） */
const CAPS: Record<string, JmpCaps> = {
	"H3video-2k": { shape: "h3", imgMax: 9, vidMax: 3, audMax: 3, totalMax: 12 },
	"gemini-omni-flash": { shape: "legacy", imgMax: 5, vidMax: 1, audMax: 0, durations: [4, 6, 8, 10], resolutions: ["720p", "1080p"] },
	"veo31-fast": { shape: "legacy", imgMax: 2, vidMax: 0, audMax: 0, durations: [4, 6, 8], resolutions: ["1080p", "720p"] },
};

/** @ImageN/@VideoN/@AudioN（图例注入约定）→ 文档小写 @imageN/@videoN/@audioN */
function jmpLowerTags(text: string): string {
	return text
		.replace(/@Image(\d+)/g, "@image$1")
		.replace(/@Video(\d+)/g, "@video$1")
		.replace(/@Audio(\d+)/g, "@audio$1");
}

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
			return { ok: false, error: `模型「${up.upstreamModel}」不支持参考视频（本次携带 ${vids.length} 个），请移除视频素材或换用 H3video-2k` };
		}
		if (caps.audMax === 0 && auds.length) {
			return { ok: false, error: `模型「${up.upstreamModel}」不支持参考音频（本次携带 ${auds.length} 个），请移除音频素材或换用 H3video-2k` };
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

	// prompt 注入 @tag 图例（编号=各模态数组序；h3 形态末尾统一转写为文档的小写 @imageN/@videoN/@audioN）
	const shape = caps?.shape ?? "h3";
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });

	// 整体/首帧参考（带故事板→params.firstFrameUrl）：追加图片数组末尾（不前插防图例错位）；图满上限放弃
	const images = imgs.map((x) => x.url);
	const imgRoom = caps ? caps.imgMax : 9;
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";
	if (firstFrameParam && !images.includes(firstFrameParam) && images.length < imgRoom) {
		images.push(firstFrameParam);
		prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@Image${images.length}`;
	}
	if (shape === "h3") prompt = jmpLowerTags(prompt);

	// ⚠ 时长/比例/分辨率原样透传，绝不静默改写（§9 第188轮定稿——按秒计费按请求参数扣，夹钳=多扣钱少交货）。
	//   档位由管理端模型参数把关，非法值由上游明确报错（失败自动退款）。
	const aspect_ratio = stringParam(req.params?.aspect_ratio, "16:9");
	const body: Record<string, unknown> = { model: up.upstreamModel, prompt, aspect_ratio };
	if (shape === "h3") {
		// seconds 按新文档建议以字符串下发（数字串归一后转字符串保值不变，非数字原样发出上游报错可见）
		body.seconds = String(numberParam(req.params?.duration, 15));
		body.resolution = stringParam(req.params?.resolution, "2K");
		if (images.length) body.reference_image_urls = images;
		if (vids.length) body.reference_videos = vids.map((x) => x.url);
		if (auds.length) body.audio_urls = auds.map((x) => x.url);
	} else {
		// legacy（第159轮形态原样）：duration 数字、resolution 仅声明了档位的模型才发（缺省=默认首档）
		const durDefault = caps?.durations ? caps.durations[caps.durations.length - 1] : 8;
		body.duration = numberParam(req.params?.duration, durDefault);
		if (caps?.resolutions) body.resolution = stringParam(req.params?.resolution, caps.resolutions[0]);
		if (images.length) body.image_urls = images;
		if (vids.length) body.video_urls = vids.map((x) => x.url);
		if (auds.length) body.audio_urls = auds.map((x) => x.url);
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

/** 结果域与上游同 host 才附 Bearer（成片下载端点须鉴权；密钥绝不外发第三方 CDN——第153/161轮规则） */
function sameUpstreamHost(url: string, baseUrl: string): boolean {
	try {
		return new URL(url).host === new URL(baseUrl).host;
	} catch {
		return false;
	}
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④）。状态：queued|processing|completed|failed */
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
		if (sameUpstreamHost(url, up.baseUrl)) {
			return { status: "completed", videoUrl: url, resultHeaders: { Authorization: `Bearer ${up.apiKey}` } };
		}
		return { status: "completed", videoUrl: url };
	}
	if (st === "failed") {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		const msg = typeof data?.error === "string" ? data.error : data?.error?.message || data?.message;
		return { status: "failed", error: msg ? String(msg) : "简梦P 视频生成失败" };
	}
	// queued=排队；processing 及未知状态=生成中继续轮询（容忍上游扩状态）
	const p = Number(data?.progress);
	return { status: st === "queued" ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}
