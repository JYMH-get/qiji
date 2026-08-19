/**
 * 简梦F（new.vosle.xyz · Seedance 2.0）视频渠道翻译器（第161轮接入，异步 submit+poll）。
 *
 * 上游架构（按对外「视频生成 API 文档」；Bearer 鉴权，JSON 形态提交——素材是公网 URL 无需 multipart）：
 *   POST /v1/videos   body { model, prompt, generate_audio?, images?, videos?, audios?,
 *                            start_frame?, end_frame? }
 *     → { id:"task_abc123", object:"video.generation", status:"pending", progress, created_at, expires_at }
 *     字段别名众多（input_reference/image[0]/reference_image/…）——**只发一套主字段**（第147轮规则，
 *     JSON 示例的 images/videos/audios 即主字段）；首尾帧走 start_frame/end_frame。
 *     ⚠ 文档未承诺提交幂等：超时/网络错误不自动重试（可能已建任务重复计费），明确报错交用户确认。
 *   GET  /v1/videos/{task_id} → { status:"pending|processing|completed|failed", progress, video_url, error }
 *     completed 取 video_url（绝对/相对两形态都吃，相对路径拼 baseUrl；缺失回退文档下载端点
 *     /v1/videos/{id}/content）；⚠ **成片下载须带同一 API Key** + 24h 时效 → poll 附 resultHeaders
 *     （仅结果域=本站域才附 Bearer，防密钥外泄给第三方 CDN——第153轮 jmz-image 同款），通用轮询循环
 *     rehostVideo 带头下载转存永久 OSS（routes.ts REHOST 白名单已放行 .vosle.xyz）。
 *     ⚠ rehost 失败回退上游直链时客户端多半下载不了（要鉴权头）——须配好 OSS，属已知边界。
 *     未知状态一律当生成中继续轮询；文档建议每 3-5 秒轮询 → index.ts 覆盖 5s。
 *
 * 模型 ID 动态拼接（文档「模型」节）：`seedance-2.0+{16:9|9:16}+{720}+{5|10|15}`——
 *   种子 upstreamModel 只存基名 "seedance-2.0"，翻译器按请求参数现拼 比例/分辨率/时长 段
 *   （与简梦H 视频「模型 ID 现拼后缀」同款）；管理端自建模型 upstreamModel 已含 "+" 段则视为
 *   完整 ID 原样直发（不重复拼）。时长离散档 5/10/15 就近取档（并列取小）；比例 16:9/9:16 越档回退 16:9；
 *   分辨率取 params.resolution 剥 "p"（缺省 720）——上游放开 1080 后管理端给 resolution 加档即放行。
 *
 * 能力/守卫（文档「输入限制」）：提示词≤8000 字符（超限前置拦截）· 图≤9 / 视≤3 / 音≤3 ·
 *   **不支持仅音频生成**（音频须搭配图/视频）· 守卫**绝不静默丢**（防 @ImageN 图例错位，与各渠道同规则）。
 * 方法（模型 methods:["omni","frames"]，该家 start_frame/end_frame 文档明确支持）：
 *   omni=全能参考（images/videos/audios 主字段 + @tag 图例注入；「带故事板」firstFrameUrl 追加 images
 *   末尾+说明行，满 9 张放弃）；frames=首尾帧（首帧=firstFrameUrl>素材第 1 图、尾帧=下一张未用图，
 *   缺任一/多余图/带视频音频一律明确报错——与苏打水/星辰/简梦Z 豆包线同尺）。
 * 提示词引用：文档无 @ 引用语法 → 注入的 @Image1/@Video1/@Audio1 图例作普通说明文字随 prompt 发送。
 * generate_audio（默认开启）：模型参数声明 enum true/false（默认 true）——客户端显式带值才透传，
 *   无法解析的值不发=走上游默认（第122轮规则）。
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

const JMF_IMG_MAX = 9;
const JMF_VID_MAX = 3;
const JMF_AUD_MAX = 3;
const JMF_PROMPT_MAX = 8000;

/** 上游错误 → 人话（OpenAI 风格错误体 {error:{message,type,code}}；HTTP 码按文档「状态码」表映射） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const msg =
		(typeof data?.error === "string" ? data.error : data?.error?.message) ||
		data?.message ||
		"";
	if (httpStatus === 401) return "简梦F 上游密钥无效或已停用，请联系运营检查渠道密钥";
	if (httpStatus === 503) return "简梦F 上游服务繁忙，请稍后重试";
	if (httpStatus === 504) return "简梦F 上游等待超时，请稍后重试";
	if (msg) return String(msg);
	return `${fallback} HTTP ${httpStatus}`;
}

/**
 * 按请求参数现拼上游模型 ID：`{基名}+{比例}+{分辨率}+{时长}`；自建完整 ID（已含 +）原样直发。
 * ⚠ 参数原样透传，绝不静默改写（§9 第188轮定稿，第215轮根除旧就近取档/白名单回退——按秒计费按请求参数扣，
 *   夹钳=多扣钱少交货）：显式值原样拼进 ID（分辨率仅剥 "p" 后缀=ID 语法格式转换非值改写），
 *   非法档位=拼出不存在的 ID 由上游明确报错（失败自动退款）；档位由管理端模型参数把关，上游放开新档=管理端加档即放行。
 */
function buildJmfModelId(up: Upstream, params?: Record<string, unknown>): string {
	if (up.upstreamModel.includes("+")) return up.upstreamModel;
	const ratio = stringParam(params?.aspect_ratio, "16:9");
	const res = stringParam(params?.resolution, "720p").replace(/p$/i, "");
	const dur = numberParam(params?.duration, 15);
	return `${up.upstreamModel}+${ratio}+${res}+${dur}`;
}

