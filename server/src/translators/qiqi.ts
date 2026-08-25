/**
 * QiQi（pidoi.com）视频渠道翻译器（第255轮接入，异步 submit+poll）。
 *
 * 同站同端点同鉴权，但**两套请求形态并存**（按上游模型名分派，见 shapeOf）：
 *   content 形态 —— 官方《Seedance 视频生成 API 调用文档》，模型 `seedace-2.0-720p`
 *   flat    形态 —— 官方《视频生成接口说明·933真人视频》(2026-07-26)，模型 `sora-v3-933-pro`
 * ⚠ 两份文档有三处**互相冲突**，绝不可混用：resolution（一个明示别传 / 一个必填）、
 *   素材字段族（content 数组 / 扁平 image_url+reference_*）、尾帧（支持 / 明确不支持）。
 *
 * 上游（两形态共用）：
 *   提交：POST /v1/videos            → { id:"task_xxx", (task_id), object:"video", status, progress }
 *   查询：GET  /v1/videos/{task_id}  → queued / in_progress|processing / completed(video_url) / failed
 *   下载：GET  /v1/videos/{task_id}/content（成片端点；任务未完成 409、不属本令牌 404）
 *   文档建议 3~5 秒轮询一次 → BUILTIN_POLL_INTERVALS 取 4s。
 * 鉴权：`Authorization: Bearer sk-`（渠道 ch-qiqi / 环境 QIQI_API_KEY）。
 * ⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/videos、/v1/videos/{id}、/v1/videos/{id}/content）。
 *
 * ── 素材引用编号（两形态相同，用户 2026-08-22 确认）─────────────────────────
 *   小写 `@image1..@image9` / `@audio1..@audio3` / `@video1..@video3`，三类**分别编号互不影响**——
 *   与 injectReferenceTags 注入的 @ImageN/@VideoN/@AudioN 逐位对应，经 qiqiLowerTags 统一转小写
 *   （简梦P h3 形态 / 苏打水小写 / Dimensio @image_file_N 同先例）。
 *   ⚠ flat 形态的 7.26 文档正文没写引用语法，但**底层同源、语法一致**（用户实锤）——
 *     故两形态都注入图例；flat 的编号顺序 = image_url(第1张) → reference_image_urls[…]，天然对齐。
 *
 * ── content 形态（seedace-2.0-720p）───────────────────────────────────────
 *   顶层：{ model, prompt(必填), content[], seconds?, ratio?, generate_audio?, seed? }
 *   content[]：{type:"text",text} + {type:"image_url"|"audio_url"|"video_url", <同名对象>:{url}, role}
 *     role：reference_image | first_frame | last_frame | reference_audio | reference_video
 *     ⚠ 文档**没有 name 字段**（编号由各类型素材在 content 中的出现顺序决定，text 不参与编号）——
 *       只发 type/role/<x>_url 三键，勿照抄出海营的 name（逐字照文档，第233轮规则）。
 *   ⚠ 顶层 prompt 与 content[0].text 同文（文档 §5.1 分工说明；§17.1 把「只传 content 不传顶层
 *     prompt」列为常见错误）。
 *   ⚠ **用音频或视频参考时必须至少 1 张图片**（文档 §5.4/§17.2：图片是人物/场景锚点，纯音频/
 *     纯视频参考请求会失败）——前置拒单，别让用户白等一次失败。
 *   ⚠ **resolution 一律不发**（与 congge 视频侧同规，第233轮）：分辨率编在模型名后缀里，
 *     文档 §2/§17.4 明示「推荐不要额外传 resolution，避免模型档位与参数冲突」。
 *
 * ── flat 形态（sora-v3-933-pro·933 真人视频）──────────────────────────────
 *   扁平字段：{ model, prompt, aspect_ratio(必填), resolution(必填 720p), seconds(必填,仅 "15"),
 *              image_url?(主参考图), reference_image_urls?[], reference_videos?[], audio_urls?[] }
 *   ⚠ 只发一套主字段（文档给了 reference_images / reference_video / audio_url 等别名，**一概不用**）。
 *   ⚠ **不支持尾帧图**（文档 §4.4/§8 明示）→ 显式 method=frames 前置拒单。
 *   ⚠ **单次请求文件总数（图+视+音）≤12**（文档 §4.4/§8）——除各类上限外另有此跨类总数闸。
 *   音频参考「**建议**同时提供至少一张参考图」是软措辞（区别于 content 形态的硬约束）→ 不拦，
 *     照发由上游裁决（§9：不代上游做判断）。
 *   参考视频/音频单条 2–15s、各自总时长 ≤15s：服务端不探测媒体时长，上游自校验。
 *
 * ── 参数（§9 第188/215轮定稿：原样透传，绝不夹钳/就近取档/白名单回退）───────────────
 *   duration → 上游 `seconds` **字符串**（两形态一致；客户端参数键仍是 duration、计费恒走
 *     costField=duration，与简梦P h3 形态同处理）。⚠ 缺省补 QIQI_DUR_MAX=15 而非 content 文档
 *     默认 "4"——与兜底价（cost = 每秒价 × 最长时长，「默认按最高」第134轮）严格对齐，避免
 *     「按最长扣费、上游按默认 4 秒出片」的少交货（flat 形态本就只有 15 一档）。
 *   ratio/aspect_ratio：显式原样透传，缺省 16:9（content 形态字段名 `ratio`、flat 形态 `aspect_ratio`）。
 *   generate_audio：仅 content 形态有此字段；客户端显式带可解析值才透传（第122轮规则）。
 *
 * 成片：completed 的 `video_url`（本站域直链或 /v1/videos/{id}/content 端点，文档「可能具有有效期」）
 *   → 轮询循环完成即转存 OSS；缺 video_url 时回退内容端点。
 *   结果域==渠道域才附 Bearer（密钥绝不外发第三方 CDN，第153轮规则）。
 *
 * 【模型清单情报源】GET https://pidoi.com/v1/models（需 Bearer sk-；New API 系网关，仅返回 id 无能力/价格
 *   元数据）；价格在 https://pidoi.com/api/pricing（**需登录态** access token/Cookie，即站内「模型广场」
 *   数据源，文档「具体价格以模型广场实时展示为准」）。
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

const QIQI_IMG_MAX = 9;
const QIQI_VID_MAX = 3;
const QIQI_AUD_MAX = 3;
/** flat 形态：单次请求文件总数（图+视+音）上限（文档 §4.4/§8） */
const QIQI_FILE_MAX = 12;
/** seconds 上限；缺省补它与兜底价「默认按最高」口径一致 */
const QIQI_DUR_MAX = 15;
const QIQI_PATH = "/v1/videos";

