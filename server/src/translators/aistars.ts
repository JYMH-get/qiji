/**
 * 星辰（AIStartLab OpenAPI）视频渠道翻译器（第132轮接入，异步 submit+poll）。
 *
 * 上游架构（2026-07-18 真机 config + 测试线路实测，形状与官方文档一致）：
 *   POST /generation/create/video   body { channel, model, prompt, aspectRatio, quality, duration, mode?,
 *                                          inputImages?, inputVideos?, inputAudios? }
 *     → { code:0, msg:"success", data:{ taskId, type:2, status, costCredits } }（code≠0 时 msg 即错误信息）
 *   GET  /generation/status?taskId= → { code:0, data:{ status:1|2|3|4, progress:0-100, outputs:[url],
 *                                          errorCode, errorMessage } }
 *   状态：1=已创建排队 2=执行中 3=成功 4=失败；上游创建失败/执行失败自动退回上游积分。
 *   官方测试线路 channel=test/model=test-video 零扣费零上游调用（联调用）。
 *
 * upstreamModel 编码 **"channel|model|quality"**（如 "13|seedance-2.0|480p"）——同一上游模型编码横跨
 * 多条线路、每条线只有一个质量档，凭模型编码反查线路**不唯一**，故线路与质量必须钉在模型定义/routes 里。
 *
 * mode 映射（与我们的「方法」维度同构）：
 *   omni + 有图 → image2video；omni + 无图 → 不传 mode（上游自动按 text2video）；
 *   frames → frames2video（inputImages 恰好 2 张 = 首帧、尾帧；仅 ch18 线支持）。
 * 提示词**原样发送**（该家无 @image 引用语法，素材图例作为普通说明文字随单发给模型）；上游硬限 5000 字符。
 * 素材直链：OSS（rains3）公网直链直接可用；成片 outputs[0] 由通用轮询循环 rehostVideo 转存永久 OSS。
 * 线路能力（素材上限/时长档/比例/必须带图/首尾帧）按 2026-07-26 config 实测静态表守卫（第162轮更新：
 * +53「漫剧优选（卡人脸）」双条目（全系 frames+6 比例）；50 fast 素材放宽 933、时长 4-15、比例收 3 档；
 * 49 线能力翻转（fast 仅 image2video、sd2.0 反而开 frames）；老线 13/36/12/33/19/37/18/24/27 已从
 * config 消失、守卫条目移除——自建模型引用按未知线路直发上游自校验；54「Seedance 2.5 内测」用户定暂不接）
 * ——上游调整时同步维护。
 * 计费注意（运营侧）：请求含参考视频时上游积分 ×1.5 倍率（我们侧定价不建模，定真价时留余量）。
 *
 * 图片（第162轮，协议 aistars-image）：POST /generation/create/image（body 与视频同构：channel/model/
 * prompt/aspectRatio/quality/n + inputImages；无 duration/mode）→ 同一 GET /generation/status 轮询
 * （outputs[0]=图 URL，poll 直接复用 pollAistarsVideo）。质量档（1K/2K/4K）钉在模型编码/routes（价随档变，
 * 与视频质量档同款）；比例=客户端 params.size（比例串/像素尺寸）就近映射线路 aspects。
 * 2026-07-26 官方测试线实锤：channel=test/model=test-image 零扣费全链路通（submit→status→outputs）。
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

/** 线路能力表（键 = "channel|model"；2026-07-22 真机 GET /generation/config 全量实测，第148轮重写） */
interface LineCap {
	img: number; // 参考图上限
	vid: number; // 参考视频上限
	aud: number; // 参考音频上限
	/** 上游无 text2video 模式：必须至少一张参考图（无图前置报错，不发单不扣费） */
	needImage?: boolean;
	/** 支持首尾帧（frames2video）；缺省不支持 */
	frames?: boolean;
	/** 时长离散档（有则忽略 durMin/durMax） */
	durOpts?: number[];
	durMin?: number;
	durMax?: number;
	aspects: string[];
}
const SD_ASPECTS_3 = ["16:9", "9:16", "1:1"];
const SD_ASPECTS_5 = ["16:9", "9:16", "1:1", "4:3", "3:4"];
const SD_ASPECTS_6 = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const GROK_ASPECTS = ["16:9", "9:16", "1:1", "2:3", "3:2", "4:3", "3:4"];
const HV = ["16:9", "9:16"];
const SD_933: Omit<LineCap, "aspects"> = { img: 9, vid: 3, aud: 3, durMin: 4, durMax: 15 };
// 2026-08-09 真机 GET /generation/config 全量重测（第216轮「全部接上」）：+54 Seedance2.5/+58 fast 按条/
// +59 MiniMax H3/+56 HappyHorse/+60 Kling V3 五新线 + 47/49 全模型接入；48/47 线 frames 已从 config 消失、
// 49 fast 恢复 text2video+frames、50 线 sd2.0 时长放宽 4-15、51 grok 能力大改（1.0 连续 1-15s+t2v、1.5 图 1→7）。
// ⚠ aspects/时长在第215轮起**不再夹钳**（参数原样透传，§9）——本表时长/比例仅作缺省默认与文档；
//   img/vid/aud/needImage/frames 仍是前置守卫（明确报错不发单不扣费）。
const LINES: Record<string, LineCap> = {
	// 48「专线」/ 47「推荐（上游默认）」：sd2.0 四质量档（480p/720p/1080p/4K）；2026-08-09 config 起两线均无 frames
	"48|seedance-2.0": { ...SD_933, aspects: SD_ASPECTS_6 },
	"48|seedance-2.0-fast": { ...SD_933, aspects: SD_ASPECTS_6 },
	"47|seedance-2.0": { ...SD_933, aspects: SD_ASPECTS_6 },
	"47|seedance-2.0-fast": { ...SD_933, aspects: SD_ASPECTS_6 },
	// 53「极致性价比·漫剧优选（卡人脸）」：sd2.0 三质量档（480p/720p/1080p）/ fast 两档；**全系首尾帧 + 6 比例**
	//（⚠「卡人脸」=真人素材可能被卡审，运营侧知悉）
	"53|seedance-2.0": { ...SD_933, frames: true, aspects: SD_ASPECTS_6 },
	"53|seedance-2.0-fast": { ...SD_933, frames: true, aspects: SD_ASPECTS_6 },
	// 49「按条计费」（2026-08-09 起 fast 恢复 text2video 且**全系首尾帧**）
	"49|seedance-2.0": { ...SD_933, frames: true, aspects: SD_ASPECTS_6 },
	"49|seedance-2.0-fast": { ...SD_933, frames: true, aspects: SD_ASPECTS_6 },
	// 50「限时特价（不卡人脸）·按条」：933、4-15s（2026-08-09 起 sd2.0 也放宽到 4s）、5 比例
	"50|seedance-2.0": { ...SD_933, aspects: SD_ASPECTS_5 },
	"50|seedance-2.0-fast": { ...SD_933, aspects: SD_ASPECTS_5 },
	// 58「720P 限时·按条（卡人脸 慎用）」：fast 单模型、图9 视0 音0、时长离散档 5/10/15
	"58|seedance-2.0-fast": { img: 9, vid: 0, aud: 0, durOpts: [5, 10, 15], aspects: ["16:9", "9:16", "1:1", "21:9", "4:3"] },
	// 54「Seedance 2.5（官方超低价补贴）」：**图30 视10 音10、4-30s**（与简梦侧 2.5 同款大素材量）
	"54|seedance-2.5": { img: 30, vid: 10, aud: 10, durMin: 4, durMax: 30, aspects: SD_ASPECTS_3 },
	// 59「海螺 MiniMax H3（不卡人脸）」：图9 视0 **音3**、5-15s、双比例
	"59|minimax-h3": { img: 9, vid: 0, aud: 3, durMin: 5, durMax: 15, aspects: HV },
	// 51「Grok（全分辨率）」（2026-08-09 能力大改）：两款均支持 text2video（needImage 移除）；
	// 1.0 时长连续 1-15s（旧 6/10 两档废）+ 7 比例；1.5 图上限 1→7、5-15s、双比例
	"51|grok-imagine-video-1.0": { img: 7, vid: 0, aud: 0, durMin: 1, durMax: 15, aspects: GROK_ASPECTS },
	"51|grok-imagine-video-1.5": { img: 7, vid: 0, aud: 0, durMin: 5, durMax: 15, aspects: HV },
	// 56「快乐马 HappyHorse」：**仅 image2video**（必须带图）、图9、3-15s、5 比例
	"56|happyhorse-1.0": { img: 9, vid: 0, aud: 0, needImage: true, durMin: 3, durMax: 15, aspects: SD_ASPECTS_5 },
	"56|happyhorse-1.1": { img: 9, vid: 0, aud: 0, needImage: true, durMin: 3, durMax: 15, aspects: SD_ASPECTS_5 },
	// 60「可灵 Kling V3」：**仅 image2video**、图3、3-15s、双比例
	"60|kling-v3": { img: 3, vid: 0, aud: 0, needImage: true, durMin: 3, durMax: 15, aspects: HV },
	// 21「Gemini Omni Flash 推荐」：图6、固定 10s、双比例
	"21|gemini-omni-flash": { img: 6, vid: 0, aud: 0, durOpts: [10], aspects: HV },
};

