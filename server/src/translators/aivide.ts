/**
 * Aivide 2.0（aivideo.beauty）视频渠道翻译器（第139轮接入，异步 submit+poll）。
 *
 * 上游架构（按官方「Aivide 2.0 视频生成 API」文档 v2.0，2026-07-17）：
 *   POST /v2/generate   body { model:"aivide-2.0", prompt, duration(4-15), ratio, resolution,
 *                              image_urls?≤9, video_urls?/audio_urls?（**合计≤3**）, generate_audio? }
 *     → { id, task_id, status:"queued", ... }（id 与 task_id 同一公开任务 ID；稳定字段仅 id/task_id/status）
 *     ⚠ 提交接口**不幂等**（文档明言）：客户端超时不得原样重试，否则重复建任务重复计费——本翻译器不做提交重试。
 *   GET  /v2/generate/{task_id} → { id, task_id, status, progress?, video_url?, stable_video_url?, result?, error? }
 *     状态归一（文档 §4.4）：pending|queued=排队 / running|processing|in_progress|unknown=生成中（继续轮询）/
 *       completed|success|succeeded=成功 / failed|failure|error|cancelled|canceled=失败。
 *     成功取结果链接顺序：video_url > stable_video_url > result（文档推荐序）；
 *     ⚠ 失败响应里即使出现非空 video_url 也**不得当结果**（文档 §4.3）——本实现只在成功状态取链接。
 *     结果是有时效的签名 URL → 由通用轮询循环 rehostVideo 转存永久 OSS。
 *   轮询建议 10-15s（文档 §4.4）→ translators/index.ts 按协议覆盖为 12s（内置缺省 8s 偏快）。
 *
 * 素材约束（文档 §3.2）：公网 HTTPS 直链；图≤9；**视频+音频合计≤3**；同一 URL 不得重复提交。
 * 守卫**绝不静默丢**（超限/重复一律明确报错，防 @ImageN 图例错位、用户意图丢失——与苏打水/星辰/画影/Dimensio 同规则）。
 * 提示词引用：该家无 @ 引用语法 → @Image1/@Video1/@Audio1 图例作普通说明文字随 prompt 发送（与画影同款）。
 * 首尾帧：文档无此字段 → 模型不声明 methods（全能参考单方法）；「带故事板」（params.firstFrameUrl）追加进
 *   image_urls **末尾**+提示词说明行（不前插防素材图例错位；已满 9 图放弃追加——软性附加项）。
 * generate_audio：可选布尔，**一律不发=走上游默认**（第122轮「撤销强制 bitrate_level」同款教训：不硬编码可选字段）；
 *   管理端给模型 params 声明 generate_audio 后客户端值才透传。
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

/** 素材上限（文档 §3.2）：图 9；视频+音频**合计** 3（区别于 dm933 的各自 3） */
const IMG_MAX = 9;
const VID_AUD_MAX = 3;

const SUCCESS_STATUSES = new Set(["completed", "success", "succeeded"]);
const FAILED_STATUSES = new Set(["failed", "failure", "error", "cancelled", "canceled"]);

/**
 * 上游错误 → 人话。两种错误结构都吃（文档 §5）：
 *   鉴权类 { error: { code, message, type } }（401 new_api_error）/ 任务类 { code, message, data }；
 *   任务失败时 error 还可能是纯字符串。message 可能带 request ID，保留便于对账。
 */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const msg =
		(typeof data?.error === "string" ? data.error : data?.error?.message) ||
		data?.message ||
		"";
	if (httpStatus === 401) return "Aivide 上游密钥无效或已停用，请联系运营检查渠道密钥";
	if (httpStatus === 402) return "Aivide 上游额度不足，请联系运营充值后重试";
	if (httpStatus === 403) return `请求被上游策略拒绝${msg ? `：${msg}` : ""}，请调整提示词/素材后重试`;
	if (httpStatus === 429) return "Aivide 上游负载已饱和或请求过频，请稍后重试";
	if (msg) return String(msg);
	return `${fallback} HTTP ${httpStatus}`;
}

