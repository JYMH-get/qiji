/**
 * 出海营（api.aiid.edu.kg · Seedance 任务格式）视频渠道翻译器（第186轮接入，异步 submit+poll）。
 *
 * 上游架构（按「出海营 API 参考文档 · 视频生成Seedance格式」；Bearer sk- 鉴权，JSON 提交）：
 *   POST /api/v3/contents/generations/tasks       → { id:"task_xxx", status:"queued|running|..." }
 *   GET  /api/v3/contents/generations/tasks/{id}  → { status, content:{video_url}, error:{code,message}, items[] }
 *     查询结果双形态防御（文档同时给了顶层 content.video_url 与 items[].content.video_url/items[].video_url）。
 *     ⚠ 文档未承诺提交幂等：超时/网络错误不自动重试（可能已建任务重复计费），明确报错交用户确认。
 *
 * 请求形态（文档「请求示例」标准格式，兼容入参只按需用两个）：
 *   - 文本与参考素材走 `content` 数组：{type:"text",text} + {type:"image_url"|"video_url"|"audio_url",
 *     <同名对象>:{url}, role:"reference_image|reference_video|reference_audio", name:"ImageN/VideoN/AudioN"}——
 *     name 与我方 injectReferenceTags 注入的 @ImageN/@VideoN/@AudioN 图例编号一一对应（文档：name 可供
 *     提示词按名称引用）；生成配置走顶层 duration / ratio / resolution。
 *   - Seedance 系：无素材=纯文生（不带 mode，走上游默认 t2v）；有素材= mode:"reference_material" + content
 *     （文档调用细节：该模式建议通过 content 传文本与素材）；首尾帧方法= mode:"i2v_first_last" +
 *     兼容字段 image_url/end_image_url（首帧/尾帧）。
 *   - gemini-omni 同接口调用：mode=t2v（纯文生）/ r2v（带图参考）/ edit（带视频编辑）由素材自动定。
 * ⚠ 时长/比例/分辨率一律**原样透传，绝不静默改写**（第188轮用户定稿）：档位由管理端模型参数把关，
 *   非法值由上游明确报错（gemini 4/6/8/10 就档也是上游自动完成，我方不预判）。
 * 提示词：prompt 顶层必填不能为空（前置拦截）；content 首项重复带同文（文档示例即此形态）。
 * generate_audio（兼容入参）：客户端显式带可解析值才透传，否则不发=走上游默认（第122轮规则）。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import { resolveNamed, injectReferenceTags } from "./jianmeng.ts";
import type { VideoSubmit, VideoPoll } from "./jianmeng.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import type { OnUpstream } from "./openai.ts";
import type { GenerateRequest } from "../contract.ts";

const OS_IMG_MAX = 9;
const OS_VID_MAX = 3;
const OS_AUD_MAX = 3;
const OS_TASKS_PATH = "/api/v3/contents/generations/tasks";

/** 上游错误 → 人话（文档错误体 {error:{code,message}}；部分网关错误裸 message） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const msg =
		(typeof data?.error === "string" ? data.error : data?.error?.message) ||
		data?.message ||
		"";
	if (httpStatus === 401 || httpStatus === 403) return "overseas 上游密钥无效或已停用，请联系运营检查渠道密钥";
	if (httpStatus === 429) return "overseas 上游限流，请稍后重试";
	if (httpStatus >= 500) return "overseas 上游服务异常，请稍后重试";
	if (msg) return String(msg);
	return `${fallback} HTTP ${httpStatus}`;
}

type Named = { url: string; name?: string };

/** content 数组素材项（文档对象写法：{type:"image_url", image_url:{url}, role, name}） */
function contentItem(kind: "image" | "video" | "audio", url: string, index: number): Record<string, unknown> {
	const key = `${kind}_url`;
	const tagKind = kind === "image" ? "Image" : kind === "video" ? "Video" : "Audio";
	return { type: key, [key]: { url }, role: `reference_${kind}`, name: `${tagKind}${index + 1}` };
}

