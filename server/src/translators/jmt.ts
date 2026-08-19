/**
 * 简梦T（llm.chre3.com · sd2-c8）视频渠道翻译器（第160轮接入，异步 submit+poll）。
 *
 * 上游架构（按对外「sd2-c8 视频生成 API 文档」，2026-07 版；OpenAI 兼容形态，Bearer 鉴权）：
 *   POST /v1/videos   body { model:"sd2-c8", prompt, duration, size?|aspect_ratio?,
 *                            image_refs?≤9, video_refs?≤3, audio_refs?≤3,
 *                            compliance_enabled?, compliance_mode? }
 *     → { id, task_id, object:"video", status:"processing", progress, seconds, size, created_at }
 *     size 与 aspect_ratio 二选一（size 只是像素/比例的另一种写法）——**只发 aspect_ratio 主字段**
 *     （分辨率 720p 固定、无档可选，不发 size；与简梦P「只发主字段」同规则）。
 *     ⚠ 文档未承诺提交幂等：超时/网络错误不自动重试（可能已建任务重复计费），明确报错交用户确认。
 *   GET  /v1/videos/{task_id} → { status:"processing|completed|failed", progress, video_url|url, error }
 *     completed 取 video_url > url（必验 http(s)；成品托管本站 /outputs/ 时效未知 → 通用轮询循环
 *     rehostVideo 转存永久 OSS，routes.ts REHOST 白名单已放行 .chre3.com）；
 *     未知状态一律当生成中继续轮询（容忍上游扩状态）。文档建议每 3-5 秒轮询 → index.ts 覆盖 5s。
 *
 * 能力（文档「模型说明/参数限制汇总」，单模型 sd2-c8 = Seedance 2.0 满血版）：
 *   720p 固定 · 时长 5-15 整数秒（默认 8）· 比例 16:9/9:16/1:1/21:9/3:4/4:3 ·
 *   图≤9 / 视≤3 / 音≤3 · **音频参考不可单独使用**（须搭配 ≥1 图或 ≥1 视频）· 真人参考支持 ·
 *   生成音频默认开启（无开关字段，走上游默认）。无首尾帧字段 → 不声明 methods（全能参考单方法）。
 * 守卫**绝不静默丢**（超限/音频缺搭配一律明确报错，防 @ImageN 图例错位——与简梦P/星辰/画影同规则）。
 *
 * 提示词引用：**该家原生就用 @Image1/@Video1/@Audio1 占位符**（编号 1 起、与 image_refs/video_refs/
 * audio_refs 数组顺序一一对应）——与我们 injectReferenceTags 注入的 @tag 约定完全一致，直通零转写
 * （区别于苏打水小写 @image1 / Dimensio @image_file_1 需转写的渠道）。
 * 「带故事板」（params.firstFrameUrl）：追加进 image_refs **末尾**+提示词说明行（不前插防素材图例错位；
 *   图已满 9 张放弃追加——软性附加项）。
 *
 * 合规素材（本文档新增的「人脸参数」）：compliance_enabled + compliance_mode
 * （colored-pencil 彩铅 / watercolor 水彩 / fishnet 渔网 / grid 眼部遮罩）。
 * 客户端经模型参数 compliance_mode 下拉选择（"off"=不开启→两字段都不发，走上游默认关闭）；
 * 值不在白名单一律不发（防上游 400）。
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

const JMT_IMG_MAX = 9;
const JMT_VID_MAX = 3;
const JMT_AUD_MAX = 3;
const JMT_COMPLIANCE_MODES = ["colored-pencil", "watercolor", "fishnet", "grid"];

/** 上游错误 → 人话（OpenAI 风格错误体 {error:{message,type}}；HTTP 码按文档表映射） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const msg =
		(typeof data?.error === "string" ? data.error : data?.error?.message) ||
		data?.message ||
		"";
	if (httpStatus === 401) return "简梦T 上游密钥无效或已停用，请联系运营检查渠道密钥";
	if (httpStatus === 402) return "简梦T 上游额度不足，请联系运营充值后重试";
	if (httpStatus === 429) return "简梦T 上游并发已满或请求过频，请稍后重试";
	if (msg) return String(msg);
	return `${fallback} HTTP ${httpStatus}`;
}

/** ① 提交视频生成任务 → 返回上游 task_id */
export async function submitJmtVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.baseUrl) {
		return { ok: false, error: "简梦T 未配置上游地址（管理端「简梦T」渠道 Base URL 或环境 JMT_BASE_URL）" };
	}
	if (!up.apiKey) {
		return { ok: false, error: "简梦T 未配置上游密钥（管理端「简梦T」渠道或环境 JMT_API_KEY）" };
	}

	// 素材解析（id→OSS 直链优先，拒收 .localhost 伪域）
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);

	if (imgs.length > JMT_IMG_MAX) {
		return { ok: false, error: `简梦T 参考图上限 ${JMT_IMG_MAX} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
	}
	if (vids.length > JMT_VID_MAX) {
		return { ok: false, error: `简梦T 参考视频上限 ${JMT_VID_MAX} 个（当前 ${vids.length} 个），请精简后重试` };
	}
	if (auds.length > JMT_AUD_MAX) {
		return { ok: false, error: `简梦T 参考音频上限 ${JMT_AUD_MAX} 个（当前 ${auds.length} 个），请精简后重试` };
	}
	// 音频参考不可单独使用（文档「音频参考限制」：需至少搭配 1 张图片或 1 条视频参考）
	if (auds.length && !imgs.length && !vids.length) {
		return { ok: false, error: "音频参考不可单独使用（上游要求），请同时搭配至少一张参考图片或一条参考视频后重试" };
	}

	// prompt 注入 @tag 图例（编号=各模态数组序，1 起）——与该家原生 @Image1/@Video1/@Audio1 占位符语法一致，直通
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });

	// 整体/首帧参考（带故事板→params.firstFrameUrl）：追加 image_refs 末尾（不前插防图例错位）；图满 9 张放弃
	const images = imgs.map((x) => x.url);
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";
	if (firstFrameParam && !images.includes(firstFrameParam) && images.length < JMT_IMG_MAX) {
		images.push(firstFrameParam);
		prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@Image${images.length}`;
	}

	// ⚠ 时长/比例原样透传，绝不静默改写（§9 第188轮定稿，第215轮根除旧夹钳 [5,15]/比例白名单回退——
	//   按秒计费按请求参数扣，夹钳=多扣钱少交货）。档位由管理端模型参数把关，非法值由上游明确报错（失败自动退款）。
	//   分辨率 720p 固定无档，不发 size。
	const duration = numberParam(req.params?.duration, 15);
	const aspect_ratio = stringParam(req.params?.aspect_ratio, "16:9");

	const body: Record<string, unknown> = { model: up.upstreamModel, prompt, duration, aspect_ratio };
	if (images.length) body.image_refs = images;
	if (vids.length) body.video_refs = vids.map((x) => x.url);
	if (auds.length) body.audio_refs = auds.map((x) => x.url);
	// 合规素材（人脸合规风格）：客户端经模型参数 compliance_mode 下拉（"off"=不开启）；
	// 命中白名单才发 enabled+mode，其余（off/未知值/未声明）两字段都不发=走上游默认关闭。
	// 另容忍管理端把 compliance_enabled 单独声明为 boolean 参数的形态（true 时只开启不带风格）。
	const modeRaw = String(req.params?.compliance_mode ?? "");
	if (JMT_COMPLIANCE_MODES.includes(modeRaw)) {
		body.compliance_enabled = true;
		body.compliance_mode = modeRaw;
	} else if (req.params?.compliance_enabled === true || req.params?.compliance_enabled === "true") {
		body.compliance_enabled = true;
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
		return { ok: false, error: `简梦T 提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	const taskId = data?.task_id || data?.id;
	if (!resp.ok || !taskId) {
		return { ok: false, error: upstreamError(data, resp.status, "简梦T 提交") };
	}
	return { ok: true, taskId: String(taskId) };
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④）。状态：processing|completed|failed */
export async function pollJmtVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
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
		return { status: "failed", error: upstreamError(data, resp.status, "简梦T 轮询") };
	}
	const st = String(data?.status || "").toLowerCase();
	if (st === "completed") {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		// 结果序 video_url > url（两字段文档明示同值，防其一缺失）；必验 http(s)
		const pick = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v) ? v : "");
		const url = pick(data?.video_url) || pick(data?.url);
		if (!url) return { status: "failed", error: "简梦T 任务已完成，但响应中没有可用的视频地址" };
		return { status: "completed", videoUrl: url };
	}
	if (st === "failed") {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		const msg = typeof data?.error === "string" ? data.error : data?.error?.message || data?.message;
		return { status: "failed", error: msg ? String(msg) : "简梦T 视频生成失败" };
	}
	// processing 及未知状态=生成中继续轮询（容忍上游扩状态；文档只公布 processing/completed/failed 三态）
	const p = Number(data?.progress);
	return { status: "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}
