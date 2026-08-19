/**
 * 苏打水（简梦三模式）视频渠道翻译器（Seedance 2.0 家族，异步 submit+poll）。第131轮接入。
 *
 * 上游架构（2026-07-17 真机实测锁定）：
 *   POST /v1/video/generations                → { task_id, status:"queued" }（提交回执为扁平小写）
 *   GET  /v1/video/generations/{task_id}      → { code, data:{ status:"SUBMITTED|IN_PROGRESS|SUCCESS|FAILURE",
 *                                                  fail_reason, result_url, progress:"100%", data:{ creations:[{url}] } } }
 *   ⚠ 轮询响应是 {code,data} 包裹结构、status 大写、progress 是百分号字符串——与提交回执形状不同，两种都要吃；
 *   ⚠ 失败时 result_url 里塞的是错误文案——取成片链接必须验证是 http(s) URL。
 *
 * 请求体：{ model, prompt, duration, metadata: { payload: JSON.stringify({...}) } }——payload 是 JSON **字符串**：
 *   - 全能参考（omni）  → { mode:"references", aspectRatio, imageUrls≤9, videoUrls≤3, audioUrls≤3（合计≤12）, officialAssetIndexes? }
 *   - 首尾帧（frames）  → { mode:"frames", aspectRatio, firstFrameUrl, lastFrameUrl }
 *   提示词引用是**小写** @image1/@video1/@audio1（1 基）——我们的图例/注入是 @Image1 大写，发前统一转小写。
 * 素材直链：实测我们的 OSS（rains3）公网直链可直接用（frames 真机 SUCCESS），**无需预上传**到 files.sudashuiapi.com；
 *   成片 url 在 files.sudashuiapi.com/proxy/outputs/...（时效直链），由通用轮询循环 rehostVideo 转存永久 OSS。
 * 特殊规则：
 *   - sdas-gf-* 官方真人模型不支持参考视频（带 videoUrls 报参数错误）→ 提交前明确报错（绝不静默丢，防 @tag 图例错位）；
 *     真人图标记 params.officialAssetIndexes（0 基，客户端「真人图」多选产出）。
 *   - sdas-hn-* 上游时长只收 5/10/15 三档 → 按上游模型名探测并就近收敛。
 *   - 失败不扣上游积分（实测 credits:0），线路波动（如 bf 线 invalid_asset）由上游侧恢复。
 *   - 第149轮新线（gf2、wf、xh、pd、dj、ld2、ss-xinghe）**有意不加前缀守卫**：能力无文档（素材上限由模型
 *     matLimits 按命名下种，gf2 与 xinghe 未知不设），越界由上游报错兜底；sdas-gf2- 不命中 /^sdas-gf-/
 *     （豆包线，是否拒视频未知，不本地硬拦）。能力实锤后再按需补守卫。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import { resolveNamed, injectReferenceTags } from "./jianmeng.ts";
import type { VideoSubmit, VideoPoll } from "./jianmeng.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import type { OnUpstream } from "./openai.ts";
import type { GenerateRequest } from "../contract.ts";
import { numberParam, stringParam } from "./paramPass.ts";

/** @Image1/@Video1/@Audio1 → @image1/@video1/@audio1（苏打水按小写 1 基引用；词边界防 @Image1 误吃 @Image10） */
function lowercaseTags(prompt: string): string {
	return prompt
		.replace(/@Image(\d+)/g, "@image$1")
		.replace(/@Video(\d+)/g, "@video$1")
		.replace(/@Audio(\d+)/g, "@audio$1");
}