/** ① 提交视频生成任务 → 返回上游 task_id */
export async function submitAivideVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "Aivide 未配置上游密钥（管理端「Aivide」渠道或环境 AIVIDE_API_KEY）" };
	}

	// 素材解析（id→OSS 直链优先，拒收 .localhost 伪域）
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);
	if (imgs.length > IMG_MAX) {
		return { ok: false, error: `参考图上限 ${IMG_MAX} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
	}
	if (vids.length + auds.length > VID_AUD_MAX) {
		return { ok: false, error: `参考视频与参考音频合计上限 ${VID_AUD_MAX} 个（当前视频 ${vids.length} + 音频 ${auds.length}），请精简后重试` };
	}
	// 同一 URL 不得重复提交（文档 §3.2）——重复即明确报错（静默去重会让 @tag 编号错位）
	const seen = new Set<string>();
	for (const it of [...imgs, ...vids, ...auds]) {
		if (seen.has(it.url)) {
			return { ok: false, error: `同一素材 URL 重复提交（${it.name || it.url}），请移除重复素材后重试` };
		}
		seen.add(it.url);
	}

	// prompt 注入 @tag 图例（编号=各模态数组序；该家无引用语法，图例作普通说明文字）
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });

	// 整体参考图（带故事板→params.firstFrameUrl）：追加 image_urls 末尾（不前插防图例错位）；已满 9 图放弃
	const images = imgs.map((x) => x.url);
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";
	if (firstFrameParam && !seen.has(firstFrameParam) && images.length < IMG_MAX) {
		images.push(firstFrameParam);
		prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@Image${images.length}`;
	}

	// ⚠ 时长/比例/分辨率原样透传，绝不静默改写（§9 第188轮定稿，第215轮根除旧夹钳/白名单回退——按秒计费
	//   按请求参数扣，夹钳=多扣钱少交货）。档位由管理端模型参数把关，非法值由上游明确报错（失败自动退款）。
	const duration = numberParam(req.params?.duration, 15);
	const resolution = stringParam(req.params?.resolution, "720p");
	const ratio = stringParam(req.params?.aspect_ratio, "16:9");

	const body: Record<string, unknown> = { model: up.upstreamModel, prompt, duration, ratio, resolution };
	if (images.length) body.image_urls = images;
	if (vids.length) body.video_urls = vids.map((x) => x.url);
	if (auds.length) body.audio_urls = auds.map((x) => x.url);
	// generate_audio 仅在客户端显式带值（=管理端声明了该参数）时透传，否则不发走上游默认
	if (typeof req.params?.generate_audio === "boolean") body.generate_audio = req.params.generate_audio;
	else if (req.params?.generate_audio === "true" || req.params?.generate_audio === "false") {
		body.generate_audio = req.params.generate_audio === "true";
	}

	onUpstream?.({ request: { url: `${up.baseUrl}/v2/generate`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v2/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		// ⚠ 提交接口不幂等：超时/网络错误不自动重试（可能已建任务），交给用户确认后再发
		return { ok: false, error: `Aivide 提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	const taskId = data?.task_id || data?.id;
	if (!resp.ok || !taskId) {
		return { ok: false, error: upstreamError(data, resp.status, "Aivide 提交") };
	}
	return { ok: true, taskId: String(taskId) };
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④）。状态归一按文档 §4.4 表 */
export async function pollAivideVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v2/generate/${encodeURIComponent(taskId)}`, {
			headers: { Authorization: `Bearer ${up.apiKey}` },
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		// 网络抖动：当作仍在进行，让上层下一拍继续轮询
		return { status: "running", progress: 50 };
	}
	const data: any = await resp.json().catch(() => ({}));
	// 5xx/429 视为上游瞬时故障：不终态，下一拍重试（任务有 2h 总超时兜底；文档 §5.2 建议退避重试）
	if (resp.status >= 500 || resp.status === 429) {
		return { status: "running", progress: 50 };
	}
	const st = String(data?.status || "").toLowerCase();
	if (!resp.ok || (!st && (data?.code != null || data?.error != null))) {
		// 400 任务 ID 不合法 / 401 密钥失效 / 404 路径错 / 跨用户查询「任务视为不存在」→ 终态失败
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: upstreamError(data, resp.status, "Aivide 轮询") };
	}
	if (SUCCESS_STATUSES.has(st)) {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		// 结果链接推荐序（文档 §4.2）：video_url > stable_video_url > result；必验 http(s)
		const url = [data?.video_url, data?.stable_video_url, data?.result].find(
			(u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u),
		);
		if (!url) return { status: "failed", error: "Aivide 任务已完成，但响应中没有可用的视频地址" };
		return { status: "completed", videoUrl: url };
	}
	if (FAILED_STATUSES.has(st)) {
		// ⚠ 失败响应可能带非空 video_url——不得当结果（文档 §4.3）；error 可能是对象或字符串
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		const msg = typeof data?.error === "string" ? data.error : data?.error?.message || data?.message;
		return { status: "failed", error: msg ? String(msg) : "Aivide 视频生成失败" };
	}
	// pending|queued=排队；running|processing|in_progress|unknown 及其它未知状态=生成中继续轮询（文档 §4.4）
	const p = Number(data?.progress);
	return { status: st === "pending" || st === "queued" ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}
