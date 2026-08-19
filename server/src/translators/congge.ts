/**
 * congge（聪宸 congchen.top）渠道翻译器（第233轮接入）——同一站点、同一把 Key，两条协议：
 *   ① `congge-image` 图片：**同步单请求**（复用 createImageTask 图片管线，无轮询）
 *      文生图 `POST /v1/images/generations`（JSON）
 *      图生图 `POST /v1/images/edits`（JSON 传公网直链 / multipart 传字节）
 *      → `{ created, data:[{ url | b64_json }] }`
 *   ② `congge-video` 视频：**异步 submit+poll**（走统一 VideoDriver 轮询管线）
 *      提交 `POST /v1/videos` → `{ id, task_id, status:"queued" }`
 *      查询 `GET /v1/videos/{task_id}` → status queued|in_progress/processing|completed|failed
 *      下载 `GET /v1/videos/{task_id}/content`（须带同一 Bearer）
 *
 * 鉴权：Authorization: Bearer（渠道 ch-congge / 环境 CONGGE_API_KEY）；Base URL 填根域不带 /v1。
 *
 * ── 图片侧要点 ────────────────────────────────────────────────────────────
 * ⚠ **垫图必须走 /v1/images/edits，不能塞进 generations**（文档「七、图生图说明」明写）；
 *   垫图字段：单张=`image`、多张=`images`（也支持 reference_images，我方只发主字段，
 *   规避「主字段与别名内容不一致」类失败项——与简梦P 同规）。
 * ⚠ **垫图硬上限 4 张**（`image + images + reference_images` 合计；第 5 张上游报
 *   `at most 4 reference images are allowed for image edits`）→ 前置明确报错，
 *   **绝不静默丢**（丢一张即 @ImageN 图例整段错位，第118轮规则）。
 * 规格字段（文档「三、分辨率 / 质量参数」）：
 *   - `aspect_ratio`：10 档比例；⚠ 文档明令**不要传 size**（`resolution` 与 `size` 会冲突）→
 *     我方客户端出图请求发的是像素串 `size`（genParams.resolveSize），这里按「跨参数语义映射」
 *     换算成 比例 + 分辨率档 再发（§9 允许的图片侧 size→比例映射，与 jmh/aistars/jmz image 同规）。
 *   - `resolution`：gpt-image-2 仅 1K/2K（传 4K 上游明确报错）；Gemini 两款 1K/2K/4K。
 *   - `quality`：**仅 gpt-image-2**（Gemini 传了上游报 `quality is not supported for Gemini image models`）
 *     → 按上游名判定，gemini 系一律不发；我方 "auto"=不发该字段（走上游默认 medium）。
 *   - `n`：恒 1。
 *
 * ── 视频侧要点 ────────────────────────────────────────────────────────────
 * ⚠ **上游模型名带空格且大小写敏感**（`seedance2.0 Mini-480p`），文档明令原样传——
 *   分辨率编在模型名里 → 我方 4 个外显模型经 routes 按 resolution 重定向到 9 个上游真名
 *   （上游真名对用户隐藏，与 overseas/星辰同尺）。
 * ⚠ **不发 `size`/`resolution`**：分辨率已由模型名钉死，再发像素尺寸只会与模型名打架
 *   （图片侧文档已记 `resolution` 与 `size` 冲突，视频侧同源）→ 只发 `ratio` 定朝向。
 * 首尾帧：文档**没有**首/尾帧字段（只有 `input_reference` 单参考图）→ 不声明 methods（仅全能参考）。
 * 素材：`images`/`videos`/`audios` 三个数组（公网直链）；能力=2.0 系 图9/视3/音3、2.5 系 图30/视10/音10。
 * ⚠ 时长/比例一律**原样透传**（§9 第188/215轮定稿，paramPass），档位由管理端模型参数把关。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import { resolveNamed, injectReferenceTags } from "./jianmeng.ts";
import type { VideoSubmit, VideoPoll } from "./jianmeng.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import { numberParam, stringParam } from "./paramPass.ts";
import { resolveEditRefs, readImageResult, buildEditBlobs } from "./openai.ts";
import type { OnUpstream, ImageResult } from "./openai.ts";
import type { GenerateRequest } from "../contract.ts";

// ══════════════════════════ 公共 ══════════════════════════

/** 上游错误 → 人话（错误体形态：OpenAI 风格 {error:{message}} / 裸 message / 字符串） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const msg =
		(typeof data?.error === "string" ? data.error : data?.error?.message) ||
		data?.message ||
		"";
	if (httpStatus === 401 || httpStatus === 403) {
		return `congge 上游密钥无效或无权限${msg ? `：${msg}` : ""}，请联系运营检查渠道密钥`;
	}
	if (httpStatus === 402) return "congge 上游额度不足，请联系运营充值后重试";
	if (httpStatus === 429) return "congge 上游请求过频或负载饱和，请稍后重试";
	if (msg) return String(msg);
	return `${fallback} HTTP ${httpStatus}`;
}

/** 结果链接在本站域才附 Bearer（防密钥外泄给第三方 CDN，第153轮规则） */
function authHeadersFor(url: string, up: Upstream): Record<string, string> | undefined {
	if (!/^https?:\/\//i.test(url)) return undefined;
	try {
		const uh = new URL(url).hostname, bh = new URL(up.baseUrl).hostname;
		if (uh === bh || uh.endsWith(`.${bh}`) || bh.endsWith(`.${uh}`)) {
			return { Authorization: `Bearer ${up.apiKey}` };
		}
	} catch { /* 域解析失败=不附头 */ }
	return undefined;
}

// ══════════════════════════ 图片 ══════════════════════════

/** 文档「二、支持比例」10 档（顺序无关，就近映射用） */
const IMG_RATIOS = ["1:1", "5:4", "4:5", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"];
/** 文档「三、分辨率/质量参数」：gpt 仅 low/medium/high（我方 "auto"=不发，走上游默认 medium） */
const GPT_QUALITIES = new Set(["low", "medium", "high"]);
/** 文档「七、图生图说明」硬限：image + images + reference_images 合计 ≤ 4 */
const MAX_REFS = 4;

/** "WxH" / "W:H" → 宽高比数值；解析不出 null */
function aspectValOf(s: string): number | null {
	const m = s.match(/^(\d+)\s*[x:×]\s*(\d+)$/i);
	if (!m) return null;
	const w = Number(m[1]), h = Number(m[2]);
	return w > 0 && h > 0 ? w / h : null;
}

/** 像素尺寸/比例串 → 支持列表里最接近的比例（已在列表内直接用；解析不出返回 null=不发该字段） */
function nearestRatio(sizeRaw: string): string | null {
	if (!sizeRaw) return null;
	const compact = sizeRaw.replace(/\s+/g, "");
	if (IMG_RATIOS.includes(compact)) return compact;
	const a = aspectValOf(sizeRaw);
	if (a == null) return null;
	return IMG_RATIOS.reduce((best, r) =>
		Math.abs(aspectValOf(r)! - a) < Math.abs(aspectValOf(best)! - a) ? r : best, IMG_RATIOS[0]);
}

/**
 * 分辨率档：显式 `params.resolution` 优先（1k/2k/4k → 1K/2K/4K，其余原样透传由上游报错）；
 * 缺省时从像素串 `size` 的**长边**反推——客户端出图只发 size（genParams.resolveSize：
 * 1k≈1024 / 2k≈2048 / 4k≈3840-4096 长边），不反推的话用户选的分辨率档到不了上游。
 */
function resolutionOf(params: Record<string, unknown> | undefined): string | null {
	const explicit = String(params?.resolution ?? "").trim();
	if (explicit) {
		const up = explicit.toUpperCase();
		return ["1K", "2K", "4K"].includes(up) ? up : explicit; // 档外原样发出（上游明确报错，不静默改写）
	}
	const size = String(params?.size ?? "").trim();
	const m = size.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
	if (!m) return null; // 无从判断=不发，走上游默认 2K
	const long = Math.max(Number(m[1]), Number(m[2]));
	if (long <= 1280) return "1K";
	if (long <= 2560) return "2K";
	return "4K";
}

/** 请求体日志折叠（multipart 场景把文件字段折成体积说明） */
function maskFields(fields: Record<string, unknown>, fileNote?: string): Record<string, unknown> {
	return fileNote ? { ...fields, _files: fileNote } : fields;
}

/**
 * 图片生成（同步单请求）：无垫图 → /v1/images/generations（JSON）；
 * 有垫图 → /v1/images/edits（全部公网直链走 JSON；全部服务端字节走 multipart 文件上传）。
 */
export async function translateConggeImage(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<ImageResult> {
	if (!up.apiKey) {
		return { ok: false, error: "congge 未配置上游密钥（管理端「congge（聪宸）」渠道或环境 CONGGE_API_KEY）" };
	}
	const model = up.upstreamModel;
	// Gemini 两款不接受 quality（文档「十二、常见错误」②：上游明确报错）
	const isGpt = /gpt-image/i.test(model);

	// 图片接口不吃视频/音频素材——明确报错，绝不静默丢
	const vids = req.inputs?.videos?.length ?? 0;
	const auds = req.inputs?.audios?.length ?? 0;
	if (vids || auds) {
		return { ok: false, error: `图片模型不支持参考视频/音频（本次携带 ${vids} 个视频、${auds} 个音频），请移除后重试` };
	}

	const refCount = req.inputs?.images?.length ?? 0;
	if (refCount > MAX_REFS) {
		return { ok: false, error: `该渠道图生图垫图上限 ${MAX_REFS} 张（当前 ${refCount} 张），请精简图片素材后重试` };
	}

	// prompt 注入 @ImageN 图例（该家无 @ 引用语法，图例作普通说明文字——与多数渠道同款）
	let prompt = buildPrompt(req);
	const named = resolveNamed(req.inputs?.images);
	if (named.length) prompt = injectReferenceTags(prompt, { images: named });

	// 规格字段（文档「十一、最稳传参方式」：model + prompt + aspect_ratio + resolution + quality + n；勿传 size）
	const fields: Record<string, unknown> = { model, prompt, n: 1 };
	const ratio = nearestRatio(String(req.params?.aspect_ratio ?? req.params?.size ?? "").trim());
	if (ratio) fields.aspect_ratio = ratio;
	const resolution = resolutionOf(req.params as Record<string, unknown> | undefined);
	if (resolution) fields.resolution = resolution;
	if (isGpt) {
		const q = String(req.params?.quality ?? "").trim().toLowerCase();
		if (GPT_QUALITIES.has(q)) fields.quality = q; // "auto"/空=不发，走上游默认 medium
	}

	const genUrl = `${up.baseUrl}/v1/images/generations`;
	const editUrl = `${up.baseUrl}/v1/images/edits`;
	const maskedAuth = { Authorization: `Bearer ${maskToken(up.apiKey)}` };

	let url = genUrl;
	let init: RequestInit;
	let logBody: Record<string, unknown> = fields;

	if (refCount > 0) {
		// 死链探活 → 按资产 id 回查台账当前直链自愈 → 明确报错（⚠ 一张都不许静默丢，第118轮规则）
		const { refs, missing } = await resolveEditRefs(req);
		if (missing.length) {
			return { ok: false, error: `垫图无法获取：${missing.join("、")}——直链已失效且台账无可用直链，请重新生成/上传该资产后再试` };
		}
		if (!refs.length) {
			return { ok: false, error: "垫图无法获取：参考图需为公网可达直链、或服务端持有其资产字节（请配置 OSS，或确认资产 id 有效）" };
		}
		const urls = refs.filter((r) => r.url).map((r) => r.url!);
		url = editUrl;

		if (urls.length === refs.length) {
			// 全部公网直链 → JSON（文档「八、方式3」）：单张用 image、多张用 images
			const body = { ...fields, ...(urls.length === 1 ? { image: urls[0] } : { images: urls }) };
			logBody = body;
			init = {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
				body: JSON.stringify(body),
				signal: submitSignal(),
			};
		} else {
			// 有垫图只剩服务端字节（未配 OSS / 直链已死但台账有字节）→ multipart 文件上传
			// （文档「八、方式1/2」最推荐形态）。⚠ JSON 与 multipart 无法混合表达 → 统一取字节：
			// buildEditBlobs 会把公网直链那几张也下载成字节，**任一张取不到即返回 null**（不静默缺张）。
			const blobs = await buildEditBlobs(refs);
			if (!blobs) {
				return { ok: false, error: "垫图无法取得字节（部分参考图既无可用公网直链、服务端也拉不到），请重新上传该素材后重试" };
			}
			const fd = new FormData();
			for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
			const field = blobs.length === 1 ? "image" : "images";
			for (const b of blobs) fd.append(field, b.blob, b.filename);
			logBody = maskFields(fields, `${blobs.length} 个文件经 multipart 字段 ${field} 上传（合计 ${Math.round(blobs.reduce((s, b) => s + b.blob.size, 0) / 1024)}KB）`);
			init = {
				method: "POST",
				headers: { Authorization: `Bearer ${up.apiKey}` }, // 不设 Content-Type：由 fetch 补 boundary
				body: fd,
				signal: submitSignal(),
			};
		}
	} else {
		init = {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(fields),
			signal: submitSignal(),
		};
	}

	onUpstream?.({ request: { url, method: "POST", headers: maskedAuth, body: logBody } });

	let resp: Response;
	try {
		// 同步阻塞出图——第169轮取消提交短超时（详见 submitTimeout.ts）
		resp = await fetch(url, init);
	} catch (e) {
		return { ok: false, error: `congge 图片提交失败：${(e as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	// b64_json 只记体积（防把几 MB base64 写进请求记录）
	const b64 = data?.data?.[0]?.b64_json;
	onUpstream?.({
		response: {
			httpStatus: resp.status,
			body: typeof b64 === "string" && b64 ? { ...data, data: [{ b64_json: `base64（${Math.round(b64.length / 1024)}KB）` }] } : data,
		},
	});
	if (!resp.ok || data?.error) {
		return { ok: false, error: upstreamError(data, resp.status, "congge 图片生成") };
	}
	// data[0].url → 下载字节（服务端拉不动时带 fallbackUrl 交客户端接力，第158轮止血语义）；或 b64_json 兜底
	return readImageResult(data);
}

// ══════════════════════════ 视频 ══════════════════════════

/** 单模型能力（按文档「二、公开模型」参考能力列）；未知上游名（管理端自建）不守卫直发 */
interface CgCaps {
	imgMax: number;
	vidMax: number;
	audMax: number;
	/** 时长上限（文档：2.0 系 4-15；2.5 系最长 30） */
	durMax: number;
}
const CAPS_20: CgCaps = { imgMax: 9, vidMax: 3, audMax: 3, durMax: 15 };
const CAPS_25: CgCaps = { imgMax: 30, vidMax: 10, audMax: 10, durMax: 30 };

/**
 * 上游名 → 能力表。⚠ 按**前缀**判定而非全名枚举：上游名形如
 * `seedance2.0 Mini-480p` / `seedance2.5 720p`（带空格、大小写敏感），
 * 站方将来加分辨率后缀（管理端建模型即接）也自动落到正确档，无需改代码。
 */
function capsOf(upstreamModel: string): CgCaps | undefined {
	const s = upstreamModel.trim().toLowerCase();
	if (s.startsWith("seedance2.5")) return CAPS_25;
	if (s.startsWith("seedance2.0")) return CAPS_20;
	return undefined;
}

/** ① 提交视频生成任务 → 返回上游 task_id */
export async function submitConggeVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "congge 未配置上游密钥（管理端「congge（聪宸）」渠道或环境 CONGGE_API_KEY）" };
	}

	// 素材解析（id→OSS 直链优先，拒收 .localhost 伪域）
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);
	const caps = capsOf(up.upstreamModel);

	// 素材守卫：超限一律明确报错，绝不静默丢（丢一条即 @ImageN 图例整段错位）
	if (caps) {
		if (imgs.length > caps.imgMax) {
			return { ok: false, error: `该模型参考图上限 ${caps.imgMax} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
		}
		if (vids.length > caps.vidMax) {
			return { ok: false, error: `该模型参考视频上限 ${caps.vidMax} 个（当前 ${vids.length} 个），请精简后重试` };
		}
		if (auds.length > caps.audMax) {
			return { ok: false, error: `该模型参考音频上限 ${caps.audMax} 个（当前 ${auds.length} 个），请精简后重试` };
		}
	}

	// prompt 注入 @tag 图例（编号=各模态数组序；该家无引用语法，图例作普通说明文字）
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });

	// 整体/首帧参考（带故事板→params.firstFrameUrl）：追加 images **末尾**+提示词说明行
	// （不前插防素材图例错位；图已满上限则放弃追加——软性附加项，与简梦P/算力同规）
	const images = imgs.map((x) => x.url);
	const imgRoom = caps?.imgMax ?? 9;
	const firstFrame = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";
	if (firstFrame && !images.includes(firstFrame) && images.length < imgRoom) {
		images.push(firstFrame);
		prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@Image${images.length}`;
	}

	// prompt 必填（文档「三、请求参数」）；⚠ buildPrompt 在无输入时的变量兜底形态是字面 "{}"，同样视为空
	if (!prompt.trim() || prompt.trim() === "{}") {
		return { ok: false, error: "提示词不能为空（该渠道 prompt 为必填项），请填写视频提示词后重试" };
	}

	// ⚠ 时长/比例原样透传，绝不静默改写（§9 第188/215轮定稿）；缺省才补默认（时长=该档上限、比例=16:9）。
	// ⚠ 不发 size/resolution：分辨率已编码在上游模型名里（routes 按 resolution 重定向），再发会打架。
	const body: Record<string, unknown> = {
		model: up.upstreamModel,
		prompt,
		seconds: numberParam(req.params?.duration, caps?.durMax ?? 15),
		ratio: stringParam(req.params?.aspect_ratio, "16:9"),
	};
	if (images.length) body.images = images;
	if (vids.length) body.videos = vids.map((x) => x.url);
	if (auds.length) body.audios = auds.map((x) => x.url);
	// watermark：仅客户端显式带值（=管理端声明了该参数）时透传，否则不发走上游默认（第122轮规则）
	if (typeof req.params?.watermark === "boolean") body.watermark = req.params.watermark;
	else if (req.params?.watermark === "true" || req.params?.watermark === "false") {
		body.watermark = req.params.watermark === "true";
	}

	const url = `${up.baseUrl}/v1/videos`;
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
		// ⚠ 文档未承诺提交幂等：超时/网络错误不自动重试（可能已建任务重复计费），明确报错交用户确认
		return { ok: false, error: `congge 视频提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	// 文档回执同时给了 id 与 task_id（示例两者同值）→ 防御式两个都认
	const taskId = data?.task_id || data?.id;
	if (!resp.ok || !taskId) {
		return { ok: false, error: upstreamError(data, resp.status, "congge 视频提交") };
	}
	return { ok: true, taskId: String(taskId) };
}

/** 成功/失败状态族（文档「五、查询任务」给了四态；防御式收录常见同义词，未知词=生成中继续轮询） */
const OK_STATES = new Set(["completed", "complete", "success", "succeeded", "finished"]);
const FAIL_STATES = new Set(["failed", "failure", "error", "cancelled", "canceled"]);
const QUEUE_STATES = new Set(["queued", "pending", "queueing", "waiting"]);

/**
 * 从查询回执里取成片地址。⚠ 文档明说「通常包含视频地址字段（如 video_url / url / metadata 内链接，
 * **以实际返回为准**）」→ 逐层防御式提取；一个都取不到时回退**文档保证存在**的下载端点
 * `/v1/videos/{id}/content`（须带同一 Bearer，authHeadersFor 只对本站域附头）。
 */
function pickVideoUrl(data: any): string {
	const cands: unknown[] = [
		data?.video_url, data?.videoUrl, data?.url, data?.output_url,
		data?.result?.video_url, data?.result?.url,
		data?.data?.video_url, data?.data?.url,
		data?.output?.video_url, data?.output?.url,
		data?.metadata?.video_url, data?.metadata?.url,
		Array.isArray(data?.videos) ? (data.videos[0]?.url ?? data.videos[0]) : undefined,
		Array.isArray(data?.data) ? (data.data[0]?.video_url ?? data.data[0]?.url) : undefined,
	];
	for (const c of cands) {
		if (typeof c === "string" && /^https?:\/\//i.test(c)) return c;
	}
	return "";
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④）。状态：queued|in_progress/processing|completed|failed */
export async function pollConggeVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
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
		// 400 任务号不合法 / 401 密钥失效 / 404 任务不存在 → 终态失败
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: upstreamError(data, resp.status, "congge 视频轮询") };
	}
	// 信封（data 为对象）与扁平两种形态都吃
	const d: any = data?.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data : data;
	const st = String(d?.status ?? data?.status ?? "").toLowerCase();

	if (FAIL_STATES.has(st)) {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		const msg =
			d?.fail_reason ||
			(typeof d?.error === "string" ? d.error : d?.error?.message) ||
			data?.message;
		return { status: "failed", error: msg ? String(msg) : "congge 视频生成失败" };
	}

	if (OK_STATES.has(st)) {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		let url = pickVideoUrl(d) || pickVideoUrl(data);
		// 相对地址（/outputs/xx.mp4 之类）拼本站域；全无地址=回退文档保证的下载端点
		const raw = d?.video_url ?? data?.video_url;
		if (!url && typeof raw === "string" && raw.startsWith("/")) url = `${up.baseUrl}${raw}`;
		if (!url) url = `${up.baseUrl}/v1/videos/${encodeURIComponent(taskId)}/content`;
		return { status: "completed", videoUrl: url, resultHeaders: authHeadersFor(url, up) };
	}

	// queued=排队；in_progress/processing 及未知状态=生成中继续轮询（容忍上游扩状态）
	const p = Number(d?.progress ?? data?.progress);
	return {
		status: QUEUE_STATES.has(st) ? "queued" : "running",
		progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50,
	};
}
