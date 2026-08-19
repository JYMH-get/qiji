/**
 * autodl（autodl.art · ComfyUI 工作流平台）视频渠道翻译器（第234轮接入，异步 submit+poll）。
 *
 * 上游架构（官方 docs/comfyui_api + 用户提供的三份工作流文档）：
 *   提交：POST /api/v1/comfyui/comfyui_workflow/{workflow_id}  → { task_id, workflow, status:"QUEUED", ... }
 *   查询：POST /api/v1/comfyui/comfyui_workflow/result/{task_id}（无 body）
 *     → { task_id, status(QUEUED/RUNNING/SUCCESS), results:[{url,type,file_type,output_type}], ... }
 *     （工作流文档另见「信封」形态 { msg, code:"Success", data:{ status:"completed", results, task_id } }——两者都吃）
 *   ⚠ 文档只公布 QUEUED/RUNNING/SUCCESS 三态、**未公布失败状态词** → 防御式状态族（未知词=继续轮询，
 *     任务有 2h 总超时兜底；FAILED/ERROR/CANCELLED 族=失败）。
 *
 * ⚠ 鉴权：`Authorization: <Token令牌>` **原样 token、不带 Bearer 前缀**（文档明写 {"Authorization": 您的Token令牌}；
 *   令牌在 autodl 控制台「令牌管理」创建，分组选 ComfyUI）。勿照抄其它翻译器的 Bearer 写法。
 *
 * ⚠ workflow_id 即「上游模型名」：一个工作流 = 一个模型（多图参考 / 文生视频 / 首尾帧 三条工作流各有
 *   自己的 workflow_id，在 autodl 控制台工作流页可查）——种子 upstreamModel 是占位符「请填写workflow_id」，
 *   **部署后必须在管理端逐模型填入真实 ID**，未填时提交前明确报错（不发请求不扣费）。
 *
 * 三种请求形态（按 method + 素材自动分派，一个翻译器覆盖三条工作流）：
 *   - 首尾帧（method=frames）：{ prompt, first_frame, last_frame, duration?, resolution? }
 *   - 多图参考（有图素材）：{ prompt, ref_image_0..ref_image_8（≤9 张）, duration?, resolution? }
 *   - 文生视频（无素材）：{ prompt, duration?, resolution? }
 * 素材只收图片（三份文档均无视频/音频字段）；无 @tag 引用语法 → 图例注入照常（纯文本说明，上游按图序理解）。
 *
 * ⚠ duration（1-10 整数秒，缺省=上游默认 5）/ resolution（"768p竖" 一类中文档位串）原样透传，
 *   绝不静默改写（§9 第188/215轮定稿）；**缺省时不发该字段**（走上游默认，翻译器不替上游补值）。
 * 成片：results[].url 有效期较短（文档明言「获取后请尽快下载保存」）→ 轮询循环完成即转存 OSS。
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

/** 种子占位符（models.ts ADL_WF_PLACEHOLDER 同值）；命中=管理端还没填真实 workflow_id */
const WF_PLACEHOLDER = "请填写workflow_id";

/** 缺省（undefined/null/空串）→ undefined=不发该字段；显式值经 numberParam 原样透传（数字串归一） */
function optionalNumber(raw: unknown): number | string | undefined {
	if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
	return numberParam(raw, NaN);
}

/** 上游错误 → 人话（信封 {msg}/{message} 与扁平 {error} 形态都探；HTTP 兜底） */
function upstreamError(data: any, httpStatus: number, fallback: string): string {
	const msg = data?.msg || data?.message || data?.error?.message || data?.error || data?.data?.message || "";
	if (msg && typeof msg === "string") return msg;
	return `${fallback} HTTP ${httpStatus}`;
}

/** 信封拆包：{ msg, code, data:{...} } → data；扁平形态原样返回 */
function unwrap(data: any): any {
	return data && typeof data === "object" && data.data && typeof data.data === "object" ? data.data : data ?? {};
}

