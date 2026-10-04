/**
 * 「官方」Seedance 2.0 / 2.5 视频渠道（异步 submit+poll）。
 *
 * 用户提供文档（2026-09-03）：
 *   提交：POST /v1/videos/generations      -> { id }
 *   查询：GET  /v1/videos/generations/{id} -> queued | running | succeeded | failed | expired
 *   成片：content.video_url
 *   鉴权：Authorization: Bearer <API_KEY>
 *   素材：content[]，图片/视频/音频分别使用 image_url/video_url/audio_url 对象和 reference_* role；
 *         首尾帧使用 first_frame / last_frame role。
 *   素材数量只执行管理端 matLimits；大小、媒体类型和组合能力由上游返回结果，
 *   不把文档示例/默认规格额外写成翻译器硬限制。
 *   官方素材库线路全部图片、视频、音频按 materialPolicy 准备；生成复用服务端已认证的 Active ID。
 *
 * Base URL：https://kwjm.com（根域，不带 /v1）；部署后在 ch-official 填 Key（或 OFFICIAL_API_KEY）。
 * ⚠ 文档未给价格、轮询频率或成片实际托管域：
 *   - 模型先用占位价，上线前据官方价格或小额真单定真价；
 *   - 真单后据请求记录 ④ 段补成片 CDN 域白名单。
 * 【模型清单情报源】GET https://kwjm.com/v1/models（需 Bearer；2026-09-03 无鉴权探测返回 401，
 *   说明端点存在）；/api/pricing、/llms.txt、/ai-api/models、/generation/config 同日探测均为 404。
 */
import { buildPrompt } from "./prompt.ts";
import { upstreamCreditFeedback, UPSTREAM_CREDIT_SHORTAGE } from '../creditFeedback.ts';
import { maskToken } from "../store/logs.ts";
import { toPublicUrl, injectReferenceTags } from "./jianmeng.ts";
import type { VideoSubmit, VideoPoll } from "./jianmeng.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import { numberParam, stringParam } from "./paramPass.ts";
import type { OnUpstream } from "./openai.ts";
import type { AssetRef, GenerateRequest } from "../contract.ts";
import { getModelDef } from "../store/models.ts";
import { officialIdentityUrl } from "../officialMaterials.ts";
import { materialPolicyForModel } from "../materialPolicy.ts";
import { checkMaterialLimits } from "../materialLimits.ts";

const OFFICIAL_PATH = "/v1/videos/generations";
const SUCCESS_STATES = new Set(["succeeded"]);
const FAILED_STATES = new Set(["failed", "expired"]);
const QUEUED_STATES = new Set(["queued"]);

function isSeedance25(modelId: string, upstreamModel: string): boolean {
	// 这里只判断视频生成参数能力；素材分组由独立 materialPolicy 明确配置。
	if (/^off-sd2\.5(?:-|$)/.test(modelId)) return true;
	if (/^off-sd2\.0(?:-|$)/.test(modelId)) return false;
	// 兼容管理端后续新增的 official-video 视频能力。
	return /(?:^|[^0-9])2[.-]5(?:[^0-9]|$)/i.test(upstreamModel);
}

function contentItem(kind: "image" | "video" | "audio", url: string, role?: string): Record<string, unknown> {
	const key = `${kind}_url`;
	return { type: key, [key]: { url }, role: role ?? `reference_${kind}` };
}

/** 文档示例用「图片1/视频1/音频1」指代 content 内同类型素材；把项目统一 @tag 图例转成该写法。 */
function officialReferenceLabels(text: string): string {
	return text
		.replace(/@Image(\d+)/g, "图片$1")
		.replace(/@Video(\d+)/g, "视频$1")
		.replace(/@Audio(\d+)/g, "音频$1");
}

function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const raw = data?.error?.message ?? data?.Error?.Message ?? (typeof data?.error === "string" ? data.error : undefined)
		?? data?.message ?? data?.msg ?? data?.detail;
	const msg = typeof raw === "string" ? raw.trim() : "";
	const code = data?.error?.code ?? data?.Error?.Code ?? data?.code ?? '';
	const feedback = upstreamCreditFeedback(`${code}: ${msg}`);
	if (feedback === UPSTREAM_CREDIT_SHORTAGE) return feedback;
	if (httpStatus === 401) return "官方上游密钥无效或缺失，请联系运营检查渠道密钥";
	if (httpStatus === 403) return msg ? `官方上游拒绝：${msg}` : "官方上游无权限或余额不足";
	if (httpStatus === 429) return "官方上游限流，请稍后重试";
	if (httpStatus >= 500) return msg ? `官方上游服务异常：${msg}` : "官方上游服务异常，请稍后重试";
	return msg || `${fallback} HTTP ${httpStatus}`;
}

type ResolvedInput = { ref: AssetRef; url: string; name?: string };
function resolvedInputs(refs?: AssetRef[], requireAll = false): ResolvedInput[] {
	const out: ResolvedInput[] = [];
	for (const ref of refs ?? []) {
		const url = toPublicUrl(ref) || (requireAll && typeof ref.officialAssetId === 'string' && ref.officialAssetId ? `asset://${ref.officialAssetId}` : '');
		if (url) out.push({ ref, url, name: ref.name });
		else if (requireAll || ref.usage === "identity") throw new Error("素材尚未上传完成或缺少可用公网地址");
	}
	return out;
}

