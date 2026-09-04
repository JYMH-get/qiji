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
 *   2.0 系：图≤9、视频≤3、音频≤3、4~15 秒；纯音频不允许。
 *   2.5 系：图≤30、视频≤10、音频≤10、4~30 秒；允许纯音频。
 *   人像素材：2.0 先创建/复用分组再 CreateAsset（必传 GroupId）；2.5 不调分组接口。
 *
 * Base URL：https://kwjm.com（根域，不带 /v1）；部署后在 ch-official 填 Key（或 OFFICIAL_API_KEY）。
 * ⚠ 文档未给价格、轮询频率或成片实际托管域：
 *   - 模型先用占位价，上线前据官方价格或小额真单定真价；
 *   - 真单后据请求记录 ④ 段补成片 CDN 域白名单。
 * 【模型清单情报源】GET https://kwjm.com/v1/models（需 Bearer；2026-09-03 无鉴权探测返回 401，
 *   说明端点存在）；/api/pricing、/llms.txt、/ai-api/models、/generation/config 同日探测均为 404。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import { toPublicUrl, injectReferenceTags } from "./jianmeng.ts";
import type { VideoSubmit, VideoPoll } from "./jianmeng.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import { numberParam, stringParam } from "./paramPass.ts";
import type { OnUpstream } from "./openai.ts";
import type { AssetRef, GenerateRequest } from "../contract.ts";
import { createHash } from "node:crypto";
import { currentAssetOwner, getAsset } from "../store/assets.ts";
import {
	deleteOfficialAssetBinding,
	deleteOfficialAssetGroup,
	getOfficialAssetBinding,
	getOfficialAssetGroup,
	putOfficialAssetBinding,
	putOfficialAssetGroup,
	type OfficialAssetScope,
} from "../store/officialAssets.ts";

const OFFICIAL_PATH = "/v1/videos/generations";
const SUCCESS_STATES = new Set(["succeeded"]);
const FAILED_STATES = new Set(["failed", "expired"]);
const QUEUED_STATES = new Set(["queued"]);

function isSeedance25(modelId: string, upstreamModel: string): boolean {
	// 分组能力属于 Qiji 逻辑模型族，不能由管理端可修改的上游模型名决定。
	if (/^off-sd2\.5(?:-|$)/.test(modelId)) return true;
	if (/^off-sd2\.0(?:-|$)/.test(modelId)) return false;
	// 兼容管理端后续新增的 official-video 模型；未知模型按更严格的 2.0 分组路径处理。
	return /(?:^|[^0-9])2[.-]5(?:[^0-9]|$)/i.test(upstreamModel);
}

function caps(seedance25: boolean): { img: number; vid: number; aud: number; duration: number } {
	return seedance25
		? { img: 30, vid: 10, aud: 10, duration: 30 }
		: { img: 9, vid: 3, aud: 3, duration: 15 };
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
	if (httpStatus === 401) return "官方上游密钥无效或缺失，请联系运营检查渠道密钥";
	if (httpStatus === 403) return msg ? `官方上游拒绝：${msg}` : "官方上游无权限或余额不足";
	if (httpStatus === 429) return "官方上游限流，请稍后重试";
	if (httpStatus >= 500) return msg ? `官方上游服务异常：${msg}` : "官方上游服务异常，请稍后重试";
	return msg || `${fallback} HTTP ${httpStatus}`;
}

type ResolvedInput = { ref: AssetRef; url: string; name?: string };
type AssetApiResult = { response: Response; data: any };
const assetFlights = new Map<string, Promise<string>>();
const groupFlights = new Map<string, Promise<string>>();
const ASSET_POLL_MS = 3000;
const ASSET_DEADLINE_MS = 15 * 60 * 1000;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function resolvedInputs(refs?: AssetRef[]): ResolvedInput[] {
	const out: ResolvedInput[] = [];
	for (const ref of refs ?? []) {
		const url = toPublicUrl(ref);
		if (url) out.push({ ref, url, name: ref.name });
	}
	return out;
}