/** ① 提交视频生成任务 → 返回上游 task_id */
export async function submitOverseasVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.baseUrl) {
		return { ok: false, error: "overseas 未配置上游地址（管理端「overseas」渠道 Base URL 或环境 OVERSEAS_BASE_URL）" };
	}
	if (!up.apiKey) {
		return { ok: false, error: "overseas 未配置上游密钥（管理端「overseas」渠道或环境 OVERSEAS_API_KEY）" };
	}

	// 素材解析（id→OSS 直链优先，拒收 .localhost 伪域）
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);

	if (imgs.length > OS_IMG_MAX) {
		return { ok: false, error: `overseas 参考图上限 ${OS_IMG_MAX} 张（当前 ${imgs.length} 张），请精简图片素材后重试` };
	}
	if (vids.length > OS_VID_MAX) {
		return { ok: false, error: `overseas 参考视频上限 ${OS_VID_MAX} 个（当前 ${vids.length} 个），请精简后重试` };
	}
	if (auds.length > OS_AUD_MAX) {
		return { ok: false, error: `overseas 参考音频上限 ${OS_AUD_MAX} 个（当前 ${auds.length} 个），请精简后重试` };
	}

	const isGemini = up.upstreamModel.includes("gemini-omni");
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";

	// prompt 必填不能为空（文档）——buildPrompt 无任何输入时的 "{}" 变量兜底形态也视为空
	let prompt = buildPrompt(req);
	if (!prompt.trim() || prompt.trim() === "{}") {
		return { ok: false, error: "提示词不能为空（该渠道 prompt 为必填字段），请填写视频描述后重试" };
	}

	const body: Record<string, unknown> = { model: up.upstreamModel };

	if (!isGemini && String(req.params?.method ?? "") === "frames") {
		// ── 首尾帧方法（兼容 mode:"i2v_first_last" + image_url/end_image_url）──
		if (vids.length || auds.length) {
			return { ok: false, error: "首尾帧方法只接受图片素材（首帧+尾帧），请移除视频/音频素材后重试" };
		}
		// 首帧=「带故事板」firstFrameUrl > 素材第 1 图；尾帧=下一张未用图；缺任一/多余图明确报错（与苏打水/星辰/简梦F 同尺）
		const pool: string[] = [];
		if (firstFrameParam) pool.push(firstFrameParam);
		for (const x of imgs) if (!pool.includes(x.url)) pool.push(x.url);
		if (pool.length < 2) {
			return { ok: false, error: "首尾帧方法需要两张图（首帧+尾帧）：请携带 2 张图片素材，或「带故事板」+1 张图片素材" };
		}
		if (pool.length > 2) {
			return { ok: false, error: `首尾帧方法只需两张图（首帧+尾帧），当前共 ${pool.length} 张，请精简图片素材或改用全能参考` };
		}
		body.mode = "i2v_first_last";
		body.image_url = pool[0];
		body.end_image_url = pool[1];
	} else {
		// ── 全能参考（缺省方法）：content 数组混排 文本+素材 + @tag 图例注入 ──
		const images: Named[] = [...imgs];
		// 整体/首帧参考（带故事板）：追加 images 末尾（不前插防图例错位）；图满 9 张放弃（软性附加项）
		if (firstFrameParam && !images.some((x) => x.url === firstFrameParam) && images.length < OS_IMG_MAX) {
			images.push({ url: firstFrameParam });
			prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：@Image${images.length}`;
		}
		prompt = injectReferenceTags(prompt, { images, videos: vids, audios: auds });

		const hasMaterial = images.length || vids.length || auds.length;
		if (hasMaterial) {
			// mode：seedance 系走 reference_material（文档调用细节）；gemini-omni 带视频=edit、否则=r2v
			body.mode = isGemini ? (vids.length ? "edit" : "r2v") : "reference_material";
			const content: Record<string, unknown>[] = [{ type: "text", text: prompt }];
			images.forEach((x, i) => content.push(contentItem("image", x.url, i)));
			vids.forEach((x, i) => content.push(contentItem("video", x.url, i)));
			auds.forEach((x, i) => content.push(contentItem("audio", x.url, i)));
			body.content = content;
		} else if (isGemini) {
			body.mode = "t2v"; // gemini-omni 纯文生需显式 t2v；seedance 纯文生不带 mode=上游默认
		}
	}

	body.prompt = prompt;

	// 生成配置走顶层字段（文档推荐标准格式）：duration / ratio / resolution。
	// ⚠ 时长**原样透传，绝不静默改写**（第188轮用户定稿，勿回退加 夹钳/就档/兜底默认——第186/187轮的
	//   Math.min 夹钳把请求 30s 静默砍成 15s、按秒计费却按 30 扣=多扣钱，此类「自动判断」一律禁止）：
	//   可选档位由管理端模型参数把关（客户端下拉），非法时长由上游明确报错（失败自动退款）；
	//   gemini-omni 的 4/6/8/10 就档由上游自动完成（文档明言「会自动匹配」）；缺省不发=走上游默认。
	const dur = req.params?.duration;
	if (dur != null && String(dur).trim() !== "") {
		const n = Number(dur);
		body.duration = Number.isFinite(n) ? n : dur; // 数字/数字串归一为 number；其余原样发（上游报错可见）
	}
	const ratio = String(req.params?.aspect_ratio ?? "").trim();
	if (ratio) body.ratio = ratio;
	const resolution = String(req.params?.resolution ?? "").trim();
	if (resolution) body.resolution = resolution;
	// generate_audio（兼容入参）：客户端显式带可解析值才透传，否则不发=走上游默认（第122轮规则）
	if (typeof req.params?.generate_audio === "boolean") body.generate_audio = req.params.generate_audio;
	else if (req.params?.generate_audio === "true" || req.params?.generate_audio === "false") {
		body.generate_audio = req.params.generate_audio === "true";
	}

	onUpstream?.({ request: { url: `${up.baseUrl}${OS_TASKS_PATH}`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}${OS_TASKS_PATH}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		// ⚠ 文档未承诺提交幂等：超时/网络错误不自动重试（可能已建任务），交给用户确认后再发
		return { ok: false, error: `overseas 提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	const taskId = data?.id || data?.task_id;
	if (!resp.ok || !taskId) {
		return { ok: false, error: upstreamError(data, resp.status, "overseas 提交") };
	}
	return { ok: true, taskId: String(taskId) };
}

/** items[] 首个有内容的条目（查询结果双形态：顶层 content 与 items[] 并存防御） */
function firstItem(data: any): any {
	return Array.isArray(data?.items) ? data.items[0] : undefined;
}

/** ② 轮询上游任务状态（终态时把上游原始响应并入日志 ④）。状态：queued|running|succeeded|failed */
export async function pollOverseasVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}${OS_TASKS_PATH}/${encodeURIComponent(taskId)}`, {
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
		return { status: "failed", error: upstreamError(data, resp.status, "overseas 轮询") };
	}
	const item = firstItem(data);
	const st = String(data?.status || item?.status || "").toLowerCase();
	if (st === "succeeded" || st === "success" || st === "completed") {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		// 结果双形态：顶层 content.video_url 或 items[].content.video_url / items[].video_url（文档「查询结果关注字段」）
		const raw = data?.content?.video_url || item?.content?.video_url || item?.video_url;
		let url = "";
		if (typeof raw === "string" && /^https?:\/\//i.test(raw)) url = raw;
		else if (typeof raw === "string" && raw.startsWith("/")) url = `${up.baseUrl}${raw}`;
		if (!url) return { status: "failed", error: "overseas 任务成功但未返回视频地址（上游响应缺 video_url）" };
		// 防御：结果域=本站域才附 Bearer（文档未说结果链接需鉴权；第三方 CDN 绝不带密钥——第153轮规则）
		let resultHeaders: Record<string, string> | undefined;
		try {
			const uh = new URL(url).hostname, bh = new URL(up.baseUrl).hostname;
			if (uh === bh || uh.endsWith(`.${bh}`) || bh.endsWith(`.${uh}`)) {
				resultHeaders = { Authorization: `Bearer ${up.apiKey}` };
			}
		} catch { /* 域解析失败=不附头 */ }
		return { status: "completed", videoUrl: url, resultHeaders };
	}
	if (st === "failed" || st === "cancelled" || st === "canceled") {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		const msg =
			(typeof data?.error === "string" ? data.error : data?.error?.message) ||
			(typeof item?.error === "string" ? item.error : item?.error?.message);
		return { status: "failed", error: msg ? String(msg) : "overseas 视频生成失败" };
	}
	// queued=排队；running 及未知状态=生成中继续轮询（容忍上游扩状态）；items[].progress 可能是 "37%" 字符串
	const p = parseFloat(String(item?.progress ?? data?.progress ?? ""));
	return { status: st === "queued" ? "queued" : "running", progress: Number.isFinite(p) && p > 0 ? Math.min(95, p) : 50 };
}