/** Convert the final media list so storyboards/frames cannot bypass preparation.
 * Assemble and deduplicate original URLs first, then validate the client-prepared IDs. */
async function prepareMediaContent(
	content: Record<string, unknown>[], mediaRefs: Map<Record<string, unknown>, AssetRef>, model: ReturnType<typeof getModelDef>, up: Upstream,
	useLibrary: boolean,
): Promise<Record<string, unknown>[]> {
	return Promise.all(content.map(async (item) => {
		const key = item.type as string;
		const type = ({ image_url: 'Image', video_url: 'Video', audio_url: 'Audio' } as const)[key as 'image_url' | 'video_url' | 'audio_url'];
		if (!type) return item;
		const image = item[key] as { url: string };
		const ref = mediaRefs.get(item)!;
		if (!useLibrary && (type !== 'Image' || ref.usage !== "identity")) return item;
		if (!model) throw new Error("素材对应的模型配置不存在");
		const url = await officialIdentityUrl(ref, model, up, type);
		return { ...item, [key]: { ...image, url } };
	}));
}

/** 结果域与渠道 Base URL 同域时才附 Bearer，密钥绝不外发第三方 CDN。 */
function authHeadersFor(url: string, up: Upstream): Record<string, string> | undefined {
	try {
		const resultHost = new URL(url).hostname;
		const baseHost = new URL(up.baseUrl).hostname;
		if (resultHost === baseHost || resultHost.endsWith(`.${baseHost}`) || baseHost.endsWith(`.${resultHost}`)) {
			return { Authorization: `Bearer ${up.apiKey}` };
		}
	} catch {
		// 非法 URL 交给下载环节明确失败。
	}
	return undefined;
}

function booleanParam(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true" || value === "false") return value === "true";
	return undefined;
}

/** buildPrompt 的无内容兜底可能是 `{}` 或 `{"prompt":""}`；两者都不能冒充有效文本。 */
function normalizePrompt(value: string): string {
	const prompt = value.trim();
	if (!prompt.startsWith("{") || !prompt.endsWith("}")) return prompt;
	try {
		const parsed = JSON.parse(prompt);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
			&& Object.values(parsed).every((item) => item == null || String(item).trim() === "")) return "";
	} catch {
		// 用户真实输入的非 JSON 文本即使形似花括号也原样保留。
	}
	return prompt;
}