/** ① 提交视频生成任务 → 返回上游 task_id */
export async function submitSudashuiVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "苏打水（简梦）未配置上游密钥（管理端「苏打水（简梦）」渠道或环境 SUDASHUI_API_KEY）" };
	}
	const method = req.params?.method === "frames" ? "frames" : "omni";
	const isGf = /^sdas-gf-/.test(up.upstreamModel);

	// 素材解析（id→OSS 直链优先，拒收 .localhost 伪域）；上限按文档 9/3/3、合计 ≤12
	const imgs = resolveNamed(req.inputs?.images).slice(0, 9);
	let vids = resolveNamed(req.inputs?.videos).slice(0, 3);
	let auds = resolveNamed(req.inputs?.audios).slice(0, 3);
	if (isGf && vids.length) {
		// gf 官方真人模型不支持参考视频——明确报错（静默丢会让 @video 图例错位、用户意图丢失）
		return { ok: false, error: "gf903 官方真人模型不支持参考视频，请先移除视频素材后重试" };
	}
	while (imgs.length + vids.length + auds.length > 12) {
		// 合计超 12：从尾部先裁音频、再裁视频（图像优先保留——@image 图例主体）
		if (auds.length) auds = auds.slice(0, -1);
		else if (vids.length) vids = vids.slice(0, -1);
		else break;
	}

	// 整体参考图（带故事板→首帧）：omni 模式追加到 imageUrls 末尾（不前插，保素材 @tag 编号不错位）
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";

	// 提示词：图例/@tag 注入（与其余视频渠道同尺）→ 转小写引用
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });

	// ⚠ 时长/比例原样透传，绝不静默改写（§9 第188轮定稿，第215轮根除旧夹钳/hn 就近取档/白名单回退——
	//   按秒计费按请求参数扣，夹钳=多扣钱少交货）。档位由管理端模型参数把关，非法值由上游明确报错（失败自动退款）。
	const duration = numberParam(req.params?.duration, 15);
	const aspectRatio = stringParam(req.params?.aspect_ratio, "16:9");

	const payload: Record<string, unknown> = { aspectRatio, mode: method === "frames" ? "frames" : "references" };
	if (method === "frames") {
		// 首尾帧：首帧 = params.firstFrameUrl（带故事板）> 素材第 1 张图；尾帧 = 下一张未用的图
		const firstFrame = firstFrameParam || imgs[0]?.url || "";
		const lastFrame = firstFrameParam ? imgs[0]?.url || "" : imgs[1]?.url || "";
		if (!firstFrame || !lastFrame) {
			return { ok: false, error: "首尾帧方法需要两张图：首帧（故事板图或素材第 1 张图片）+ 尾帧（素材下一张图片），请补齐素材后重试" };
		}
		payload.firstFrameUrl = firstFrame;
		payload.lastFrameUrl = lastFrame;
	} else {
		const imageUrls = imgs.map((x) => x.url);
		if (firstFrameParam && !imageUrls.includes(firstFrameParam) && imageUrls.length < 9) {
			imageUrls.push(firstFrameParam);
			prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@image${imageUrls.length} `;
		}
		if (imageUrls.length) payload.imageUrls = imageUrls;
		if (vids.length) payload.videoUrls = vids.map((x) => x.url);
		if (auds.length) payload.audioUrls = auds.map((x) => x.url);
	}
	// 官方真人图标记（0 基下标，gf 系专属；omni 指向 imageUrls，frames 指向 首(0)/尾(1) 帧）
	if (isGf && Array.isArray(req.params?.officialAssetIndexes)) {
		const max = method === "frames" ? 2 : ((payload.imageUrls as string[] | undefined)?.length ?? 0);
		const idx = (req.params.officialAssetIndexes as unknown[])
			.map((v) => Math.round(Number(v)))
			.filter((v) => Number.isFinite(v) && v >= 0 && v < max);
		if (idx.length) payload.officialAssetIndexes = [...new Set(idx)].sort((a, b) => a - b);
	}

	const body = {
		model: up.upstreamModel,
		prompt: lowercaseTags(prompt),
		duration,
		metadata: { payload: JSON.stringify(payload) },
	};
	onUpstream?.({ request: { url: `${up.baseUrl}/v1/video/generations`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/video/generations`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		return { ok: false, error: `苏打水提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	if (!resp.ok) {
		return { ok: false, error: data?.error?.message || data?.message || `苏打水提交 HTTP ${resp.status}` };
	}
	const taskId = data?.task_id || data?.id;
	if (!taskId) return { ok: false, error: "苏打水提交未返回 task_id" };
	return { ok: true, taskId: String(taskId) };
}

/** 从轮询响应里取成片直链（失败时 result_url 是错误文案——必须验 http(s)） */
function pickVideoUrl(d: any): string {
	const cands = [d?.data?.creations?.[0]?.url, d?.creations?.[0]?.url, d?.result_url, d?.video_url];
	for (const c of cands) if (typeof c === "string" && /^https?:\/\//i.test(c)) return c;
	return "";
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④） */
export async function pollSudashuiVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/video/generations/${encodeURIComponent(taskId)}`, {
			headers: { Authorization: `Bearer ${up.apiKey}` },
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		// 网络抖动：当作仍在进行，让上层下一拍继续轮询
		return { status: "running", progress: 50 };
	}
	const raw: any = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: raw } });
		return { status: "failed", error: raw?.error?.message || raw?.message || `苏打水轮询 HTTP ${resp.status}` };
	}
	// 轮询是 {code,data:{...}} 包裹、提交回执是扁平——两种形状都吃
	const d: any = raw?.data && typeof raw.data === "object" && (raw.data.status || raw.data.task_id) ? raw.data : raw;
	const st = String(d?.status || "").toUpperCase();
	if (st === "SUCCESS") {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: raw } });
		const url = pickVideoUrl(d);
		if (!url) return { status: "failed", error: "苏打水完成但未返回成片链接" };
		const cover = d?.data?.creations?.[0]?.cover_url;
		return { status: "completed", videoUrl: url, coverUrl: typeof cover === "string" && cover ? cover : undefined };
	}
	if (st === "FAILURE" || st === "FAILED") {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: raw } });
		return { status: "failed", error: d?.fail_reason || d?.data?.message || d?.error?.message || "苏打水生成失败" };
	}
	// progress 可能是 "37%" 字符串
	const p = parseInt(String(d?.progress ?? ""), 10);
	const queued = st === "SUBMITTED" || st === "QUEUED";
	return { status: queued ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}