function assetErrorParts(data: any): { code: string; message: string } {
	const err = data?.Error ?? data?.error ?? data?.data?.Error ?? data?.data?.error;
	return {
		code: String(err?.Code ?? err?.code ?? data?.Code ?? data?.code ?? "").trim(),
		message: String(err?.Message ?? err?.message ?? data?.Message ?? data?.message ?? "").trim(),
	};
}

function assetFailureMessage(code: string, message: string): string {
	const known: Record<string, string> = {
		FaceMismatch: "真人脸一致性校验失败",
		TranscodingFailed: "素材转码或处理失败",
		ContentRestricted: "素材内容安全审核未通过",
		DownloadFailed: "官方上游无法下载该素材，请检查素材公网地址",
		TypeMismatch: "素材实际类型与声明类型不一致",
		FormatUnsupported: "素材格式不受支持",
		FormatUndetectable: "无法识别素材格式，文件可能已损坏",
		AudioTrackRequired: "该素材必须包含音轨",
		AudioTrackForbidden: "该素材不能包含音轨",
		DurationTooShort: "素材时长低于要求",
		DurationTooLong: "素材时长超过要求",
		FileSizeTooLarge: "素材文件过大",
		SubscriptionRequired: "当前官方渠道套餐未开通人像素材能力",
		InternalError: "官方素材处理服务异常，请稍后重试",
	};
	const prefix = known[code]
		?? (/SensitiveContentDetected|PolicyViolation/.test(code) ? "素材内容安全审核未通过" : "官方人像素材验证失败");
	return message ? `${prefix}：${message}` : prefix;
}

function isNotFound(response: Response, data: any): boolean {
	const { code } = assetErrorParts(data);
	return response.status === 404 || code === "NotFound.asset_id" || /NotFound/i.test(code);
}

function isGroupNotFound(response: Response, data: any): boolean {
	const { code, message } = assetErrorParts(data);
	const detail = `${code} ${message}`;
	return response.status === 404
		|| (/(?:group.?id|asset.?group)/i.test(detail) && /(?:not.?found|invalid|does not exist|不存在|无效)/i.test(detail));
}

async function assetApi(up: Upstream, path: string, body: Record<string, unknown>, onUpstream?: OnUpstream): Promise<AssetApiResult> {
	const url = `${up.baseUrl}${path}`;
	onUpstream?.({ request: { phase: "official-asset", url, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30000),
		});
	} catch (err) {
		throw new Error(`官方素材库请求失败：${(err as Error).message}`);
	}
	const data: any = await response.json().catch(() => ({}));
	onUpstream?.({ response: { phase: "official-asset", httpStatus: response.status, body: data } });
	return { response, data };
}

function scopeFor(up: Upstream): OfficialAssetScope {
	const userId = currentAssetOwner()?.userId;
	if (!userId) throw new Error("官方人像素材验证缺少用户归属，请重新提交任务");
	return {
		userId,
		channelId: "ch-official",
		credentialHash: sha256(up.apiKey),
		upstreamModel: up.upstreamModel,
	};
}

function scopeKey(scope: OfficialAssetScope): string {
	return `${scope.userId}|${scope.channelId}|${scope.credentialHash}|${scope.upstreamModel}`;
}

function sourceIdentity(input: ResolvedInput): { sourceKey: string; sourceUrlHash: string } {
	const sourceUrlHash = sha256(input.url);
	if (!input.ref.id) return { sourceKey: `url:${sourceUrlHash}`, sourceUrlHash };
	const rec = getAsset(input.ref.id);
	return {
		sourceKey: rec?.sha256 ? `id:${input.ref.id}:sha:${rec.sha256}` : `id:${input.ref.id}:url:${sourceUrlHash}`,
		sourceUrlHash,
	};
}

function assetView(data: any): any {
	return data?.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data : data;
}