export async function submitOfficialVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream, _onStage?: (progress: number, stageText: string) => void): Promise<VideoSubmit> {
	if (!up.baseUrl) {
		return { ok: false, error: "官方渠道未配置上游地址（管理端「官方」渠道 Base URL 或环境 OFFICIAL_BASE_URL）" };
	}
	if (!up.apiKey) {
		return { ok: false, error: "官方渠道未配置上游密钥（管理端「官方」渠道或环境 OFFICIAL_API_KEY）" };
	}

	const seedance25 = isSeedance25(req.model, up.upstreamModel);
	const defaultDuration = seedance25 ? 30 : 15;
	const model = getModelDef(req.model);
	const useLibrary = !!model && materialPolicyForModel(model).kind === "official-assets";
	let imgs: ResolvedInput[], vids: ResolvedInput[], auds: ResolvedInput[];
	try {
		imgs = resolvedInputs(req.inputs?.images, useLibrary);
		vids = resolvedInputs(req.inputs?.videos, useLibrary);
		auds = resolvedInputs(req.inputs?.audios, useLibrary);
	}
	catch (err) { return { ok: false, error: (err as Error).message }; }
	// 兼容旧客户端/画布：officialAssetIndexes 是图片分组的 0 基索引；新客户端直接在 AssetRef.usage 标记。
	if (!imgs.some((item) => item.ref.usage === "identity") && Array.isArray(req.params?.officialAssetIndexes)) {
		const selected = new Set((req.params.officialAssetIndexes as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < imgs.length));
		imgs = imgs.map((item, index) => selected.has(index) ? { ...item, ref: { ...item.ref, usage: "identity" } } : item);
	}
	const isFrames = String(req.params?.method ?? "") === "frames";
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";
	let prompt = normalizePrompt(buildPrompt(req));

	let content: Record<string, unknown>[] = [];
	const mediaRefs = new Map<Record<string, unknown>, AssetRef>();
	const addMedia = (image: ResolvedInput, role?: string, kind: 'image' | 'video' | 'audio' = 'image') => {
		const item = contentItem(kind, image.url, role);
		content.push(item);
		mediaRefs.set(item, image.ref);
	};
	const sameImage = (a: ResolvedInput, b: ResolvedInput) => {
		if (a.ref.officialAssetId && b.ref.officialAssetId) return a.ref.officialAssetId === b.ref.officialAssetId;
		if (a.ref.id && b.ref.id) return a.ref.id === b.ref.id;
		return a.url === b.url;
	};
	const frameRef: ResolvedInput | undefined = firstFrameParam ? {
		url: firstFrameParam,
		ref: { url: firstFrameParam, officialAssetId: typeof req.params?.firstFrameAssetId === 'string' ? req.params.firstFrameAssetId : undefined },
	} : undefined;
	if (isFrames) {
		const pool: ResolvedInput[] = [];
		if (frameRef) pool.push(frameRef.ref.officialAssetId ? frameRef : imgs.find(image => sameImage(image, frameRef)) ?? frameRef);
		for (const item of imgs) if (!pool.some(image => sameImage(image, item))) pool.push(item);
		const materialError = checkMaterialLimits(model?.label ?? req.model, model?.matLimits, { images: pool, videos: vids, audios: auds });
		if (materialError) return { ok: false, error: materialError };
		if (prompt) {
			prompt = officialReferenceLabels(injectReferenceTags(prompt, { images: pool, videos: vids, audios: auds }));
			content.push({ type: "text", text: prompt });
		}
		// Preserve every supplied reference. The upstream decides whether this combination is supported.
		pool.forEach((item, index) => addMedia(item, index === 0 ? 'first_frame' : index === 1 ? 'last_frame' : 'reference_image'));
		for (const item of vids) addMedia(item, undefined, 'video');
		for (const item of auds) addMedia(item, undefined, 'audio');
	} else {
		const images = [...imgs];
		// 故事板整体参考图追加到末尾，保持已有素材编号稳定。
		if (frameRef && !images.some(image => sameImage(image, frameRef))) images.push(frameRef);
		const materialError = checkMaterialLimits(model?.label ?? req.model, model?.matLimits, { images, videos: vids, audios: auds });
		if (materialError) return { ok: false, error: materialError };
		if (!prompt && images.length === 0 && vids.length === 0 && auds.length === 0) {
			return { ok: false, error: "提示词和参考素材不能同时为空，请至少提供一项输入" };
		}
		if (prompt) {
			prompt = officialReferenceLabels(injectReferenceTags(prompt, { images, videos: vids, audios: auds }));
			content.push({ type: "text", text: prompt });
		}
		for (const item of images) addMedia(item);
		for (const item of vids) addMedia(item, undefined, 'video');
		for (const item of auds) addMedia(item, undefined, 'audio');
	}

	try {
		content = await prepareMediaContent(content, mediaRefs, model, up, useLibrary);
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
	const body: Record<string, unknown> = {
		model: up.upstreamModel,
		content,
		// 显式值原样透传；缺省用最长时长，与模型兜底价口径一致。
		duration: numberParam(req.params?.duration, defaultDuration),
		ratio: stringParam(req.params?.aspect_ratio, "adaptive"),
		resolution: stringParam(req.params?.resolution, "720p"),
	};
	const generateAudio = booleanParam(req.params?.generate_audio);
	if (generateAudio !== undefined) body.generate_audio = generateAudio;
	const watermark = booleanParam(req.params?.watermark);
	if (watermark !== undefined) body.watermark = watermark;
	if (req.params?.seed !== undefined && req.params?.seed !== "") body.seed = numberParam(req.params.seed, 0);

	const url = `${up.baseUrl}${OFFICIAL_PATH}`;
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
		return { ok: false, error: `官方渠道提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	const taskId = data?.id ?? data?.data?.id;
	if (!resp.ok || !taskId) return { ok: false, error: upstreamError(data, resp.status, "官方渠道视频提交") };
	return { ok: true, taskId: String(taskId) };
}

export async function pollOfficialVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}${OFFICIAL_PATH}/${encodeURIComponent(taskId)}`, {
			headers: { Authorization: `Bearer ${up.apiKey}` },
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		return { status: "running", progress: 50 };
	}
	const data: any = await resp.json().catch(() => ({}));
	if (resp.status >= 500 || resp.status === 429) return { status: "running", progress: 50 };
	if (!resp.ok) {
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: upstreamError(data, resp.status, "官方渠道视频轮询") };
	}

	const d: any = data?.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data : data;
	const state = String(d?.status ?? data?.status ?? "").trim().toLowerCase();
	if (FAILED_STATES.has(state)) {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		const raw = d?.error ?? data?.error ?? d?.message ?? data?.message;
		const message = typeof raw === "string" ? raw : raw?.message;
		return { status: "failed", error: message ? String(message) : "官方渠道视频生成失败" };
	}
	if (SUCCESS_STATES.has(state)) {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		const raw = d?.content?.video_url ?? data?.content?.video_url;
		let videoUrl = "";
		if (typeof raw === "string" && /^https?:\/\//i.test(raw)) videoUrl = raw;
		else if (typeof raw === "string" && raw.startsWith("/")) videoUrl = `${up.baseUrl}${raw}`;
		if (!videoUrl) return { status: "failed", error: "官方渠道任务成功但未返回成片链接" };
		return { status: "completed", videoUrl, resultHeaders: authHeadersFor(videoUrl, up) };
	}

	// running 以及未公布的未知状态均继续轮询；任务总超时由统一管线兜底。
	return { status: QUEUED_STATES.has(state) ? "queued" : "running", progress: QUEUED_STATES.has(state) ? 10 : 50 };
}
