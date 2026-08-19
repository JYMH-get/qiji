/**
 * 通用「OpenAI 风格异步视频」翻译器（如 喵-Mega / 聚合网关的 /v1/videos）。
 *
 * 上游同样是"提交→拿 id→轮询"架构，但请求/响应字段与简梦不同：
 *   POST /v1/videos
 *     { model, prompt, duration(4-15), ratio(16:9|9:16|1:1), resolution(720p),
 *       referenceImages[≤9], referenceVideos[≤3] }       ← 纯公网 URL 数组，无需 @tag
 *   GET  /v1/videos/{id}
 *     { status: queued|in_progress|completed|failed, progress,
 *       url|video_url|metadata.{url,content_url,local_url}, error:{message,code} }
 *
 * 与简梦的差异：①宽高比键名 ratio（客户端发的是 aspect_ratio，这里做映射）；②有 resolution 档；
 * ③参考素材是 referenceImages/referenceVideos 纯 URL 数组（不靠 prompt @tag 引用）。
 * 资产链接须公网 HTTPS（id→OSS 直链优先，见 jianmeng.toPublicUrl）。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import { resolveNamed, injectReferenceTags, type VideoSubmit, type VideoPoll } from "./jianmeng.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import { numberParam, stringParam } from "./paramPass.ts";
import type { OnUpstream } from "./openai.ts";
import type { GenerateRequest } from "../contract.ts";

/** ① 提交视频生成任务 → 返回上游 task_id */
export async function submitOpenAIVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "视频渠道未配置上游密钥（管理端渠道/模型设置或环境密钥）" };
	}

	// ⚠ 时长/比例原样透传，绝不静默改写（§9 第188轮定稿，第215轮根除旧夹钳/白名单回退——按秒计费
	//   按请求参数扣，夹钳=多扣钱少交货）。档位由管理端模型参数把关，非法值由上游明确报错（失败自动退款）。
	//   宽高比键名映射保留：客户端发 aspect_ratio（也兼容 ratio）→ 上游键 ratio（键名转换非值改写）。
	const ratio = stringParam(req.params?.ratio ?? req.params?.aspect_ratio, "16:9");
	const duration = numberParam(req.params?.duration, 5);

	// 参考素材（公网可达，保序）：素材图/视频/音频按数组顺序编号 @ImageN/@VideoN/@AudioN
	const imgs = resolveNamed(req.inputs?.images).slice(0, 9);
	const vids = resolveNamed(req.inputs?.videos).slice(0, 3);
	const auds = resolveNamed(req.inputs?.audios).slice(0, 3);

	// prompt 注入 @tag（与简梦一致，幂等；上游若不识别 @tag 则参考数组仍生效）
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });
	prompt = prompt.slice(0, 1500); // 上游限 1500 字符

	// referenceImages：素材图在前（与 @ImageN 对齐），整体首帧/故事板（params.firstFrameUrl）追加在末尾、去重，≤9 张
	const firstFrame = typeof req.params?.firstFrameUrl === "string" ? req.params.firstFrameUrl : "";
	const referenceImages: string[] = [];
	for (const x of imgs) if (!referenceImages.includes(x.url)) referenceImages.push(x.url);
	if (/^https?:\/\//i.test(firstFrame) && !referenceImages.includes(firstFrame)) referenceImages.push(firstFrame);

	const referenceVideos = vids.map((x) => x.url);
	const referenceAudios = auds.map((x) => x.url);

	const body: Record<string, unknown> = {
		model: up.upstreamModel,
		prompt,
		duration,
		ratio,
		resolution: stringParam(req.params?.resolution, "720p"), // 缺省 720p；显式值原样透传（§9）
	};
	if (referenceImages.length) body.referenceImages = referenceImages.slice(0, 9);
	if (referenceVideos.length) body.referenceVideos = referenceVideos;
	if (referenceAudios.length) body.referenceAudios = referenceAudios; // 上游若不支持会忽略/报错（音频参考为尽力而为）

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
		return { ok: false, error: `视频提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	if (!resp.ok) {
		return { ok: false, error: data?.error?.message || data?.message || `视频提交 HTTP ${resp.status}` };
	}
	const taskId = data?.task_id || data?.id;
	if (!taskId) return { ok: false, error: "视频提交未返回 task_id/id" };
	return { ok: true, taskId: String(taskId) };
}

/** 从完成响应里挑出可用的视频链接（多处兜底；启动对账救回孤儿日志也用它） */
export function pickVideoUrl(data: any): string {
	return (
		data?.video_url ||
		data?.url ||
		data?.metadata?.url ||
		data?.metadata?.content_url ||
		data?.metadata?.local_url ||
		""
	);
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④） */
export async function pollOpenAIVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
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
	if (!resp.ok) {
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: data?.error?.message || `视频轮询 HTTP ${resp.status}` };
	}
	const st = String(data?.status || "");
	if (st === "completed") {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		const url = pickVideoUrl(data);
		if (!url) return { status: "failed", error: "视频完成但未返回 video_url" };
		return { status: "completed", videoUrl: String(url) };
	}
	if (st === "failed") {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		return { status: "failed", error: data?.error?.message || data?.message || "视频生成失败" };
	}
	const p = Number(data?.progress);
	return { status: st === "queued" ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}