/** 请求形态：content=Seedance 官转文档 / flat=933 真人视频文档（7.26） */
type QiqiShape = "content" | "flat";
const SHAPES: Record<string, QiqiShape> = {
	"seedace-2.0-720p": "content", // ⚠ 上游名逐字（文档全篇少一个 n，不是 seedance）
	"sora-v3-933-pro": "flat",
};
/** 未知上游名（管理端自建）：sora/933 系按 flat（真人视频线），其余按站方 Seedance 官转主文档形态 */
function shapeOf(upstreamModel: string | undefined): QiqiShape {
	const name = upstreamModel ?? "";
	if (SHAPES[name]) return SHAPES[name];
	return /sora|933/i.test(name) ? "flat" : "content";
}

/** @ImageN/@VideoN/@AudioN → 文档 §5.3 的小写写法（三类分别编号，编号数字不动） */
function qiqiLowerTags(text: string): string {
	return text
		.replace(/@Image(\d+)/g, "@image$1")
		.replace(/@Video(\d+)/g, "@video$1")
		.replace(/@Audio(\d+)/g, "@audio$1");
}

/** 上游错误 → 人话（文档 §15 错误体 {error:{message,type,code}}；网关错误可能裸 message/detail） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const raw =
		data?.error?.message ??
		(typeof data?.error === "string" ? data.error : undefined) ??
		data?.message ??
		data?.msg ??
		data?.detail;
	const msg = typeof raw === "string" ? raw.trim() : "";
	if (httpStatus === 401) return "QiQi 上游密钥无效或缺失，请联系运营检查渠道密钥";
	if (httpStatus === 403) return msg ? `QiQi 上游拒绝：${msg}` : "QiQi 上游令牌无权限或余额策略限制";
	if (httpStatus === 429) return "QiQi 上游限流，请稍后重试";
	if (httpStatus >= 500) return msg ? `QiQi 上游服务异常：${msg}` : "QiQi 上游服务异常，请稍后重试";
	if (msg) return msg;
	return `${fallback} HTTP ${httpStatus}`;
}

const SUCCESS_STATES = new Set(["completed", "complete", "succeeded", "success", "done", "finished"]);
const FAILED_STATES = new Set(["failed", "fail", "error", "cancelled", "canceled", "timeout", "expired"]);
const QUEUED_STATES = new Set(["queued", "pending", "waiting"]);

/** content[] 素材项（文档写法：{type:"image_url", role, image_url:{url}}——⚠ 无 name 字段） */
function contentItem(kind: "image" | "video" | "audio", url: string, role?: string): Record<string, unknown> {
	const key = `${kind}_url`;
	return { type: key, role: role ?? `reference_${kind}`, [key]: { url } };
}

