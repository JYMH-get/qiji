/**
 * 火山引擎 AI MediaKit 智能处理翻译器（视频超分×4 / 字幕擦除·精细化）。
 *
 * 上游是「提交→拿 task_id→轮询」架构（与简梦同构，走 index.ts 的 VideoDriver 轮询循环）：
 *   POST {baseUrl}/api/v1/tools/{tool}      → { success, task_id }
 *   GET  {baseUrl}/api/v1/tasks/{task_id}   → { success, status: running|completed|failed, result:{ video_url, duration } }
 * 鉴权：Authorization: Bearer {API Key}（渠道「火山引擎 MediaKit」配置，或环境 VOLC_API_KEY）。
 * 产出 video_url 仅 24 小时有效 → 由通用轮询循环 rehostVideo 转存永久 OSS。
 *
 * 工具端点由模型 upstreamModel 指定：
 *   enhance-video-generative（超分·大模型）/ enhance-video-fast（超分·极速）/
 *   enhance-video:standard / enhance-video:professional（同端点按 ":后缀" 区分 tool_version）/
 *   erase-video-subtitle-pro（去字幕·精细化）。
 * 源视频 = req.inputs.videos[0]（id 为真理解析 OSS 直链，url 兜底；必须公网可达）。
 */
import { maskToken } from "../store/logs.ts";
import { toPublicUrl, type VideoSubmit, type VideoPoll } from "./jianmeng.ts";
import { getModelDef } from "../store/models.ts";
import type { Upstream } from "./upstream.ts";
import { submitSignal } from "./submitTimeout.ts";
import { resolveContentType } from "./contentType.ts";
import type { OnUpstream } from "./openai.ts";
import type { GenerateRequest } from "../contract.ts";

/** 各工具允许透传的请求参数键（白名单，其余客户端参数一概不发） */
const TOOL_PARAM_KEYS: Record<string, string[]> = {
	"enhance-video-generative": ["resolution", "bitrate_level", "fps"],
	"enhance-video-fast": ["resolution", "resolution_limit", "bitrate_level", "fps"],
	"enhance-video": ["scene", "resolution", "resolution_limit", "bitrate_level", "fps"],
	"erase-video-subtitle-pro": ["mode", "output_encode_mode", "erase_ratio_location"],
};

/**
 * 服务端 enum 硬闸（第122轮）：白名单只是"哪些键可发"，值必须再按**运行时模型定义**（管理端「模型→参数」，
 * 含管理员改动）收敛——值不在 options 内 → 回 default（default 也失效则取第一档）。
 * 此前纯透传：管理端把超分收到 720p 后，旧客户端构建 / 画布节点残留 params / 派生记录重跑仍能把
 * 1080p/2k/4k 直发上游（=费用失控点）。模型未声明该键为 enum 时原样放行（如 erase_ratio_location 数组）。
 */
function clampEnum(modelId: string, key: string, v: unknown): unknown {
	const f = getModelDef(modelId)?.params?.find(
		(p) => p.key === key && p.type === "enum" && Array.isArray(p.options) && p.options.length > 0,
	);
	if (!f) return v;
	const opts = f.options!.map(String);
	if (opts.includes(String(v))) return String(v);
	const dft = f.default === undefined ? "" : String(f.default);
	return opts.includes(dft) ? dft : opts[0];
}

/** 解析 upstreamModel → { tool 路径, 附加 body 字段 }（enhance-video:standard → tool_version=standard） */
function parseTool(upstreamModel: string): { tool: string; extra: Record<string, unknown> } {
	const [tool, variant] = upstreamModel.split(":");
	const extra: Record<string, unknown> = {};
	if (tool === "enhance-video" && variant) extra.tool_version = variant;
	return { tool, extra };
}

