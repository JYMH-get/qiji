/**
 * Dimensio（jimeng.dimensio.cn）视频渠道翻译器（第134轮接入，异步 submit+poll）。
 *
 * 上游架构（按官方「视频接口规格」文档；Seedance 2.0 系列）：
 *   POST /v1/videos/generations   body { model, prompt, functionMode, ratio, resolution, duration,
 *                                        image_file_1..9?, video_file_1..3?, audio_file_1..3? }
 *     → { created, task_id, status:"pending" }
 *     请求级错误**不能只看 HTTP 状态码**（文档明言）：body { code, message, data }
 *     （-2000 参数非法 / -2001 请求失败 / 1006·4001·5000·-2012 积分不足 / 1014·1015·34010105 密钥失效 /
 *       2038·2039·2042·2043 安全审核 / 1057·121101 过频）。
 *   GET  /v1/videos/tasks/{taskId} → { task_id, status:"pending|processing|completed|failed|not_found",
 *                                      progress, result:{ url }, error, error_code }
 *   result.url 由上游签发、有效期较短（链接失效可重查同 task_id 换新）→ 由通用轮询循环 rehostVideo 转存永久 OSS。
 *
 * functionMode（**必填**）映射：
 *   - params.method==="frames" → first_last_frames（图片最多 2 张：第 1=首帧、第 2=尾帧）。
 *     首帧 = params.firstFrameUrl（带故事板）> 素材第 1 图；尾帧 = 下一张未用图——与苏打水/星辰同尺
 *     （客户端 frames 前置校验也按这套规则）。该模式素材只收图片（文档）→ 带视频/音频明确报错（绝不静默丢）。
 *   - 其余（omni 缺省）：有任意素材 → omni_reference（图≤9/视≤3/音≤3，多素材总数≤12——超限明确报错）；
 *     无素材 → first_last_frames 纯文生（文档：「无图即纯文生」，omni 是全能参考、不用于纯文生）。
 *   （agentic 为旧客户端兼容别名，不使用。）
 * 提示词引用：该家语法是 @image_file_N/@video_file_N/@audio_file_N（文档示例）——我们的
 *   @Image1/@Video1/@Audio1（客户端素材图例 + 服务端注入）发前统一转换。
 * 素材直链：我们的 OSS（rains3）公网直链（与画影/苏打水同源直链形态，预期直接可用）；拒收 .localhost 伪域（resolveNamed）。
 * intelligent_ratio / face_grid 走上游默认，不发（需要时在管理端给模型 params 声明后再接）。
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

/** 模型能力表（键 = 上游模型 id；按 2026-07-18 官方文档「当前开放模型」——上游调整时同步维护） */
interface ModelCap {
	img: number;
	vid: number;
	aud: number;
	res: string[]; // 分辨率档（首位=越档回退值）
}
const CAPS: Record<string, ModelCap> = {
	"jimeng-video-seedance-2.0-vip": { img: 9, vid: 3, aud: 3, res: ["720p", "1080p"] },
	"jimeng-video-seedance-2.0-fast-vip": { img: 9, vid: 3, aud: 3, res: ["720p"] },
	"jimeng-video-seedance-2.0-mini": { img: 9, vid: 3, aud: 3, res: ["720p"] },
};
/** @Image1/@Video1/@Audio1 → @image_file_1/@video_file_1/@audio_file_1（Dimensio 引用语法，1 基） */
function dimensioTags(prompt: string): string {
	return prompt
		.replace(/@Image(\d+)/g, "@image_file_$1")
		.replace(/@Video(\d+)/g, "@video_file_$1")
		.replace(/@Audio(\d+)/g, "@audio_file_$1");
}

