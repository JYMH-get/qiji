/**
 * 画影（AI-Studio aixyzz）视频渠道翻译器（第133轮接入，异步 submit+poll）。
 *
 * 上游架构（2026-07-18 真机实测，OpenAI 风格 Job 对象）：
 *   POST /videos/generations   body { model, prompt, duration, resolution, aspectRatio,
 *                                     requestId?, images?, videos?, audios? }
 *     → 201 { id:"job_xxx", status:"processing", usage:{cost,…}, balance:{…} }
 *     → 4xx { error:{ code, message, type, request_id } }（invalid_input / insufficient_balance / …）
 *   GET  /videos/{id}          → { id, status:"processing|succeeded|failed|canceled",
 *                                  data:[{ url, cover_url }] }
 *   计费：创建即预扣（balance.reserved），失败不产生最终扣费（上游侧）。
 *
 * ⚠ 真机实测与官方文档的三处出入（2026-07-18，勿按文档回退）：
 *   ① firstFrame/lastFrame **6 条线全部拒收**（invalid_input；单传/成对/换 OSS 直链均拒）→ 首尾帧方法不可用，
 *      模型不声明 methods；「带故事板」（params.firstFrameUrl）改为追加进 images 末尾 + 提示词说明行。
 *   ② 请求体是**严格 schema**：未知字段直接 invalid_json（如 first_frame 蛇形命名）——只发文档列出的键。
 *   ③ /v1/models 的 inputModes 恒 ["text"] 不可信，素材上限以 mediaLimits 为准（已固化进下方 CAPS 表）。
 * requestId 幂等：同 requestId 重复提交返回同一任务（防超时重试重复扣费）——用客户端 clientTaskId（每次提交
 * 均为新 UUID，重新生成=新 id，不会误撞旧任务）。
 * 提示词原样发送（该家无 @image 引用语法，素材图例作为普通说明文字随单发给模型）。
 * 素材直链：OSS（rains3）公网直链直接可用（真机实测）；成片 data[0].url 由通用轮询循环 rehostVideo 转存永久 OSS。
 * 模型能力（素材上限/分辨率/比例）按 2026-07-18 GET /v1/models 实测静态表守卫——上游调整时同步维护。
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

/** 模型能力表（键 = 上游模型 id；2026-07-18 真机 GET /v1/models 实测，时长全部 4-15s） */
interface ModelCap {
	img: number; // 参考图上限
	vid: number; // 参考视频上限
	aud: number; // 参考音频上限
	res: string[]; // 分辨率档（首位=越档回退值）
	aspects: string[];
}
const HY_ASPECTS_6 = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const HY_ASPECTS_3 = ["16:9", "1:1", "9:16"];
const CAPS: Record<string, ModelCap> = {
	"seedance2.0-xs": { img: 9, vid: 3, aud: 3, res: ["720p", "1080p", "4k"], aspects: HY_ASPECTS_6 },
	"video-seedance-2.0-vip": { img: 9, vid: 0, aud: 3, res: ["720p", "1080p"], aspects: HY_ASPECTS_6 },
	"video-seedance-2.0-fast-vip": { img: 9, vid: 0, aud: 3, res: ["720p"], aspects: HY_ASPECTS_6 },
	"seedance-2.0-ai": { img: 9, vid: 0, aud: 0, res: ["720p"], aspects: ["16:9", "9:16"] },
	"seedance-2.0-yo": { img: 4, vid: 3, aud: 1, res: ["480p", "720p"], aspects: HY_ASPECTS_3 },
	"seedance-2.0-fast-yo": { img: 4, vid: 3, aud: 1, res: ["480p", "720p"], aspects: HY_ASPECTS_3 },
};