async function createAssetGroup(scope: OfficialAssetScope, up: Upstream, onUpstream?: OnUpstream): Promise<string> {
	const r = await assetApi(up, "/v3/open/CreateAssetGroup", {
		model: up.upstreamModel,
		Name: `Qiji-${sha256(scopeKey(scope)).slice(0, 20)}`,
		GroupType: "AIGC",
	}, onUpstream);
	const groupId = r.data?.Id ?? r.data?.id ?? r.data?.data?.Id ?? r.data?.data?.id;
	if (!r.response.ok || !groupId) throw new Error(upstreamError(r.data, r.response.status, "官方素材分组创建"));
	putOfficialAssetGroup({ ...scope, groupId: String(groupId) });
	return String(groupId);
}

async function ensureAssetGroup(scope: OfficialAssetScope, up: Upstream, groupRequired: boolean, onUpstream?: OnUpstream): Promise<string | undefined> {
	if (!groupRequired) return undefined;
	const cached = getOfficialAssetGroup(scope);
	if (cached?.groupId) return cached.groupId;
	const key = scopeKey(scope);
	let promise = groupFlights.get(key);
	if (!promise) {
		promise = createAssetGroup(scope, up, onUpstream);
		groupFlights.set(key, promise);
	}
	try {
		return await promise;
	} finally {
		if (groupFlights.get(key) === promise) groupFlights.delete(key);
	}
}

async function waitUntilAssetActive(
	scope: OfficialAssetScope,
	identity: ReturnType<typeof sourceIdentity>,
	assetId: string,
	groupId: string | undefined,
	up: Upstream,
	onUpstream?: OnUpstream,
): Promise<string> {
	const deadline = Date.now() + ASSET_DEADLINE_MS;
	while (Date.now() < deadline) {
		const r = await assetApi(up, "/v3/open/GetAsset", { model: up.upstreamModel, Id: assetId }, onUpstream);
		if (isNotFound(r.response, r.data)) {
			deleteOfficialAssetBinding(scope, identity.sourceKey);
			throw Object.assign(new Error("官方素材记录已失效"), { code: "OFFICIAL_ASSET_NOT_FOUND" });
		}
		if (!r.response.ok) {
			if (r.response.status === 429 || r.response.status >= 500) {
				await new Promise((resolve) => setTimeout(resolve, ASSET_POLL_MS));
				continue;
			}
			throw new Error(upstreamError(r.data, r.response.status, "官方素材状态查询"));
		}
		const view = assetView(r.data);
		const status = String(view?.Status ?? view?.status ?? "").trim();
		const { code, message } = assetErrorParts(view);
		putOfficialAssetBinding({ ...scope, ...identity, assetType: "Image", groupId, assetId, status: status || "Processing", errorCode: code || undefined, errorMessage: message || undefined });
		if (status.toLowerCase() === "active") return assetId;
		if (status.toLowerCase() === "failed") throw new Error(assetFailureMessage(code, message));
		await new Promise((resolve) => setTimeout(resolve, ASSET_POLL_MS));
	}
	throw new Error("官方人像素材验证超时，请稍后重试");
}

