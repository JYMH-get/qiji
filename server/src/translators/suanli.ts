/**
 * 算力（xienlive.com · OctopusAI）视频渠道翻译器（第217轮接入，异步 submit+poll，Bearer sk- 鉴权）。
 *
 * 上游架构（2026-08-09 官方 api.html 内嵌 spec 实拉）：
 *   POST /api/v1/video/generate      → { success, submitId, message }（常规：文生/参考素材）
 *   POST /api/v1/video/generate-flf  → { success, submitId, message }（首尾帧）
 *   POST /api/v1/video/query {submitId}
 *     → { success, status(10 待处理/20 处理中/30 失败/40 提交失败/50 成功), statusText, completed,
 *         videoUrls[], items[{coverUrl, video:{qualities[{videoUrl,...}]}}], failMsg, queuePosition }
 *   statusText 处理中形如「生成中 62.5% (5/8)」→ 提取百分比作进度。
 *
 * 素材引用：materials 是图/视/音 URL **混排数组**，prompt 用 `<<<N>>>`（**0 基全局下标**）引用
 *（MINIMAX_H3 按 Seedance 系 0 基规则；用户示例 <<<0>>><<<1>>><<<2>>> 实锤）——
 * 我方图例注入 @Image1/@Video1/@Audio1 后按「图在前、视次之、音在后」的 materials 排列转写为下标。
 * 守卫：参考音频须伴随图或视频（模型说明明言）；MINIMAX_H3 4~15s、480p/720p/1080p 原生 + 4k 超分。
 * ⚠ `up_resolution` 默认发 `"off"`（关闭上游超分，第231轮用户定稿）——两端点同发；
 *   显式 `params.up_resolution` 按 §9 原样透传（管理端给该模型加此参数档即可让用户开关）。
 *   ⚠ 4k 档=720p 生成后超分：关闭超分时选 4k 由上游自行裁决（我方不改写、不静默拦）。
 * ⚠ 时长/比例/分辨率原样透传，绝不静默改写（§9 第188/215轮定稿）：档位由管理端模型参数把关，
 *   非法值由上游明确报错（失败自动退款）。
 * 成片：videoUrls 为 vlabvod/byteimg 等 CDN 签名时效直链（裸 fetch 可下）→ 轮询循环转存 OSS。
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

/** @Image1/@Video1/@Audio1 → <<<N>>>（0 基全局下标；materials 排列=图在前、视次之、音在后） */
export function suanliTags(prompt: string, imgCount: number, vidCount: number): string {
	return prompt
		.replace(/@Image(\d+)/g, (_m, n: string) => `<<<${Number(n) - 1}>>>`)
		.replace(/@Video(\d+)/g, (_m, n: string) => `<<<${imgCount + Number(n) - 1}>>>`)
		.replace(/@Audio(\d+)/g, (_m, n: string) => `<<<${imgCount + vidCount + Number(n) - 1}>>>`);
}