/** 缺省时长的默认档（仅在客户端**没带**时长时使用——显式值一律原样透传，§9）：离散档取最接近 15 的档，区间取 ≤15 的上限 */
function defaultDuration(cap?: LineCap): number {
	if (cap?.durOpts?.length) {
		return cap.durOpts.reduce((best, d) => (Math.abs(d - 15) < Math.abs(best - 15) ? d : best), cap.durOpts[0]);
	}
	return Math.max(cap?.durMin ?? 4, Math.min(cap?.durMax ?? 15, 15));
}

/** ① 提交视频生成任务 → 返回上游 taskId */
export async function submitAistarsVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "星辰（AIStartLab）未配置上游密钥（管理端「星辰（AIStartLab）」渠道或环境 AISTARS_API_KEY）" };
	}
	const [channel, model, quality] = up.upstreamModel.split("|");
	if (!channel || !model || !quality) {
		return { ok: false, error: `星辰上游模型编码不合法（应为 "线路|模型|质量"，如 "13|seedance-2.0|480p"）：${up.upstreamModel}` };
	}
	const cap = LINES[`${channel}|${model}`];
	const method = req.params?.method === "frames" ? "frames" : "omni";
	if (method === "frames" && cap && !cap.frames) {
		return { ok: false, error: "该线路不支持首尾帧方法，请改用全能参考或换用 xc933-sd2.0-fast 模型" };
	}

	// 素材解析（id→OSS 直链优先，拒收 .localhost 伪域）。守卫**绝不静默丢**（超限/不支持一律明确报错，
	// 防 @ImageN 图例错位、用户意图丢失——第131轮 gf 拒视频同规则）
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);
	if (cap) {
		if (imgs.length > cap.img) return { ok: false, error: `该线路参考图上限 ${cap.img} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
		if (vids.length > cap.vid) {
			return { ok: false, error: cap.vid === 0 ? "该线路不支持参考视频，请先移除视频素材（或换支持视频参考的模型）后重试" : `该线路参考视频上限 ${cap.vid} 条（当前 ${vids.length} 条），请精简后重试` };
		}
		if (auds.length > cap.aud) {
			return { ok: false, error: cap.aud === 0 ? "该线路不支持参考音频，请先移除音频素材（或换支持音频参考的模型）后重试" : `该线路参考音频上限 ${cap.aud} 条（当前 ${auds.length} 条），请精简后重试` };
		}
	}

	// 整体参考图（带故事板→首帧）：omni 模式追加到 inputImages 末尾（不前插，保素材 @tag 编号不错位）
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";

	// 提示词：图例/@tag 注入（与其余视频渠道同尺；该家无引用语法，图例作为普通说明文字）
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });

	// ⚠ 时长/比例原样透传，绝不静默改写（§9 第188轮定稿，第215轮根除旧就近取档/夹紧/比例能力表回退——
	//   按秒计费按请求参数扣，夹钳=多扣钱少交货）。档位由管理端模型参数把关，非法值由上游明确报错（失败自动退款）。
	const duration = numberParam(req.params?.duration, defaultDuration(cap));
	const aspectRatio = stringParam(req.params?.aspect_ratio, "16:9");

	let inputImages: string[];
	let mode: string | undefined;
	if (method === "frames") {
		// 首尾帧：首帧 = params.firstFrameUrl（带故事板）> 素材第 1 张图；尾帧 = 下一张未用的图（与苏打水同尺）
		const firstFrame = firstFrameParam || imgs[0]?.url || "";
		const lastFrame = firstFrameParam ? imgs[0]?.url || "" : imgs[1]?.url || "";
		if (!firstFrame || !lastFrame) {
			return { ok: false, error: "首尾帧方法需要两张图：首帧（故事板图或素材第 1 张图片）+ 尾帧（素材下一张图片），请补齐素材后重试" };
		}
		inputImages = [firstFrame, lastFrame]; // 上游要求恰好 2 张，顺序=首帧、尾帧
		mode = "frames2video";
	} else {
		inputImages = imgs.map((x) => x.url);
		if (firstFrameParam && !inputImages.includes(firstFrameParam) && inputImages.length < (cap?.img ?? 9)) {
			inputImages.push(firstFrameParam);
			prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：第${inputImages.length}张参考图（@Image${inputImages.length}）`;
		}
		if (inputImages.length) mode = "image2video";
		else if (cap?.needImage) {
			return { ok: false, error: "该模型不支持纯文生视频：请至少提供一张参考图（素材图片或故事板图）后重试" };
		}
		// 无图不传 mode：上游自动按 text2video 处理
	}
	if (prompt.length > 5000) prompt = prompt.slice(0, 5000); // 上游硬限 5000 字符

	const body: Record<string, unknown> = { channel, model, prompt, aspectRatio, quality, duration };
	if (mode) body.mode = mode;
	if (inputImages.length) body.inputImages = inputImages;
	if (vids.length) body.inputVideos = vids.map((x) => x.url);
	if (auds.length) body.inputAudios = auds.map((x) => x.url);

	onUpstream?.({ request: { url: `${up.baseUrl}/generation/create/video`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/generation/create/video`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		return { ok: false, error: `星辰提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	if (!resp.ok || data?.code !== 0) {
		return { ok: false, error: data?.msg || data?.error?.message || `星辰提交 HTTP ${resp.status}` };
	}
	const taskId = data?.data?.taskId;
	if (!taskId) return { ok: false, error: "星辰提交未返回 taskId" };
	return { ok: true, taskId: String(taskId) };
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④）。状态码：1=排队 2=执行中 3=成功 4=失败 */
export async function pollAistarsVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/generation/status?taskId=${encodeURIComponent(taskId)}`, {
			headers: { Authorization: `Bearer ${up.apiKey}` },
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		// 网络抖动：当作仍在进行，让上层下一拍继续轮询
		return { status: "running", progress: 50 };
	}
	const raw: any = await resp.json().catch(() => ({}));
	// 5xx/429 视为上游瞬时故障：不终态，下一拍重试（任务有 2h 总超时兜底）
	if (resp.status >= 500 || resp.status === 429) {
		return { status: "running", progress: 50 };
	}
	if (!resp.ok || raw?.code !== 0) {
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: raw } });
		return { status: "failed", error: raw?.msg || raw?.error?.message || `星辰轮询 HTTP ${resp.status}` };
	}
	const d: any = raw?.data ?? {};
	const st = Number(d?.status);
	if (st === 3) {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: raw } });
		const url = Array.isArray(d?.outputs) ? d.outputs.find((u: unknown) => typeof u === "string" && /^https?:\/\//i.test(u as string)) : "";
		if (!url) return { status: "failed", error: "星辰完成但未返回成片链接" };
		return { status: "completed", videoUrl: url };
	}
	if (st === 4) {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: raw } });
		const msg = [d?.errorMessage, d?.errorCode].filter(Boolean).join("（") + (d?.errorCode && d?.errorMessage ? "）" : "");
		return { status: "failed", error: msg || "星辰生成失败" };
	}
	const p = Number(d?.progress);
	return { status: st === 1 ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}

/* ═══════════ 图片（第162轮）：POST /generation/create/image + 复用 GET /generation/status ═══════════
 * 2026-07-26 config imageConfig 三线（52 GPT 推荐 / 46 GPT 特价 Low / 23 Nano Banana 双 Gemini 款）；
 * body 与视频同构（无 duration/mode、多 n=1）；轮询回执同形状（outputs[0]=图 URL）→ poll 直接复用
 * pollAistarsVideo；质量档（1K/2K/4K）钉在模型编码/routes（价随档变）。官方测试线 test/test-image 已实锤。 */

/** 图片线路能力表（键 = "channel|model"；2026-08-09 config imageConfig 实测，+55 High 档线）。未知线路不守卫直发 */
const IMG_LINES: Record<string, { img: number; aspects: string[] }> = {
	"55|gpt-image-2": { img: 9, aspects: ["16:9", "9:16", "1:1", "4:3", "3:4"] },
	"52|gpt-image-2": { img: 9, aspects: ["16:9", "9:16", "1:1", "4:3", "3:4"] },
	"46|gpt-image-2": { img: 6, aspects: ["1:1", "4:3", "3:2", "16:9", "21:9", "3:4", "2:3", "9:16"] },
	"23|gemini-3-pro-image-preview": { img: 7, aspects: ["16:9", "9:16", "1:1", "4:3", "3:4"] },
	"23|gemini-3.1-flash-image-preview": { img: 7, aspects: ["16:9", "9:16", "1:1", "4:3", "3:4"] },
};

/** "WxH"/"W:H" → 数值宽高比；解析不出 null（与 jmz 图片同款小工具，纯函数本地留一份） */
function aspectValOf(s: string): number | null {
	const m = s.match(/^(\d+)\s*[x:×]\s*(\d+)$/i);
	if (!m) return null;
	const w = Number(m[1]), h = Number(m[2]);
	return w > 0 && h > 0 ? w / h : null;
}
/** 像素尺寸/比例串 → 允许列表里最接近的比例项（按宽高比数值距离；解析不出回退 1:1>首项） */
function nearestAspect(sizeRaw: string, allowed: string[]): string {
	const fallback = allowed.includes("1:1") ? "1:1" : allowed[0];
	if (allowed.includes(sizeRaw)) return sizeRaw;
	const a = aspectValOf(sizeRaw);
	if (a == null) return fallback;
	return allowed.reduce((best, r) => (Math.abs(aspectValOf(r)! - a) < Math.abs(aspectValOf(best)! - a) ? r : best), allowed[0]);
}

/** ① 提交图片生成任务 → 返回上游 taskId（轮询复用 pollAistarsVideo） */
export async function submitAistarsImage(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "星辰（AIStartLab）未配置上游密钥（管理端「星辰（AIStartLab）」渠道或环境 AISTARS_API_KEY）" };
	}
	const [channel, model, quality] = up.upstreamModel.split("|");
	if (!channel || !model || !quality) {
		return { ok: false, error: `星辰图片上游模型编码不合法（应为 "线路|模型|质量"，如 "52|gpt-image-2|2K"）：${up.upstreamModel}` };
	}
	const cap = IMG_LINES[`${channel}|${model}`];

	// 素材：图片线仅收参考图（视频/音频明确报错，绝不静默丢——防 @tag 图例错位）
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);
	if (vids.length || auds.length) {
		return { ok: false, error: "星辰图片线路只接受图片参考素材，请移除视频/音频素材后重试" };
	}
	if (cap && imgs.length > cap.img) {
		return { ok: false, error: `该线路参考图上限 ${cap.img} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
	}

	// prompt 注入 @Image 图例（该家无引用语法，图例作普通说明文字——与视频同款）；上游硬限 5000 字符同视频
	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs });
	if (prompt.length > 5000) prompt = prompt.slice(0, 5000);

	// 比例：客户端 params.size（比例串/像素尺寸）就近映射线路 aspects；未知线路原样透传（解析得出才发）
	const sizeRaw = String(req.params?.size ?? "");
	const aspectRatio = cap
		? nearestAspect(sizeRaw, cap.aspects)
		: sizeRaw && aspectValOf(sizeRaw) != null
			? sizeRaw
			: "1:1";

	const body: Record<string, unknown> = { channel, model, prompt, aspectRatio, quality, n: 1 };
	if (imgs.length) body.inputImages = imgs.map((x) => x.url);

	onUpstream?.({ request: { url: `${up.baseUrl}/generation/create/image`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/generation/create/image`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		return { ok: false, error: `星辰图片提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	if (!resp.ok || data?.code !== 0) {
		return { ok: false, error: data?.msg || data?.error?.message || `星辰图片提交 HTTP ${resp.status}` };
	}
	const taskId = data?.data?.taskId;
	if (!taskId) return { ok: false, error: "星辰图片提交未返回 taskId" };
	return { ok: true, taskId: String(taskId) };
}