/** 上游错误 → 人话（error.message 常为泛泛的 "Invalid input"，带上 code 便于排查/对账） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const e = data?.error;
	if (e?.code === "insufficient_balance") return "画影上游余额不足，请联系运营充值后重试";
	const msg = e?.message || data?.message;
	if (msg) return e?.code ? `${msg}（${e.code}）` : String(msg);
	return `${fallback} HTTP ${httpStatus}`;
}

/** ① 提交视频生成任务 → 返回上游 job id */
export async function submitHuayingVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "画影未配置上游密钥（管理端「画影（AI-Studio）」渠道或环境 HUAYING_API_KEY）" };
	}
	const cap = CAPS[up.upstreamModel];

	// 素材解析（id→OSS 直链优先，拒收 .localhost 伪域）。守卫**绝不静默丢**（超限/不支持一律明确报错，
	// 防 @ImageN 图例错位、用户意图丢失——与苏打水/星辰同规则）
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);
	if (cap) {
		if (imgs.length > cap.img) return { ok: false, error: `该模型参考图上限 ${cap.img} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
		if (vids.length > cap.vid) {
			return { ok: false, error: cap.vid === 0 ? "该模型不支持参考视频，请先移除视频素材（或换 hy933/hy431 系模型）后重试" : `该模型参考视频上限 ${cap.vid} 条（当前 ${vids.length} 条），请精简后重试` };
		}
		if (auds.length > cap.aud) {
			return { ok: false, error: cap.aud === 0 ? "该模型不支持参考音频，请先移除音频素材（或换支持音频参考的模型）后重试" : `该模型参考音频上限 ${cap.aud} 条（当前 ${auds.length} 条），请精简后重试` };
		}
	}

	// 提示词：图例/@tag 注入（与其余视频渠道同尺；该家无引用语法，图例作为普通说明文字）
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });

	// ⚠ 时长/比例/分辨率原样透传，绝不静默改写（§9 第188轮定稿，第215轮根除旧夹钳/能力表回退——按秒计费
	//   按请求参数扣，夹钳=多扣钱少交货）。档位由管理端模型参数把关，非法值由上游明确报错（失败自动退款）。
	const duration = numberParam(req.params?.duration, 15);
	const resolution = stringParam(req.params?.resolution, "720p");
	const aspectRatio = stringParam(req.params?.aspect_ratio, "16:9");

	// 整体参考图（带故事板→首帧）：追加到 images 末尾（不前插，保素材 @tag 编号不错位）。
	// 上游 firstFrame 专用字段真机全线拒收（见文件头 ⚠①），只能作参考图并入；素材已满上限时放弃追加（素材优先）。
	const images = imgs.map((x) => x.url);
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";
	if (firstFrameParam && !images.includes(firstFrameParam) && images.length < (cap?.img ?? 9)) {
		images.push(firstFrameParam);
		prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：第${images.length}张参考图（@Image${images.length}）`;
	}

	// ⚠ 上游严格 schema：未知字段直接 invalid_json——只发文档键，勿加自定义字段
	const body: Record<string, unknown> = { model: up.upstreamModel, prompt, duration, resolution, aspectRatio };
	if (req.clientTaskId) body.requestId = `qiji-${req.clientTaskId}`; // 幂等：超时重试不重复扣费
	if (images.length) body.images = images;
	if (vids.length) body.videos = vids.map((x) => x.url);
	if (auds.length) body.audios = auds.map((x) => x.url);

	onUpstream?.({ request: { url: `${up.baseUrl}/videos/generations`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/videos/generations`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		return { ok: false, error: `画影提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	if (!resp.ok || data?.error || !data?.id) {
		return { ok: false, error: upstreamError(data, resp.status, "画影提交") };
	}
	return { ok: true, taskId: String(data.id) };
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④）。status: processing|succeeded|failed|canceled */
export async function pollHuayingVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/videos/${encodeURIComponent(taskId)}`, {
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
	if (!resp.ok || data?.error) {
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: upstreamError(data, resp.status, "画影轮询") };
	}
	const st = String(data?.status || "");
	if (st === "succeeded") {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		const item = Array.isArray(data?.data) ? data.data.find((x: any) => typeof x?.url === "string" && /^https?:\/\//i.test(x.url)) : undefined;
		if (!item) return { status: "failed", error: "画影完成但未返回成片链接" };
		return { status: "completed", videoUrl: String(item.url), coverUrl: typeof item.cover_url === "string" ? item.cover_url : undefined };
	}
	if (st === "failed" || st === "canceled") {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		return { status: "failed", error: st === "canceled" ? "画影任务已在上游被取消" : upstreamError(data, resp.status, "画影生成失败").replace(/^画影生成失败 HTTP \d+$/, "画影生成失败（上游未给出原因）") };
	}
	const p = Number(data?.progress);
	return { status: st === "queued" ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}