/** ① 提交智能处理任务 → 返回上游 task_id */
export async function submitVolcProcess(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<VideoSubmit> {
	if (!up.apiKey) {
		return { ok: false, error: "火山引擎 MediaKit 未配置 API Key（管理端「火山引擎 MediaKit」渠道或环境 VOLC_API_KEY）" };
	}
	const src = (req.inputs?.videos ?? [])[0];
	const videoUrl = src ? toPublicUrl(src) : undefined;
	if (!videoUrl) {
		return { ok: false, error: "缺少源视频：inputs.videos[0] 需为公网可达的视频（本地素材请先上传为资产）" };
	}
	const { tool, extra } = parseTool(up.upstreamModel);
	const allow = TOOL_PARAM_KEYS[tool];
	if (!allow) return { ok: false, error: `未知的 MediaKit 工具端点：${up.upstreamModel}` };

	const body: Record<string, unknown> = { video_url: videoUrl, ...extra };
	const declared = new Set((getModelDef(req.model)?.params ?? []).map((p) => p.key));
	for (const k of allow) {
		const v = (req.params as Record<string, unknown> | undefined)?.[k];
		if (v === undefined || v === null || v === "") continue;
		// 未在模型参数（管理端「模型→参数」）里声明的键一律丢弃（局部擦除框除外，它由弹窗画框提供、非选择型）——
		// bitrate_level/output_encode_mode/resolution_limit 属"不开放选择"键，只有管理端显式声明后客户端值才可发
		if (!declared.has(k) && k !== "erase_ratio_location") continue;
		body[k] = clampEnum(req.model, k, v);
	}
	// 码率档位/输出编码不开放选择、且一律不发=走上游默认（第122轮撤销"固定 bitrate_level=high"——
	// 高码率上游费用过高，用户拍板；需要高画质时管理端可给模型 params 加 bitrate_level enum 按档开放）
	// fps 上游要求 Number（catalog enum 值是字符串）；非法值不发（保持源帧率策略交上游）
	if (body.fps !== undefined) {
		const n = Number(body.fps);
		if (Number.isFinite(n) && n >= 15 && n <= 120) body.fps = n;
		else delete body.fps;
	}
	// 局部擦除框清洗：仅保留合法比例框（[0,1] 内、右下>左上），上限 20 个；空数组不发（=全屏默认策略）
	if (Array.isArray(body.erase_ratio_location)) {
		const clamp = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));
		const boxes = (body.erase_ratio_location as Record<string, unknown>[])
			.map((b) => ({
				top_left_x: clamp(b?.top_left_x), top_left_y: clamp(b?.top_left_y),
				bottom_right_x: clamp(b?.bottom_right_x), bottom_right_y: clamp(b?.bottom_right_y),
			}))
			.filter((b) => b.bottom_right_x > b.top_left_x && b.bottom_right_y > b.top_left_y)
			.slice(0, 20);
		if (boxes.length) body.erase_ratio_location = boxes;
		else delete body.erase_ratio_location;
	}

	const url = `${up.baseUrl}/api/v1/tools/${tool}`;
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
		return { ok: false, error: `火山 MediaKit 提交失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	if (!resp.ok || data?.success === false) {
		return { ok: false, error: data?.error?.message || data?.message || `火山 MediaKit 提交 HTTP ${resp.status}` };
	}
	const taskId = data?.task_id;
	if (!taskId) return { ok: false, error: "火山 MediaKit 提交未返回 task_id" };
	return { ok: true, taskId: String(taskId) };
}

/**
 * ③ 图像画质增强（**同步接口** tools-sync，无需轮询）：POST 即返回处理结果链接（24h 有效），
 * 当场下载字节交给 createImageTask 落永久资产。源图 = req.inputs.images[0]（公网 url）。
 * 参数：tool_version(standard/professional/max) + multiple（客户端按源图尺寸换算的倍率，长边≤6000 已在客户端夹紧）
 * 或 target_width/target_height（保留透传能力）。
 */
export async function translateVolcEnhanceImage(
	req: GenerateRequest,
	up: Upstream,
	onUpstream?: OnUpstream,
): Promise<{ ok: true; data: Buffer; contentType: string } | { ok: false; error: string }> {
	if (!up.apiKey) {
		return { ok: false, error: "火山引擎 MediaKit 未配置 API Key（管理端「火山引擎 MediaKit」渠道或环境 VOLC_API_KEY）" };
	}
	const src = (req.inputs?.images ?? [])[0];
	const imageUrl = src ? toPublicUrl(src) : undefined;
	if (!imageUrl) {
		return { ok: false, error: "缺少源图：inputs.images[0] 需为公网可达的图片（本地素材请先上传为资产）" };
	}
	const body: Record<string, unknown> = { image_url: imageUrl };
	const p = (req.params ?? {}) as Record<string, unknown>;
	for (const k of ["tool_version", "multiple", "target_width", "target_height"]) {
		if (p[k] !== undefined && p[k] !== null && p[k] !== "") body[k] = clampEnum(req.model, k, p[k]);
	}
	if (body.multiple !== undefined) {
		const n = Number(body.multiple);
		if (Number.isFinite(n) && n >= 1) body.multiple = Math.min(n, String(body.tool_version) === "standard" ? 8 : 30);
		else delete body.multiple;
	}
	const url = `${up.baseUrl}/api/v1/tools-sync/enhance-image`;
	onUpstream?.({ request: { url, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });
	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: submitSignal(), // 同步接口：处理完成才返回——第169轮取消短超时（详见 submitTimeout.ts）
		});
	} catch (err) {
		return { ok: false, error: `火山图像增强请求失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: { ...data, result: data?.result ? { ...data.result, image_url: data.result.image_url } : undefined } } });
	if (!resp.ok || data?.success === false) {
		return { ok: false, error: data?.error?.message || data?.message || `火山图像增强 HTTP ${resp.status}` };
	}
	const outUrl = data?.result?.image_url;
	if (!outUrl) return { ok: false, error: "火山图像增强完成但未返回 result.image_url" };
	try {
		const ir = await fetch(String(outUrl), { signal: AbortSignal.timeout(120000) });
		if (!ir.ok) return { ok: false, error: `下载增强结果失败 HTTP ${ir.status}` };
		const buf = Buffer.from(await ir.arrayBuffer());
		const ct = resolveContentType(ir.headers.get("content-type"), String(data?.result?.image_format || "png") === "png" ? "image/png" : "image/jpeg");
		return { ok: true, data: buf, contentType: ct };
	} catch (err) {
		return { ok: false, error: `下载增强结果失败：${(err as Error).message}` };
	}
}