/** ① 提交视频生成任务 → 返回上游 task_id */
export async function submitJmfVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.baseUrl) {
		return { ok: false, error: "简梦F 未配置上游地址（管理端「简梦F」渠道 Base URL 或环境 JMF_BASE_URL）" };
	}
	if (!up.apiKey) {
		return { ok: false, error: "简梦F 未配置上游密钥（管理端「简梦F」渠道或环境 JMF_API_KEY）" };
	}

	// 素材解析（id→OSS 直链优先，拒收 .localhost 伪域）
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);

	if (imgs.length > JMF_IMG_MAX) {
		return { ok: false, error: `简梦F 参考图上限 ${JMF_IMG_MAX} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
	}
	if (vids.length > JMF_VID_MAX) {
		return { ok: false, error: `简梦F 参考视频上限 ${JMF_VID_MAX} 个（当前 ${vids.length} 个），请精简后重试` };
	}
	if (auds.length > JMF_AUD_MAX) {
		return { ok: false, error: `简梦F 参考音频上限 ${JMF_AUD_MAX} 个（当前 ${auds.length} 个），请精简后重试` };
	}
	// 不支持仅音频生成（文档「输入限制·注意」：音频须搭配图/视频）
	if (auds.length && !imgs.length && !vids.length) {
		return { ok: false, error: "音频参考不可单独使用（上游不支持仅音频生成），请同时搭配参考图片或参考视频后重试" };
	}

	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";

	let prompt = buildPrompt(req);
	const body: Record<string, unknown> = { model: buildJmfModelId(up, req.params as Record<string, unknown> | undefined) };

	if (String(req.params?.method ?? "") === "frames") {
		// ── 首尾帧方法（start_frame/end_frame，文档「首尾帧」示例）──
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
	} else {
		// ── 全能参考（缺省方法）：JSON 主字段 images/videos/audios + @tag 图例注入 ──
		prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });

		// 整体/首帧参考（带故事板）：追加 images 末尾（不前插防图例错位）；图满 9 张放弃（软性附加项）
		const images = imgs.map((x) => x.url);
		if (firstFrameParam && !images.includes(firstFrameParam) && images.length < JMF_IMG_MAX) {
			images.push(firstFrameParam);
			prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@Image${images.length}`;
		}

		if (images.length) body.images = images;
		if (vids.length) body.videos = vids.map((x) => x.url);
		if (auds.length) body.audios = auds.map((x) => x.url);
	}

	// 提示词≤8000 字符（文档「输入限制」）：超限前置拦截（含图例注入后实际长度）
	if (prompt.length > JMF_PROMPT_MAX) {
		return { ok: false, error: `提示词共 ${prompt.length} 个字符，超过该渠道上限 ${JMF_PROMPT_MAX}（含素材图例），请精简提示词后重试` };
	}
	body.prompt = prompt;

	// generate_audio（默认开启）：客户端显式带可解析值才透传，否则不发=走上游默认（第122轮规则）
	if (typeof req.params?.generate_audio === "boolean") body.generate_audio = req.params.generate_audio;
	else if (req.params?.generate_audio === "true" || req.params?.generate_audio === "false") {
		body.generate_audio = req.params.generate_audio === "true";
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
		return { ok: false, error: `简梦F 提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	const taskId = data?.id || data?.task_id;
	if (!resp.ok || !taskId) {
		return { ok: false, error: upstreamError(data, resp.status, "简梦F 提交") };
	}
	return { ok: true, taskId: String(taskId) };
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④）。状态：pending|processing|completed|failed */
export async function pollJmfVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
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
	// 5xx（含 503 繁忙/504 超时）/429 视为上游瞬时故障：不终态，下一拍重试（任务有 2h 总超时兜底）
	if (resp.status >= 500 || resp.status === 429) {
		return { status: "running", progress: 50 };
	}
	if (!resp.ok) {
		// 400 任务号不合法 / 401 密钥失效 / 404 任务不存在 → 终态失败
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: upstreamError(data, resp.status, "简梦F 轮询") };
	}
	const st = String(data?.status || "").toLowerCase();
	if (st === "completed") {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		// video_url 绝对/相对两形态都吃（相对拼 baseUrl）；缺失回退文档下载端点 /v1/videos/{id}/content
		const raw = data?.video_url;
		let url = "";
		if (typeof raw === "string" && /^https?:\/\//i.test(raw)) url = raw;
		else if (typeof raw === "string" && raw.startsWith("/")) url = `${up.baseUrl}${raw}`;
		if (!url) url = `${up.baseUrl}/v1/videos/${encodeURIComponent(taskId)}/content`;
		// 成片下载须带同一 API Key（文档「下载视频」）——仅结果域=本站域才附 Bearer（防密钥外泄给第三方 CDN）
		let resultHeaders: Record<string, string> | undefined;
		try {
			const uh = new URL(url).hostname, bh = new URL(up.baseUrl).hostname;
			if (uh === bh || uh.endsWith(`.${bh}`) || bh.endsWith(`.${uh}`)) {
				resultHeaders = { Authorization: `Bearer ${up.apiKey}` };
			}
		} catch { /* 域解析失败=不附头 */ }
		return { status: "completed", videoUrl: url, resultHeaders };
	}
	if (st === "failed") {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		const msg = typeof data?.error === "string" ? data.error : data?.error?.message || data?.message;
		return { status: "failed", error: msg ? String(msg) : "简梦F 视频生成失败" };
	}
	// pending=排队；processing 及未知状态=生成中继续轮询（容忍上游扩状态）
	const p = Number(data?.progress);
	return { status: st === "pending" ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}