const SUCCESS_STATES = new Set(["success", "succeeded", "completed", "complete", "done", "finished"]);
const FAILED_STATES = new Set(["failed", "fail", "error", "cancelled", "canceled", "cancel", "timeout", "interrupted"]);
const QUEUED_STATES = new Set(["queued", "pending", "waiting"]);

/** ① 提交工作流任务 → 返回上游 task_id（URL 段 {workflow_id} = 模型 upstreamModel） */
export async function submitAutodlVideo(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "autodl 未配置上游密钥（管理端「autodl（autodl.art）」渠道或环境 AUTODL_API_KEY；令牌在 autodl 控制台「令牌管理」创建，分组选 ComfyUI）" };
	}
	// workflow_id 未配置（占位符原样 / 被清空后回退成模型 id）→ 前置明确报错，不发请求不扣费
	if (!up.upstreamModel || up.upstreamModel.includes(WF_PLACEHOLDER) || /^adl-/.test(up.upstreamModel)) {
		return { ok: false, error: "autodl 未配置工作流 ID：请在管理端该模型的「上游模型名」填入 autodl 控制台对应工作流的 workflow_id" };
	}
	const imgs = resolveNamed(req.inputs?.images);
	const vids = resolveNamed(req.inputs?.videos);
	const auds = resolveNamed(req.inputs?.audios);
	// 三份工作流文档均只有图片字段（ref_image_N / first_frame / last_frame）——视频/音频素材前置明确拒
	if (vids.length || auds.length) {
		return { ok: false, error: "autodl 工作流只收图片素材（ref_image / 首尾帧），请先移除视频/音频素材后重试" };
	}

	let prompt = buildPrompt(req);
	prompt = injectReferenceTags(prompt, { images: imgs });

	// ⚠ duration/resolution 原样透传、缺省不发（§9）；上游默认 时长 5s / 分辨率 768p竖
	const duration = optionalNumber(req.params?.duration);
	const resolution = stringParam(req.params?.resolution, "");

	const method = req.params?.method === "frames" ? "frames" : "omni";
	const firstFrameParam = typeof req.params?.firstFrameUrl === "string" && /^https?:\/\//i.test(req.params.firstFrameUrl)
		? req.params.firstFrameUrl
		: "";

	const body: Record<string, unknown> = { prompt };
	if (duration !== undefined) body.duration = duration;
	if (resolution) body.resolution = resolution;

	if (method === "frames") {
		// ── 首尾帧工作流：first_frame/last_frame 均必填；首=带故事板>素材第 1 图、尾=下一张未用图（与 算力/苏打水/星辰 同尺）──
		const firstFrame = firstFrameParam || imgs[0]?.url || "";
		const lastFrame = firstFrameParam ? imgs[0]?.url || "" : imgs[1]?.url || "";
		if (!firstFrame || !lastFrame) {
			return { ok: false, error: "首尾帧方法需要两张图：首帧（故事板图或素材第 1 张图片）+ 尾帧（素材下一张图片），请补齐素材后重试" };
		}
		body.first_frame = firstFrame;
		body.last_frame = lastFrame;
	} else {
		// ── 多图参考 / 文生视频：图素材逐张落 ref_image_0..8（@Image1 → ref_image_0，顺序与图例编号严格一致）──
		const refs: string[] = imgs.map((x) => x.url);
		// 整体参考图（带故事板首帧）：追加末尾 + 提示词说明行（不前插防 ref_image_N 与 @ImageN 编号错位）
		if (firstFrameParam && !refs.includes(firstFrameParam)) {
			refs.push(firstFrameParam);
			prompt += `${prompt.endsWith("\n") ? "" : "\n"}整体/首帧参考：第 ${refs.length} 张参考图`;
			body.prompt = prompt;
		}
		if (refs.length > 9) {
			// 文档硬限 ref_image_0..ref_image_8 共 9 张——超限明确报错，绝不静默丢（丢一张=@ImageN 图例整段错位）
			return { ok: false, error: `autodl 多图参考最多 9 张图（当前 ${refs.length} 张），请减少图片素材后重试` };
		}
		refs.forEach((u, i) => { body[`ref_image_${i}`] = u; });
	}
	body.prompt = prompt;
	if (!prompt.trim() || prompt.trim() === "{}") {
		return { ok: false, error: "提示词不能为空：请填写视频描述后重试" };
	}

	const url = `${up.baseUrl}/api/v1/comfyui/comfyui_workflow/${encodeURIComponent(up.upstreamModel)}`;
	// ⚠ Authorization 原样 token（不带 Bearer 前缀，文档明写）
	onUpstream?.({ request: { url, method: "POST", headers: { "Content-Type": "application/json", Authorization: maskToken(up.apiKey) }, body } });
	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: up.apiKey },
			body: JSON.stringify(body),
			signal: submitSignal(),
		});
	} catch (err) {
		return { ok: false, error: `autodl 提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	if (!resp.ok) return { ok: false, error: upstreamError(data, resp.status, "autodl 提交") };
	// 信封形态：code 存在且非 Success = 业务失败（HTTP 200 也可能带错误体，防御）
	if (data?.code !== undefined && String(data.code).toLowerCase() !== "success") {
		return { ok: false, error: upstreamError(data, resp.status, "autodl 提交") };
	}
	const taskId = data?.task_id ?? data?.data?.task_id;
	if (!taskId) return { ok: false, error: "autodl 提交未返回 task_id" };
	return { ok: true, taskId: String(taskId) };
}

/** ② 轮询（POST /result/{task_id}，无 body）。状态：QUEUED/RUNNING/SUCCESS（+防御式失败族/信封 completed） */
export async function pollAutodlVideo(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`, {
			method: "POST",
			headers: { Authorization: up.apiKey }, // 文档：Headers 同提交任务、Request Body 无
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		return { status: "running", progress: 50 }; // 网络抖动：下一拍继续
	}
	const data: any = await resp.json().catch(() => ({}));
	if (resp.status >= 500 || resp.status === 429) {
		return { status: "running", progress: 50 }; // 上游瞬时故障：不终态（任务有 2h 总超时兜底）
	}
	if (!resp.ok) {
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: upstreamError(data, resp.status, "autodl 轮询") };
	}
	const inner = unwrap(data);
	const st = String(inner?.status ?? data?.status ?? "").trim().toLowerCase();

	// 结果提取（SUCCESS 与「无状态词但成品已在」两路共用）
	const httpUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);
	const results: any[] = Array.isArray(inner?.results) ? inner.results : [];
	const videoRec =
		results.find((r) => httpUrl(r?.url) && (String(r?.type ?? "").toLowerCase() === "video" || /^(mp4|webm|mov)$/i.test(String(r?.file_type ?? "")))) ||
		results.find((r) => httpUrl(r?.url));

	if (SUCCESS_STATES.has(st) || (!st && videoRec)) {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		if (!videoRec) return { status: "failed", error: "autodl 完成但未返回成片链接" };
		const coverRec = results.find((r) => httpUrl(r?.url) && String(r?.type ?? "").toLowerCase() === "image" && r.url !== videoRec.url);
		// ⚠ 文档未说结果下载需鉴权——防御式只对**本站域**附 Authorization（密钥绝不外发第三方 CDN，第153轮规则）
		let resultHeaders: Record<string, string> | undefined;
		try {
			if (new URL(videoRec.url).hostname === new URL(up.baseUrl).hostname) resultHeaders = { Authorization: up.apiKey };
		} catch { /* 非法 URL 由下载环节明确报错 */ }
		return { status: "completed", videoUrl: videoRec.url, coverUrl: coverRec?.url, resultHeaders };
	}
	if (FAILED_STATES.has(st) || (data?.code !== undefined && String(data.code).toLowerCase() !== "success")) {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		return { status: "failed", error: upstreamError(data, resp.status, "autodl 生成失败") };
	}
	// QUEUED/RUNNING/未知词：继续轮询（文档未公布失败状态词，未知一律不终态）
	return { status: QUEUED_STATES.has(st) ? "queued" : "running", progress: QUEUED_STATES.has(st) ? 10 : 50 };
}
