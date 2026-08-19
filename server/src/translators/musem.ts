/**
 * 简梦M（MuseAI，museai.vip）视频渠道翻译器（第151轮接入，异步 submit+poll）。
 *
 * 上游架构（按官方 OpenAPI 文档「生成视频 统一格式」+「查询任务状态」，2026-07 版）：
 *   POST /api/v2/videos   body { model, prompt, ratio, duration(4-15 整数), resolution?,
 *                                images:[{tag,url}], audios?:[{tag,url}], videos?:[{tag,url}] }
 *     → { code, msg, data }（data=任务号，**数字**，如 414681835503680——转字符串保存）
 *     ⚠ images 是 schema 必填字段——恒发（无素材=空数组）；audios/videos 非空才发。
 *   GET  /api/v1/tasks/{taskId} → { code, msg, data:{ status, url?, failReason?, createTime, updateTime } }
 *     状态机：RUNNING=生成中 / COMPLETED=已完成（取 data.url，实测例托管 capcut CDN，
 *     与 Dimensio 同域时效签名直链 → 通用轮询循环 rehostVideo 转存永久 OSS）/ FAILED=失败（failReason）。
 *     ⚠ 文档 schema 把状态枚举误标在 data.id 上、examples 里状态在 data.status——以 examples 为准，
 *     防御式两个字段都探（`pickState`），未知状态=生成中继续轮询（容忍上游扩状态）。
 *
 * 鉴权：**`apikey: MUSE-...` 请求头**（⚠ 不是 Authorization Bearer——该家独有，勿照抄其它翻译器）。
 *
 * 素材引用：该家有**真 @tag 引用语法**——images/audios/videos 逐条带 {tag,url}，prompt 用 @tag 引用。
 *   我们服务端 injectReferenceTags 注入的正是 @Image1/@Video1/@Audio1（各模态 1-based 序号）→
 *   tag 直接映射为 "Image1"/"Video1"/"Audio1"，与 prompt 里的 @ 引用一一对应（比画影/Aivide 的
 *   「图例当普通文字」更精准，与简梦 JA extra_images 语义同源）。
 * 素材上限（文档可用模型表）：K 线（PRO_K/FAST_K）图4 音3 **视0**；HU 线（*_HU_0710）图9 音3 视3；
 *   静态表 CAPS 守卫**绝不静默丢**（超限/不支持一律明确报错，防 @tag 编号错位）；管理端自建的
 *   未知上游模型名不守卫直发（上游兜底）。模型种子另带 matLimits（routes.ts 硬闸+客户端预检双保险）。
 * 首尾帧：文档无此字段 → 模型不声明 methods（全能参考单方法）；「带故事板」（params.firstFrameUrl）
 *   追加进 images **末尾**（tag=顺延的 ImageN）+提示词说明行（不前插防素材图例错位；已满上限放弃——软性附加项）。
 * 分辨率：可用模型全线 720p（模型参数单档展示）；值在文档枚举（480p/720p/1080p）内才随请求下发。
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

/** 素材上限静态表（键=上游模型名；2026-07 文档「可用模型列表」，上游调整时同步维护） */
const CAPS: Record<string, { img: number; vid: number; aud: number }> = {
	MUSE_SD2_PRO_K: { img: 4, vid: 0, aud: 3 },
	MUSE_SD2_FAST_K: { img: 4, vid: 0, aud: 3 },
	MUSE_SD2_PRO_HU_0710: { img: 9, vid: 3, aud: 3 },
	MUSE_SD2_FAST_HU_0710: { img: 9, vid: 3, aud: 3 },
};
const IMG_FALLBACK_MAX = 9; // 未知模型的「带故事板」追加兜底上限

/** 上游错误 → 人话（响应统一 { code, msg, data } 信封；错误码表未公布，按 HTTP 状态映射 + msg 透传） */
function upstreamError(body: any, httpStatus: number, fallback: string): string {
	const msg = body?.msg || body?.message || "";
	if (httpStatus === 401 || httpStatus === 403) return `简梦M 上游密钥无效或无权限${msg ? `：${msg}` : ""}，请联系运营检查渠道密钥`;
	if (httpStatus === 402) return "简梦M 上游额度不足，请联系运营充值后重试";
	if (httpStatus === 429) return "简梦M 上游请求过频或负载饱和，请稍后重试";
	if (msg) return String(msg);
	return `${fallback} HTTP ${httpStatus}`;
}

/** 信封 code 归一：成功=200/0（文档 mock 200；缺省视为成功，以 data 有无为准） */
function envelopeOk(body: any): boolean {
	if (body?.code == null) return true;
	const n = Number(body.code);
	return n === 200 || n === 0;
}

