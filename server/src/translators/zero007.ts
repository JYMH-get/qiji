/**
 * 「007」Seedance 视频渠道，依据用户提供的 SEEDANCE25_API(5).md（2026-09-07）。
 * Base URL 保留 /gateway： https://env-00jy6ktfybhu.dev-hz.cloudbasefunction.cn/gateway
 * 鉴权：Authorization: Bearer <ic_live_ API Key>。
 * 提交 POST /v1/videos -> { data:{ id } }；查询 GET /v1/jobs/{id}。
 * 仅 completed.result.url 是正式成片；reserved 排队，processing/storing 继续等，failed/refunded 失败。
 * 素材为 images/videos/audios URL 数组，文档没有特殊引用语法，保留 Qiji 的同序 @tag 图例。
 * 不支持首尾帧字段；omni 的 firstFrameUrl 追加图片末尾并附整体参考说明，不改变原素材编号。
 * 【模型清单情报源】GET https://env-00jy6ktfybhu.dev-hz.cloudbasefunction.cn/gateway/v1/models
 * 需 Bearer；2026-09-07 当前 Key 实拉 HTTP 200，视频包含 seedance-2.0 / seedance-2.5。
 * 目录同时列出图片/文本模型，其生成协议需另行接入；本翻译器只接受 capability=video。
 * 每次提交先查当前 Key 的实时目录（正版/特惠版能力不同）。时长必填，防止缺省值与计费兜底不一致；
 * resolution/ratio 缺省从目录取值，显式 duration/resolution/ratio 原样透传；素材硬约束明确拒绝。
 * 提示词保留非空校验并完整提交，长度限制交由上游处理，不依赖目录的 maxPromptChars。
 * 每次 submit 只生成一个随机幂等键，重试复用同一序列化 body；拿到 Job ID 后仅走 poll。
 */
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import { toPublicUrl, injectReferenceTags } from "./jianmeng.ts";
import type { VideoSubmit, VideoPoll } from "./jianmeng.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import { numberParam, stringParam } from "./paramPass.ts";
import type { OnUpstream } from "./openai.ts";
import type { AssetRef, GenerateRequest } from "../contract.ts";

type NamedInput = { url: string; name?: string };
type ModelParameters = {
	durations: number[];
	resolutions: string[];
	ratios: string[];
	maxImages: number;
	maxVideos: number;
	maxAudios: number;
	maxMaterials?: number;
	maxTotalMaterials?: number;
	maxTotal?: number;
	minVisualMaterials?: number;
};
const MAX_SUBMIT_ATTEMPTS = 3;
const RETRYABLE_SUBMIT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const transientPoll = (status: number): boolean => status === 408 || status === 429 || status >= 500;
const endpoint = (up: Upstream, path: string): string => `${up.baseUrl.replace(/\/+$/, "")}${path}`;
const auth = (up: Upstream): Record<string, string> => ({ Authorization: `Bearer ${up.apiKey}` });
const loggedAuth = (up: Upstream): Record<string, string> => ({ Authorization: `Bearer ${maskToken(up.apiKey)}` });

function upstreamError(data: any, status: number, fallback: string): string {
	const raw = data?.error?.message ?? (typeof data?.error === "string" ? data.error : undefined)
		?? data?.data?.error?.message ?? data?.data?.error ?? data?.message;
	const message = typeof raw === "string" && raw.trim() ? raw.trim() : `${fallback} HTTP ${status}`;
	return data?.requestId ? `${message}（requestId: ${String(data.requestId)}）` : message;
}