/** 上游错误 → 人话（submit 错误 {code,message} / 任务失败 {error,error_code} 两种形状都吃，带 code 便于对账） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const code = data?.code ?? data?.error_code;
	const c = code != null ? String(code) : "";
	const msg = data?.message || data?.error;
	if (["1006", "4001", "5000", "-2012"].includes(c)) return "Dimensio 上游积分不足，请联系运营充值后重试";
	if (["1014", "1015", "34010105"].includes(c)) return "Dimensio 上游密钥无效或登录失效，请联系运营检查渠道密钥";
	if (["2038", "2039", "2042", "2043"].includes(c)) return `内容安全审核不通过${msg ? `：${msg}` : ""}（${c}），请调整提示词/素材后重试`;
	if (["1057", "121101"].includes(c)) return "Dimensio 请求过频或达到每日生成上限，请稍后重试";
	if (msg) return c ? `${msg}（${c}）` : String(msg);
	return `${fallback} HTTP ${httpStatus}`;
}

/** ① 提交视频生成任务 → 返回上游 task_id */
export async function submitDimensioVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "Dimensio 未配置上游密钥（管理端「Dimensio」渠道或环境 DIMENSIO_API_KEY）" };
	}
	const cap = CAPS[up.upstreamModel];
	const method = req.params?.method === "frames" ? "frames" : "omni";

	// 素材解析（id→OSS 直链优先，拒收 .localhost 伪域）。守卫**绝不静默丢**（超限/不支持一律明确报错，
	// 防 @image_file_N 图例错位、用户意图丢失——与苏打水/星辰/画影同规则）
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);
	const imgMax = cap?.img ?? 9;
	if (imgs.length > imgMax) return { ok: false, error: `该模型参考图上限 ${imgMax} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
	if (vids.length > (cap?.vid ?? 3)) return { ok: false, error: `该模型参考视频上限 ${cap?.vid ?? 3} 条（当前 ${vids.length} 条，且视频总时长不超过 15 秒），请精简后重试` };
	if (auds.length > (cap?.aud ?? 3)) return { ok: false, error: `该模型参考音频上限 ${cap?.aud ?? 3} 条（当前 ${auds.length} 条），请精简后重试` };

	// 整体参考图（带故事板→首帧）
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";

	let prompt = buildPrompt(req);

	// ⚠ 时长/比例/分辨率原样透传，绝不静默改写（§9 第188轮定稿，第215轮根除旧夹钳/能力表回退——按秒计费
	//   按请求参数扣，夹钳=多扣钱少交货）。档位由管理端模型参数把关，非法值由上游明确报错（失败自动退款）。
	const duration = numberParam(req.params?.duration, 15);
	const resolution = stringParam(req.params?.resolution, "720p");
	const ratio = stringParam(req.params?.aspect_ratio, "16:9");

	const body: Record<string, unknown> = { model: up.upstreamModel, prompt, duration, resolution, ratio };
	if (method === "frames") {
		// 首尾帧（first_last_frames）：图片最多 2 张（第 1=首帧、第 2=尾帧），不收视频/音频素材（文档）
		if (vids.length || auds.length) {
			return { ok: false, error: "首尾帧方法只收图片素材（首帧+尾帧），请先移除视频/音频素材（或改用全能参考方法）后重试" };
		}
		const firstFrame = firstFrameParam || imgs[0]?.url || "";
		const lastFrame = firstFrameParam ? imgs[0]?.url || "" : imgs[1]?.url || "";
		if (!firstFrame || !lastFrame) {
			return { ok: false, error: "首尾帧方法需要两张图：首帧（故事板图或素材第 1 张图片）+ 尾帧（素材下一张图片），请补齐素材后重试" };
		}
		body.functionMode = "first_last_frames";
		body.image_file_1 = firstFrame;
		body.image_file_2 = lastFrame;
	} else {
		// 全能参考（omni_reference）：素材图例/@tag 注入 → 转 Dimensio 引用语法；无任何素材=纯文生（first_last_frames 无图形态）
		prompt = injectReferenceTags(prompt, { images: imgs, videos: vids, audios: auds });
		const images = imgs.map((x) => x.url);
		if (firstFrameParam && !images.includes(firstFrameParam) && images.length < imgMax && images.length + vids.length + auds.length < 12) {
			images.push(firstFrameParam);
			prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@image_file_${images.length}`;
		}
		const total = images.length + vids.length + auds.length;
		if (total > 12) {
			return { ok: false, error: `全能参考多素材总数上限 12 个（当前 ${total} 个），请精简素材后重试` };
		}
		body.functionMode = total > 0 ? "omni_reference" : "first_last_frames";
		images.forEach((u, i) => { body[`image_file_${i + 1}`] = u; });
		vids.forEach((x, i) => { body[`video_file_${i + 1}`] = x.url; });
		auds.forEach((x, i) => { body[`audio_file_${i + 1}`] = x.url; });
	}
	body.prompt = dimensioTags(prompt);

	onUpstream?.({ request: { url: `${up.baseUrl}/v1/videos/generations`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/videos/generations`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		return { ok: false, error: `Dimensio 提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	// 文档明言错误可能带 200 状态码返回 {code,message}——task_id 才是提交成功的判据
	if (!resp.ok || !data?.task_id) {
		return { ok: false, error: upstreamError(data, resp.status, "Dimensio 提交") };
	}
	return { ok: true, taskId: String(data.task_id) };
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④）。status: pending|processing|completed|failed|not_found */
export async function pollDimensioVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/videos/tasks/${encodeURIComponent(taskId)}`, {
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
	const st = String(data?.status || "");
	if (!resp.ok || (data?.code != null && !st)) {
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: upstreamError(data, resp.status, "Dimensio 轮询") };
	}
	if (st === "completed") {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		const url = data?.result?.url;
		if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
			return { status: "failed", error: "Dimensio 完成但未返回成片链接" };
		}
		return { status: "completed", videoUrl: url };
	}
	if (st === "failed" || st === "not_found") {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		return {
			status: "failed",
			error: st === "not_found" ? "Dimensio 任务不存在或上游记录已过期" : upstreamError(data, resp.status, "Dimensio 生成失败"),
		};
	}
	const p = Number(data?.progress);
	return { status: st === "pending" ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}