async function createAndValidateAsset(scope: OfficialAssetScope, input: ResolvedInput, up: Upstream, groupRequired: boolean, onUpstream?: OnUpstream): Promise<string> {
	const identity = sourceIdentity(input);
	const cached = getOfficialAssetBinding(scope, identity.sourceKey);
	if (cached) {
		// 旧无分组版本可能已留下 2.0 绑定；此类资产不能继续复用，必须在明确分组内重建。
		if (groupRequired && !cached.groupId) {
			deleteOfficialAssetBinding(scope, identity.sourceKey);
		} else {
			// 兼容旧绑定：先把 2.0 绑定内已有的 GroupId 补进独立分组表，避免升级后重复建组。
			if (groupRequired && cached.groupId && !getOfficialAssetGroup(scope)) {
				putOfficialAssetGroup({ ...scope, groupId: cached.groupId });
			}
			try {
				return await waitUntilAssetActive(scope, identity, cached.assetId, cached.groupId, up, onUpstream);
			} catch (err) {
				if ((err as { code?: string }).code !== "OFFICIAL_ASSET_NOT_FOUND") throw err;
			}
		}
	}

	let groupId = await ensureAssetGroup(scope, up, groupRequired, onUpstream);
	const createBody = (): Record<string, unknown> => ({
		model: up.upstreamModel,
		...(groupId ? { GroupId: groupId } : {}),
		URL: input.url,
		Name: `Qiji-image-${sha256(identity.sourceKey).slice(0, 16)}`,
		AssetType: "Image",
	});
	let r = await assetApi(up, "/v3/open/CreateAsset", createBody(), onUpstream);
	if (!r.response.ok && groupId && isGroupNotFound(r.response, r.data)) {
		deleteOfficialAssetGroup(scope);
		groupId = await ensureAssetGroup(scope, up, groupRequired, onUpstream);
		r = await assetApi(up, "/v3/open/CreateAsset", createBody(), onUpstream);
	}
	const assetId = r.data?.Id ?? r.data?.id ?? r.data?.data?.Id ?? r.data?.data?.id;
	if (!r.response.ok || !assetId) throw new Error(upstreamError(r.data, r.response.status, "官方素材创建"));
	putOfficialAssetBinding({ ...scope, ...identity, assetType: "Image", groupId, assetId: String(assetId), status: "Processing" });
	return waitUntilAssetActive(scope, identity, String(assetId), groupId, up, onUpstream);
}