/** 结果域 == 渠道 baseUrl 域时才附鉴权头（密钥绝不外发第三方 CDN，第153轮规则） */
function authHeadersFor(url: string, up: Upstream): Record<string, string> | undefined {
	try {
		const uh = new URL(url).hostname, bh = new URL(up.baseUrl).hostname;
		if (uh === bh || uh.endsWith(`.${bh}`) || bh.endsWith(`.${uh}`)) return { Authorization: `Bearer ${up.apiKey}` };
	} catch { /* 非法 URL 由下载环节明确报错 */ }
	return undefined;
}

/** ① 提交视频任务 → 上游 task id */
export async function submitQiqiVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.baseUrl) {
		return { ok: false, error: "QiQi 未配置上游地址（管理端「QiQi（pidoi）」渠道 Base URL 或环境 QIQI_BASE_URL）" };
	}
	if (!up.apiKey) {
		return { ok: false, error: "QiQi 未配置上游密钥（管理端「QiQi（pidoi）」渠道或环境 QIQI_API_KEY）" };
	}

	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);

	if (vids.length > QIQI_VID_MAX) {
		return { ok: false, error: `QiQi 参考视频上限 ${QIQI_VID_MAX} 个（当前 ${vids.length} 个），请精简后重试` };
	}
	if (auds.length > QIQI_AUD_MAX) {
		return { ok: false, error: `QiQi 参考音频上限 ${QIQI_AUD_MAX} 个（当前 ${auds.length} 个），请精简后重试` };
	}

	// ⚠ 空提示词判定必须在注入图例**之前**——带素材时图例行追加在 "{}" 之后，注入后再判会被绕过（第249轮实锤）
	let prompt = buildPrompt(req);
	if (!prompt.trim() || prompt.trim() === "{}") {
		return { ok: false, error: "提示词不能为空（该渠道 prompt 为必填字段），请填写视频描述后重试" };
	}

	const shape = shapeOf(up.upstreamModel);
	const isFrames = String(req.params?.method ?? "") === "frames";
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";
	// ⚠ 参数原样透传（§9）；seconds 为字符串、缺省补 QIQI_DUR_MAX（与兜底价「默认按最高」口径一致）
	const seconds = String(numberParam(req.params?.duration, QIQI_DUR_MAX));
	const ratio = stringParam(req.params?.aspect_ratio, "16:9");

	const body: Record<string, unknown> = { model: up.upstreamModel };

	if (shape === "flat") {
		// ══ flat 形态（933 真人视频）：扁平字段 image_url + reference_* ══
		if (isFrames) {
			return { ok: false, error: "该模型不支持尾帧图（首尾帧方法不可用），请改用全能参考后重试" };
		}
		const images = imgs.map((x) => x.url);
		// 整体/首帧参考（带故事板）：追加 images **末尾**（不前插防 @imageN 编号错位）；图满 9 张放弃（软性附加项）
		if (firstFrameParam && !images.includes(firstFrameParam) && images.length < QIQI_IMG_MAX) {
			images.push(firstFrameParam);
			prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@Image${images.length}`;
		}
		if (images.length > QIQI_IMG_MAX) {
			return { ok: false, error: `QiQi 参考图上限 ${QIQI_IMG_MAX} 张（当前 ${images.length} 张），请精简图片素材后重试` };
		}
		// ⚠ 跨类总数闸（文档 §4.4/§8：单次请求文件总数最多 12 个）
		const files = images.length + vids.length + auds.length;
		if (files > QIQI_FILE_MAX) {
			return { ok: false, error: `该模型单次请求素材总数上限 ${QIQI_FILE_MAX} 个（当前 图${images.length}+视${vids.length}+音${auds.length}=${files} 个），请精简素材后重试` };
		}
		// 图例引用两形态一致（用户实锤）：@image1=image_url 主图，@image2..=reference_image_urls[…]
		prompt = qiqiLowerTags(injectReferenceTags(prompt, {
			images: images.map((url) => ({ url })), videos: vids, audios: auds,
		}));
		body.prompt = prompt;
		body.aspect_ratio = ratio; // 必填
		// ⚠ 必填且当前仅支持 720p（文档 §7/§8）；显式值原样透传（非法档由上游明确报错）
		body.resolution = stringParam(req.params?.resolution, "720p");
		body.seconds = seconds; // 必填（文档：可用值 15，建议字符串）
		// ⚠ 只发一套主字段（别名 reference_images / reference_video / audio_url 一概不用）
		if (images.length) {
			body.image_url = images[0];
			if (images.length > 1) body.reference_image_urls = images.slice(1);
		}
		if (vids.length) body.reference_videos = vids.map((x) => x.url);
		if (auds.length) body.audio_urls = auds.map((x) => x.url);
	} else {
		// ══ content 形态（Seedance 官转）：content[] 多模态数组 ══
		const content: Record<string, unknown>[] = [];
		if (isFrames) {
			// ── 首尾帧方法：content 里两张图分别标 role first_frame / last_frame（文档 §7.3）──
			if (vids.length || auds.length) {
				return { ok: false, error: "首尾帧方法只接受图片素材（首帧+尾帧），请移除视频/音频素材后重试" };
			}
			// 首帧=「带故事板」firstFrameUrl > 素材第 1 图；尾帧=下一张未用图（与出海营/苏打水/星辰同尺）
			const pool: string[] = [];
			if (firstFrameParam) pool.push(firstFrameParam);
			for (const x of imgs) if (!pool.includes(x.url)) pool.push(x.url);
			if (pool.length < 2) {
				return { ok: false, error: "首尾帧方法需要两张图（首帧+尾帧）：请携带 2 张图片素材，或「带故事板」+1 张图片素材" };
			}
			if (pool.length > 2) {
				return { ok: false, error: `首尾帧方法只需两张图（首帧+尾帧），当前共 ${pool.length} 张，请精简图片素材或改用全能参考` };
			}
			prompt = qiqiLowerTags(injectReferenceTags(prompt, { images: [{ url: pool[0] }, { url: pool[1] }] }));
			content.push({ type: "text", text: prompt });
			content.push(contentItem("image", pool[0], "first_frame"));
			content.push(contentItem("image", pool[1], "last_frame"));
		} else {
			// ── 全能参考（缺省方法）：content 数组混排 文本+素材 ──
			const images = imgs.map((x) => ({ url: x.url }));
			// 整体/首帧参考（带故事板）：追加 images **末尾**（不前插防 @imageN 编号错位）；图满 9 张放弃（软性附加项）
			if (firstFrameParam && !images.some((x) => x.url === firstFrameParam) && images.length < QIQI_IMG_MAX) {
				images.push({ url: firstFrameParam });
				prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@Image${images.length}`;
			}
			if (images.length > QIQI_IMG_MAX) {
				return { ok: false, error: `QiQi 参考图上限 ${QIQI_IMG_MAX} 张（当前 ${images.length} 张），请精简图片素材后重试` };
			}
			// ⚠ 文档 §5.4/§17.2：用音频或视频参考时必须至少 1 张图片（纯音频/纯视频参考请求会失败）→ 前置拒单
			if ((vids.length || auds.length) && images.length === 0) {
				return { ok: false, error: "该渠道使用参考视频/音频时必须同时提供至少 1 张参考图（图片是人物/场景锚点），请补充图片素材后重试" };
			}
			prompt = qiqiLowerTags(injectReferenceTags(prompt, { images, videos: vids, audios: auds }));
			content.push({ type: "text", text: prompt });
			for (const x of images) content.push(contentItem("image", x.url));
			for (const x of vids) content.push(contentItem("video", x.url));
			for (const x of auds) content.push(contentItem("audio", x.url));
		}
		body.prompt = prompt; // 顶层 prompt 与 content[0].text 同文（文档 §5.1 与 §17.1）
		body.seconds = seconds;
		body.ratio = ratio;
		body.content = content;
		// generate_audio：显式带可解析值才透传，否则不发=走上游默认 true（第122轮规则）
		if (typeof req.params?.generate_audio === "boolean") body.generate_audio = req.params.generate_audio;
		else if (req.params?.generate_audio === "true" || req.params?.generate_audio === "false") {
			body.generate_audio = req.params.generate_audio === "true";
		}
		// ⚠ resolution 刻意不发（分辨率编在模型名后缀里，文档 §2/§17.4 明示传了会与模型档位冲突）
	}

	const url = `${up.baseUrl}${QIQI_PATH}`;
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
		// ⚠ 文档 §16 明示：POST 超时且不知服务端是否已建任务时，直接重试可能产生重复任务 → 不自动重试，明确报错
		return { ok: false, error: `QiQi 提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });

	const taskId = data?.id ?? data?.task_id ?? data?.data?.id;
	if (!resp.ok || !taskId) {
		return { ok: false, error: upstreamError(data, resp.status, "QiQi 视频提交") };
	}
	return { ok: true, taskId: String(taskId) };
}

/** ② 轮询：GET /v1/videos/{task_id} → queued / in_progress|processing / completed(video_url) / failed(error) */
export async function pollQiqiVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}${QIQI_PATH}/${encodeURIComponent(taskId)}`, {
			headers: { Authorization: `Bearer ${up.apiKey}` },
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		return { status: "running", progress: 50 }; // 网络抖动：下一拍继续（文档 §16 建议 GET 可重试）
	}
	const data: any = await resp.json().catch(() => ({}));
	// 5xx/429 = 上游瞬时故障，不终态（任务有 2h 总超时兜底；文档 §16 明列可重试）
	if (resp.status >= 500 || resp.status === 429) {
		return { status: "running", progress: 50 };
	}
	if (!resp.ok) {
		// 401 密钥失效 / 404 任务不存在或不属当前令牌 → 终态失败（自动退款）
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: upstreamError(data, resp.status, "QiQi 视频轮询") };
	}

	// 信封（data 为对象）与扁平两种形态都吃
	const d: any = data?.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data : data;
	const st = String(d?.status ?? data?.status ?? "").trim().toLowerCase();

	if (FAILED_STATES.has(st)) {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		const raw = d?.error ?? data?.error;
		const msg = typeof raw === "string" ? raw.trim() : raw?.message;
		return { status: "failed", error: msg ? String(msg) : "QiQi 视频生成失败" };
	}

	if (SUCCESS_STATES.has(st)) {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		const raw = d?.video_url ?? data?.video_url;
		let url = "";
		if (typeof raw === "string" && /^https?:\/\//i.test(raw)) url = raw;
		else if (typeof raw === "string" && raw.startsWith("/")) url = `${up.baseUrl}${raw}`;
		// 缺 video_url 时回退标准内容端点（文档 §12/§6：任务完成后可直接从该端点下载 MP4）
		if (!url) url = `${up.baseUrl}${QIQI_PATH}/${encodeURIComponent(taskId)}/content`;
		return { status: "completed", videoUrl: url, resultHeaders: authHeadersFor(url, up) };
	}

	// queued=排队；in_progress/processing 及**未公布的未知状态词**=生成中继续轮询（未知一律不终态，第234轮规则）
	const p = Number(d?.progress ?? data?.progress);
	return {
		status: QUEUED_STATES.has(st) ? "queued" : "running",
		progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : QUEUED_STATES.has(st) ? 10 : 50,
	};
}