/** ① 提交视频生成任务 → 返回上游任务号（数字→字符串） */
export async function submitMusemVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "简梦M 未配置上游密钥（管理端「简梦M（MuseAI）」渠道或环境 MUSEM_API_KEY）" };
	}

	// 素材解析（id→OSS 直链优先，拒收 .localhost 伪域）
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);

	// 静态能力表守卫（绝不静默丢：超限/不支持一律明确报错，防 @tag 编号错位）
	const cap = CAPS[up.upstreamModel];
	if (cap) {
		if (imgs.length > cap.img) {
			return { ok: false, error: `该模型参考图上限 ${cap.img} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
		}
		if (vids.length > cap.vid) {
			return {
				ok: false,
				error: cap.vid === 0
					? `该模型不支持参考视频（当前携带 ${vids.length} 个），请移除视频素材后重试`
					: `该模型参考视频上限 ${cap.vid} 个（当前 ${vids.length} 个），请精简后重试`,
			};
		}
		if (auds.length > cap.aud) {
			return { ok: false, error: `该模型参考音频上限 ${cap.aud} 个（当前 ${auds.length} 个），请精简后重试` };
		}
	}

	// prompt 注入 @tag（编号=各模态数组 1-based 序；该家有真引用语法，tag 与素材数组一一对应）
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });

	// 素材数组：{tag, url}——tag 与注入的 @ImageN/@VideoN/@AudioN 严格同名
	const images = imgs.map((x, i) => ({ tag: `Image${i + 1}`, url: x.url }));
	const audios = auds.map((x, i) => ({ tag: `Audio${i + 1}`, url: x.url }));
	const videos = vids.map((x, i) => ({ tag: `Video${i + 1}`, url: x.url }));

	// 整体参考图（带故事板→params.firstFrameUrl）：追加 images 末尾（不前插防图例错位）；已满上限放弃（软性附加项）
	const imgMax = cap?.img ?? IMG_FALLBACK_MAX;
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";
	if (firstFrameParam && !images.some((x) => x.url === firstFrameParam) && images.length < imgMax) {
		const tag = `Image${images.length + 1}`;
		images.push({ tag, url: firstFrameParam });
		prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@${tag}`;
	}

	// ⚠ 时长/比例/分辨率原样透传，绝不静默改写（§9 第188轮定稿，第215轮根除旧夹钳/白名单回退与
	//   分辨率「枚举外不发」静默丢弃——按秒计费按请求参数扣，夹钳=多扣钱少交货）。
	//   档位由管理端模型参数把关，非法值由上游明确报错（失败自动退款）。
	const duration = numberParam(req.params?.duration, 15);
	const ratio = stringParam(req.params?.aspect_ratio, "16:9");

	// images 是 schema 必填字段——恒发（空数组也发）；audios/videos 非空才发
	const body: Record<string, unknown> = { model: up.upstreamModel, prompt, ratio, duration, images };
	const resRaw = String(req.params?.resolution ?? "").trim();
	if (resRaw) body.resolution = resRaw; // 缺省不发=走上游默认；显式值原样发出（§9）
	if (audios.length) body.audios = audios;
	if (videos.length) body.videos = videos;

	// ⚠ 鉴权是 apikey 头（非 Bearer）
	onUpstream?.({ request: { url: `${up.baseUrl}/api/v2/videos`, method: "POST", headers: { "Content-Type": "application/json", apikey: maskToken(up.apiKey) }, body } });

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/api/v2/videos`, {
			method: "POST",
			headers: { "Content-Type": "application/json", apikey: up.apiKey },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		// 幂等性未承诺：超时/网络错误不自动重试（可能已建任务重复计费），交给用户确认后再发
		return { ok: false, error: `简梦M 提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	const taskId = data?.data; // 信封 data 字段=任务号（数字）
	if (!resp.ok || !envelopeOk(data) || taskId == null || taskId === "") {
		return { ok: false, error: upstreamError(data, resp.status, "简梦M 提交") };
	}
	return { ok: true, taskId: String(taskId) };
}

/** 防御式取任务状态：examples 里在 data.status；schema 把枚举误标在 data.id——两个字段都探已知状态词 */
function pickState(d: any): string {
	const known = new Set(["RUNNING", "COMPLETED", "FAILED"]);
	for (const v of [d?.status, d?.id]) {
		const s = String(v ?? "").toUpperCase();
		if (known.has(s)) return s;
	}
	return String(d?.status ?? "").toUpperCase();
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④） */
export async function pollMusemVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
			headers: { apikey: up.apiKey },
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		// 网络抖动：当作仍在进行，让上层下一拍继续轮询
		return { status: "running", progress: 50 };
	}
	const body: any = await resp.json().catch(() => ({}));
	// 5xx/429 视为上游瞬时故障：不终态，下一拍重试（任务有 2h 总超时兜底）
	if (resp.status >= 500 || resp.status === 429) {
		return { status: "running", progress: 50 };
	}
	if (!resp.ok || !envelopeOk(body)) {
		// 400 任务号不合法 / 401 密钥失效 / 404 任务不存在 / 信封 code 报错 → 终态失败
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body } });
		return { status: "failed", error: upstreamError(body, resp.status, "简梦M 轮询") };
	}
	const d = body?.data ?? {};
	const st = pickState(d);
	if (st === "COMPLETED") {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body } });
		const url = typeof d?.url === "string" && /^https?:\/\//i.test(d.url) ? d.url : "";
		if (!url) return { status: "failed", error: "简梦M 任务已完成，但响应中没有可用的视频地址" };
		return { status: "completed", videoUrl: url };
	}
	if (st === "FAILED") {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body } });
		return { status: "failed", error: d?.failReason ? String(d.failReason) : "简梦M 视频生成失败" };
	}
	// RUNNING 及未知状态=生成中继续轮询（容忍上游扩状态；该家无进度字段）
	return { status: "running", progress: 50 };
}