/** 上游错误 → 人话（{success:false, message} 形态；HTTP 兜底） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const msg = data?.message || data?.error?.message || data?.msg || "";
	if (msg) return String(msg);
	return `${fallback} HTTP ${httpStatus}`;
}

async function postJson(up: Upstream, path: string, body: Record<string, unknown>, onUpstream?: OnUpstream): Promise<{ resp: Response; data: any } | { error: string }> {
	onUpstream?.({ request: { url: `${up.baseUrl}${path}`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		return { error: `算力 提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	return { resp, data };
}

/** ① 提交视频生成任务 → 返回上游 submitId */
export async function submitSuanliVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "算力 未配置上游密钥（管理端「算力（xienlive）」渠道或环境 SUANLI_API_KEY）" };
	}
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);
	// 模型说明：参考音频须伴随图或视频（纯音频参考上游拒）——前置明确报错，不发单不扣费
	if (auds.length && !imgs.length && !vids.length) {
		return { ok: false, error: "该模型的参考音频须搭配至少一张图片或一条视频素材，请补充图/视素材（或移除音频）后重试" };
	}

	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });

	// ⚠ 时长/比例/分辨率原样透传（§9）；durationSeconds 上游必填 → 缺省补默认 15
	const duration = numberParam(req.params?.duration, 15);
	const aspectRatio = stringParam(req.params?.aspect_ratio, "16:9");
	const resolution = String(req.params?.resolution ?? "").trim();
	// 关闭超分：缺省恒发 "off"；显式给了按 §9 原样透传
	const upResolution = stringParam(req.params?.up_resolution, "off");

	const method = req.params?.method === "frames" ? "frames" : "omni";
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";

	if (method === "frames") {
		// ── 首尾帧（/video/generate-flf）：首=带故事板>素材第 1 图、尾=下一张未用图；只收图片（与苏打水/星辰同尺）──
		if (vids.length || auds.length) {
			return { ok: false, error: "首尾帧方法只收图片素材（首帧+尾帧），请先移除视频/音频素材（或改用全能参考方法）后重试" };
		}
		const firstFrame = firstFrameParam || imgs[0]?.url || "";
		const lastFrame = firstFrameParam ? imgs[0]?.url || "" : imgs[1]?.url || "";
		if (!firstFrame || !lastFrame) {
			return { ok: false, error: "首尾帧方法需要两张图：首帧（故事板图或素材第 1 张图片）+ 尾帧（素材下一张图片），请补齐素材后重试" };
		}
		const body: Record<string, unknown> = {
			prompt, firstFrameUrl: firstFrame, lastFrameUrl: lastFrame,
			model: up.upstreamModel, aspectRatio, durationSeconds: duration,
			up_resolution: upResolution,
		};
		if (resolution) body.resolution = resolution;
		const r = await postJson(up, "/api/v1/video/generate-flf", body, onUpstream);
		if ("error" in r) return { ok: false, error: r.error };
		if (!r.resp.ok || r.data?.success === false) return { ok: false, error: upstreamError(r.data, r.resp.status, "算力 提交") };
		const id = r.data?.submitId;
		if (!id) return { ok: false, error: "算力 提交未返回 submitId" };
		return { ok: true, taskId: String(id) };
	}

	// ── 全能参考（/video/generate）：materials 混排（图在前、视次之、音在后，与 @tag 编号一致）──
	const materials: string[] = [...imgs.map((x) => x.url), ...vids.map((x) => x.url), ...auds.map((x) => x.url)];
	// 图例 @tag → <<<N>>> 0 基下标转写（须在「整体参考图追加」之前——追加项在尾部不影响既有图/视/音下标）
	prompt = suanliTags(prompt, imgs.length, vids.length);
	// 整体参考图（带故事板→首帧）：追加 materials 末尾 + 提示词说明行（不前插防下标错位）
	if (firstFrameParam && !materials.includes(firstFrameParam)) {
		materials.push(firstFrameParam);
		prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：<<<${materials.length - 1}>>>`;
	}
	if (!prompt.trim() || prompt.trim() === "{}") {
		return { ok: false, error: "提示词不能为空：请填写视频描述后重试" };
	}

	const body: Record<string, unknown> = {
		prompt, model: up.upstreamModel, aspectRatio, durationSeconds: duration,
		up_resolution: upResolution,
	};
	if (materials.length) body.materials = materials;
	if (resolution) body.resolution = resolution;
	const r = await postJson(up, "/api/v1/video/generate", body, onUpstream);
	if ("error" in r) return { ok: false, error: r.error };
	if (!r.resp.ok || r.data?.success === false) return { ok: false, error: upstreamError(r.data, r.resp.status, "算力 提交") };
	const id = r.data?.submitId;
	if (!id) return { ok: false, error: "算力 提交未返回 submitId" };
	return { ok: true, taskId: String(id) };
}

/** ② 轮询（POST /api/v1/video/query）。状态码：10 待处理 / 20 处理中 / 30 失败 / 40 提交失败 / 50 成功 */
export async function pollSuanliVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/api/v1/video/query`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify({ submitId: taskId }),
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		return { status: "running", progress: 50 }; // 网络抖动：下一拍继续
	}
	const data: any = await resp.json().catch(() => ({}));
	if (resp.status >= 500 || resp.status === 429) {
		return { status: "running", progress: 50 }; // 上游瞬时故障：不终态（任务有 2h 总超时兜底）
	}
	if (!resp.ok) {
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: upstreamError(data, resp.status, "算力 轮询") };
	}
	const st = Number(data?.status);
	if (st === 50) {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		const url =
			(Array.isArray(data?.videoUrls) && data.videoUrls.find((u: unknown) => typeof u === "string" && /^https?:\/\//i.test(u as string))) ||
			data?.items?.[0]?.video?.qualities?.[0]?.videoUrl ||
			"";
		if (!url) return { status: "failed", error: "算力 完成但未返回成片链接" };
		const cover = typeof data?.items?.[0]?.coverUrl === "string" ? data.items[0].coverUrl : undefined;
		return { status: "completed", videoUrl: url, coverUrl: cover };
	}
	if (st === 30 || st === 40 || data?.success === false) {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		return { status: "failed", error: data?.failMsg || data?.statusText || data?.message || "算力 生成失败" };
	}
	// 处理中：statusText 形如「生成中 62.5% (5/8)」→ 提取百分比；排队/加载阶段无进度
	const pm = String(data?.statusText ?? "").match(/([\d.]+)\s*%/);
	const p = pm ? Number(pm[1]) : NaN;
	return { status: st === 10 ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}