/** 地址只做本地语法/保留地址校验；上游仍负责下载时的 DNS 与可达性校验。 */
function publicHttps(raw: string): boolean {
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" || url.username || url.password) return false;
		const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
		if (host === "localhost" || /\.(?:localhost|local|internal|lan)$/.test(host)) return false;
		if (isIP(host) === 4) {
			const [a, b, c] = host.split(".").map(Number);
			return !(a === 0 || a === 10 || a === 127 || a >= 224
				|| (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
				|| (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
				|| (a === 192 && b === 0 && (c === 0 || c === 2))
				|| (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
				|| (a === 203 && b === 0 && c === 113));
		}
		if (isIP(host) === 6) {
			// 仅全局单播 2000::/3；排除文档及协议保留段，也排除映射 IPv4/回环/链路本地/ULA。
			const first = Number.parseInt(host.split(":")[0], 16);
			return first >= 0x2000 && first <= 0x3fff && !/^2001:(?:db8|0|[12][0-9a-f]?):/i.test(host);
		}
		return host.includes(".");
	} catch {
		return false;
	}
}

function resolveInputs(refs: AssetRef[] | undefined, label: string): NamedInput[] {
	const inputs = refs ?? [];
	const resolved = inputs.map((ref, index) => {
		const url = ref && toPublicUrl(ref);
		if (!url || !publicHttps(url)) {
			throw new Error(`007 第 ${index + 1} 个${label}素材缺少有效公网 HTTPS 地址（不允许本地、私网或含用户名密码的地址），请先上传素材后重试`);
		}
		return { url, name: ref.name };
	});
	if (resolved.length !== inputs.length) throw new Error(`007 ${label}素材解析数量不一致，请重新上传后重试`);
	return resolved;
}

function booleanParam(raw: unknown, fallback: boolean, name: string): boolean {
	if (raw === undefined || raw === null) return fallback;
	if (raw === true || raw === "true") return true;
	if (raw === false || raw === "false") return false;
	throw new Error(`007 参数 ${name} 必须是 true 或 false`);
}

function modelParameters(raw: any): ModelParameters {
	const nonnegative = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0;
	const strings = (value: unknown): boolean => Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.trim());
	if (!raw || !Array.isArray(raw.durations) || !raw.durations.length
		|| !raw.durations.every((v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0)
		|| !strings(raw.resolutions) || !strings(raw.ratios)
		|| !nonnegative(raw.maxImages) || !nonnegative(raw.maxVideos) || !nonnegative(raw.maxAudios)) {
		throw new Error("007 当前模型目录缺少有效参数或素材限制，请联系运营检查上游模型配置");
	}
	for (const key of ["maxMaterials", "maxTotalMaterials", "maxTotal"]) {
		if (raw[key] !== undefined && !nonnegative(raw[key])) throw new Error("007 当前模型目录的素材总数限制无效");
	}
	if (raw.minVisualMaterials !== undefined && !nonnegative(raw.minVisualMaterials)) {
		throw new Error("007 当前模型目录的图片或视频素材数量下限无效");
	}
	return raw as ModelParameters;
}

/** 先按当前 Key 目录校验，再以固定幂等键/请求体提交。 */
export async function submitZero007Video(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) return { ok: false, error: "007 未配置上游密钥（管理端「007」渠道或环境 ZERO007_API_KEY）" };
	if (!up.upstreamModel) return { ok: false, error: "007 未配置上游模型名" };
	const method = stringParam(req.params?.method, "omni");
	if (method !== "omni") return { ok: false, error: "007 仅支持全能参考方法，不支持首尾帧或其它方法" };
	const duration = req.params?.duration;
	if (duration === undefined || duration === null || String(duration).trim() === "") {
		return { ok: false, error: "007 视频时长不能为空，请选择视频时长后重试" };
	}
	let prompt = buildPrompt(req);
	if (!prompt.trim() || prompt.trim() === "{}") return { ok: false, error: "提示词不能为空：请填写视频描述后重试" };
	let images: NamedInput[], videos: NamedInput[], audios: NamedInput[];
	let generateAudio: boolean, watermark: boolean;
	try {
		images = resolveInputs(req.inputs?.images, "图片");
		videos = resolveInputs(req.inputs?.videos, "视频");
		audios = resolveInputs(req.inputs?.audios, "音频");
		generateAudio = booleanParam(req.params?.generate_audio, true, "generate_audio");
		watermark = booleanParam(req.params?.watermark, false, "watermark");
		prompt = injectReferenceTags(prompt, { images, videos, audios });
		const firstFrame = req.params?.firstFrameUrl;
		if (firstFrame !== undefined && firstFrame !== null && firstFrame !== "") {
			if (typeof firstFrame !== "string" || !publicHttps(firstFrame)) throw new Error("007 整体/首帧参考图必须是有效公网 HTTPS 地址");
			let index = images.findIndex((image) => image.url === firstFrame);
			if (index < 0) {
				images.push({ url: firstFrame });
				index = images.length - 1;
			}
			prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：第 ${index + 1} 张参考图（@Image${index + 1}）`;
		}
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}

	const modelsUrl = endpoint(up, "/v1/models");
	onUpstream?.({ request: { phase: "models", url: modelsUrl, method: "GET", headers: loggedAuth(up) } });
	let parameters: ModelParameters;
	try {
		const response = await fetch(modelsUrl, { headers: auth(up), signal: AbortSignal.timeout(30000) });
		const data: any = await response.json();
		onUpstream?.({ response: { phase: "models", httpStatus: response.status, body: data } });
		if (!response.ok) return { ok: false, error: upstreamError(data, response.status, "007 模型目录查询失败") };
		if (!Array.isArray(data?.data)) throw new Error("007 模型目录响应格式无效");
		const model = data.data.find((item: any) => item?.id === up.upstreamModel);
		if (!model) return { ok: false, error: `007 当前 API Key 未开放模型 ${up.upstreamModel}` };
		if (model.capability !== "video") throw new Error("007 当前模型目录未声明视频生成能力");
		parameters = modelParameters(model.parameters);
	} catch (error) {
		onUpstream?.({ response: { phase: "models", error: (error as Error).message } });
		return { ok: false, error: `007 模型目录查询失败：${(error as Error).message}` };
	}
	for (const [label, count, limit] of [
		["图片", images.length, parameters.maxImages], ["视频", videos.length, parameters.maxVideos], ["音频", audios.length, parameters.maxAudios],
	] as const) {
		if (count > limit) return { ok: false, error: `007 当前模型最多支持 ${limit} 个${label}素材（当前 ${count} 个），请减少素材后重试` };
	}
	const total = images.length + videos.length + audios.length;
	for (const limit of [parameters.maxMaterials, parameters.maxTotalMaterials, parameters.maxTotal]) {
		if (limit !== undefined && total > limit) return { ok: false, error: `007 当前模型素材总数最多 ${limit} 个（当前 ${total} 个）` };
	}
	const visualCount = images.length + videos.length;
	if (parameters.minVisualMaterials !== undefined && visualCount < parameters.minVisualMaterials) {
		return { ok: false, error: `007 当前模型至少需要 ${parameters.minVisualMaterials} 个图片或视频素材（当前 ${visualCount} 个），请添加图片或视频后重试` };
	}

	const body = {
		model: up.upstreamModel,
		prompt,
		duration: numberParam(duration, parameters.durations[0]),
		resolution: stringParam(req.params?.resolution, parameters.resolutions[0]),
		ratio: stringParam(req.params?.aspect_ratio ?? req.params?.ratio, parameters.ratios.includes("16:9") ? "16:9" : parameters.ratios[0]),
		images: images.map((image) => image.url),
		videos: videos.map((video) => video.url),
		audios: audios.map((audio) => audio.url),
		generate_audio: generateAudio,
		watermark,
	};
	// clientTaskId 不参与幂等键：统一入口并未保证跨新计费任务去重，不能把新扣费绑定到旧上游任务。
	const idempotencyKey = randomUUID();
	const serialized = JSON.stringify(body);
	const url = endpoint(up, "/v1/videos");
	const headers = { ...auth(up), "Content-Type": "application/json", "Idempotency-Key": idempotencyKey };
	let lastError = "007 提交失败";
	for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
		onUpstream?.({ request: { phase: "submit", attempt, url, method: "POST", headers: { ...headers, ...loggedAuth(up) }, body } });
		try {
			const response = await fetch(url, { method: "POST", headers, body: serialized, signal: submitSignal() });
			let data: any;
			try {
				data = await response.json();
			} catch (error) {
				onUpstream?.({ response: { phase: "submit", attempt, httpStatus: response.status, error: (error as Error).message } });
				if (!response.ok && !RETRYABLE_SUBMIT_STATUSES.has(response.status)) return { ok: false, error: `007 提交 HTTP ${response.status}（响应无法解析）` };
				throw error;
			}
			onUpstream?.({ response: { phase: "submit", attempt, httpStatus: response.status, body: data } });
			// 只接受契约里的 data.id；拿到 id 就保存并轮询，即使外层 HTTP 临时异常也不创建替代任务。
			if (typeof data?.data?.id === "string" && data.data.id.trim()) return { ok: true, taskId: data.data.id };
			if (response.ok) return { ok: false, error: "007 提交未返回 data.id" };
			lastError = upstreamError(data, response.status, "007 提交失败");
			if (!RETRYABLE_SUBMIT_STATUSES.has(response.status)) return { ok: false, error: lastError };
		} catch (error) {
			lastError = `007 提交连接异常：${(error as Error).message}`;
			onUpstream?.({ response: { phase: "submit", attempt, error: (error as Error).message } });
		}
		if (attempt < MAX_SUBMIT_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
	}
	return { ok: false, error: `${lastError}（已使用相同幂等键重试；未取得任务 ID，请运营核对上游任务记录）` };
}

/** reserved 排队；只有 completed.result.url 成功，storing 与未知状态继续查询。 */
export async function pollZero007Video(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	const url = endpoint(up, `/v1/jobs/${encodeURIComponent(taskId)}`);
	// attachUpstream 的 request 是覆盖写；poll 请求放④，保留③最后一次提交的完整 body/幂等键。
	const request = { url, method: "GET", headers: loggedAuth(up) };
	try {
		const response = await fetch(url, { headers: auth(up), signal: AbortSignal.timeout(30000) });
		const data: any = await response.json().catch(() => ({}));
		const job = data?.data;
		const status = typeof job?.status === "string" ? job.status : "";
		const phase = job?.stage === "storing" ? "storing" : status === "completed" ? "completed" : status === "failed" || status === "refunded" ? "failed" : "poll";
		onUpstream?.({ response: { phase, request, httpStatus: response.status, body: data } });
		if (transientPoll(response.status)) return { status: "running", progress: 50 };
		if (!response.ok) return { status: "failed", error: upstreamError(data, response.status, "007 任务查询失败") };
		if (status === "failed" || status === "refunded") return { status: "failed", error: upstreamError(data, response.status, "007 视频生成失败") };
		if (status === "completed") {
			const videoUrl = job?.result?.url;
			if (typeof videoUrl !== "string" || !publicHttps(videoUrl)) return { status: "failed", error: "007 任务完成但未返回有效的 result.url 成片链接" };
			let resultHeaders: Record<string, string> | undefined;
			if (new URL(videoUrl).origin === new URL(up.baseUrl).origin) resultHeaders = auth(up);
			return { status: "completed", videoUrl, resultHeaders };
		}
		if (job?.stage === "storing") return { status: "running", progress: 90, stageText: "视频已生成，上游正在转存成片" };
		return status === "reserved" ? { status: "queued", progress: 10 } : { status: "running", progress: 50 };
	} catch (error) {
		onUpstream?.({ response: { phase: "poll", request, error: (error as Error).message } });
		return { status: "running", progress: 50 };
	}
}