/** ② 轮询任务状态（status: running|completed|failed；终态把上游原始响应并入日志 ④） */
export async function pollVolcProcess(up: Upstream, taskId: string, onUpstream?: OnUpstream): Promise<VideoPoll> {
	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
			headers: { Authorization: `Bearer ${up.apiKey}` },
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		// 网络抖动：当作仍在进行，让上层下一拍继续轮询
		return { status: "running", progress: 50 };
	}
	const data: any = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		onUpstream?.({ response: { phase: "poll", httpStatus: resp.status, body: data } });
		return { status: "failed", error: data?.error?.message || `火山 MediaKit 轮询 HTTP ${resp.status}` };
	}
	const st = String(data?.status || "");
	if (st === "completed") {
		onUpstream?.({ response: { phase: "completed", httpStatus: resp.status, body: data } });
		const videoUrl = data?.result?.video_url;
		if (!videoUrl) return { status: "failed", error: "火山 MediaKit 完成但未返回 result.video_url" };
		return { status: "completed", videoUrl: String(videoUrl) };
	}
	if (st === "failed") {
		onUpstream?.({ response: { phase: "failed", httpStatus: resp.status, body: data } });
		return { status: "failed", error: data?.error?.message || data?.message || "火山 MediaKit 处理失败" };
	}
	// 上游无进度字段：running 固定 50（客户端只看四态）
	return { status: st === "queued" || st === "pending" ? "queued" : "running", progress: 50 };
}