async function prepareIdentityImages(
	images: ResolvedInput[],
	up: Upstream,
	groupRequired: boolean,
	onUpstream?: OnUpstream,
	onStage?: (progress: number, stageText: string) => void,
): Promise<ResolvedInput[]> {
	const selected = images.filter((item) => item.ref.usage === "identity");
	if (!selected.length) return images;
	const scope = scopeFor(up);
	let done = 0;
	onStage?.(5, `正在准备人像素材 0/${selected.length}`);
	const converted = new Map<AssetRef, string>();
	await Promise.all(selected.map(async (item) => {
		const identity = sourceIdentity(item);
		const key = `${scopeKey(scope)}|${identity.sourceKey}`;
		let promise = assetFlights.get(key);
		if (!promise) {
			promise = createAndValidateAsset(scope, item, up, groupRequired, onUpstream);
			assetFlights.set(key, promise);
		}
		try {
			converted.set(item.ref, await promise);
		} finally {
			if (assetFlights.get(key) === promise) assetFlights.delete(key);
			done++;
			onStage?.(Math.min(30, 5 + Math.round(done / selected.length * 25)), `正在准备人像素材 ${done}/${selected.length}`);
		}
	}));
	return images.map((item) => {
		const assetId = converted.get(item.ref);
		return assetId ? { ...item, url: `asset://${assetId}` } : item;
	});
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

export async function submitOfficialVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream, onStage?: (progress: number, stageText: string) => void): Promise<VideoSubmit> {
	if (!up.baseUrl) {
		return { ok: false, error: "官方渠道未配置上游地址（管理端「官方」渠道 Base URL 或环境 OFFICIAL_BASE_URL）" };
	}
	if (!up.apiKey) {
		return { ok: false, error: "官方渠道未配置上游密钥（管理端「官方」渠道或环境 OFFICIAL_API_KEY）" };
	}

	const seedance25 = isSeedance25(req.model, up.upstreamModel);
	const limit = caps(seedance25);
	let imgs = resolvedInputs(req.inputs?.images);
	const vids = resolvedInputs(req.inputs?.videos);
	const auds = resolvedInputs(req.inputs?.audios);
	const invalidUsage = [...imgs, ...vids, ...auds].find(({ ref }) => ref.usage !== undefined && ref.usage !== "reference" && ref.usage !== "identity");
	if (invalidUsage) {
		return { ok: false, error: "素材用途参数无效，请选择普通参考或人像素材" };
	}
	if (vids.some((item) => item.ref.usage === "identity") || auds.some((item) => item.ref.usage === "identity")) {
		return { ok: false, error: "当前仅支持图片素材选择人像验证，请将视频或音频改为普通参考" };
	}
	// 兼容旧客户端/画布：officialAssetIndexes 是图片分组的 0 基索引；新客户端直接在 AssetRef.usage 标记。
	if (!imgs.some((item) => item.ref.usage === "identity") && Array.isArray(req.params?.officialAssetIndexes)) {
		const selected = new Set((req.params.officialAssetIndexes as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < imgs.length));
		imgs = imgs.map((item, index) => selected.has(index) ? { ...item, ref: { ...item.ref, usage: "identity" } } : item);
	}
	try {
		imgs = await prepareIdentityImages(imgs, up, !seedance25, onUpstream, onStage);
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
	const isFrames = String(req.params?.method ?? "") === "frames";
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";
	let prompt = normalizePrompt(buildPrompt(req));

	const content: Record<string, unknown>[] = [];
	if (isFrames) {
		if (vids.length || auds.length) {
			return { ok: false, error: "首尾帧方法只接受图片素材（首帧+尾帧），请移除视频/音频素材后重试" };
		}
		const pool: string[] = [];
		if (firstFrameParam) pool.push(firstFrameParam);
		for (const item of imgs) if (!pool.includes(item.url)) pool.push(item.url);
		if (pool.length < 2) {
			return { ok: false, error: "首尾帧方法需要两张图（首帧+尾帧），请补齐素材后重试" };
		}
		if (pool.length > 2) {
			return { ok: false, error: `首尾帧方法只接受两张图，当前 ${pool.length} 张，请精简后重试` };
		}
		if (prompt) {
			prompt = officialReferenceLabels(injectReferenceTags(prompt, { images: pool.map((url) => ({ url })) }));
			content.push({ type: "text", text: prompt });
		}
		content.push(contentItem("image", pool[0], "first_frame"));
		content.push(contentItem("image", pool[1], "last_frame"));
	} else {
		const images: { url: string; name?: string }[] = imgs.map((item) => ({ url: item.url, name: item.name }));
		// 故事板整体参考图追加到末尾，保持已有素材编号稳定。
		if (firstFrameParam && !images.some((item) => item.url === firstFrameParam)) images.push({ url: firstFrameParam });
		if (images.length > limit.img) {
			return { ok: false, error: `该模型参考图上限 ${limit.img} 张（当前 ${images.length} 张），请精简后重试` };
		}
		if (vids.length > limit.vid) {
			return { ok: false, error: `该模型参考视频上限 ${limit.vid} 个（当前 ${vids.length} 个），请精简后重试` };
		}
		if (auds.length > limit.aud) {
			return { ok: false, error: `该模型参考音频上限 ${limit.aud} 段（当前 ${auds.length} 段），请精简后重试` };
		}
		if (!seedance25 && auds.length > 0 && images.length === 0 && vids.length === 0) {
			return { ok: false, error: "Seedance 2.0 系列不可仅输入音频，请至少补充 1 张图片或 1 个视频" };
		}
		if (!prompt && images.length === 0 && vids.length === 0 && auds.length === 0) {
			return { ok: false, error: "提示词和参考素材不能同时为空，请至少提供一项输入" };
		}
		if (prompt) {
			prompt = officialReferenceLabels(injectReferenceTags(prompt, { images, videos: vids, audios: auds }));
			content.push({ type: "text", text: prompt });
		}
		for (const item of images) content.push(contentItem("image", item.url));
		for (const item of vids) content.push(contentItem("video", item.url));
		for (const item of auds) content.push(contentItem("audio", item.url));
	}

	const body: Record<string, unknown> = {
		model: up.upstreamModel,
		content,
		// 显式值原样透传；缺省用最长时长，与模型兜底价口径一致。
		duration: numberParam(req.params?.duration, limit.duration),
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
