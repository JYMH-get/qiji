/**
 * Yali AI Studio（api.yaliai.com）图片渠道翻译器（第229轮接入，同步单请求——复用 createImageTask 图片管线）。
 *
 * 上游架构（按官方「开发者文档 · 图像 API」，2026-08 版；Base `https://api.yaliai.com`，Bearer）：
 *   路径统一走 **OpenAI Images 形态**：`POST /v1/images/generations`（文生图）/ `POST /v1/images/edits`（图生图）——
 *   本轮接入的两类接口（OpenAI Images / Banana·Gemini）都接受这一形态，故一套代码覆盖，零分支路径。
 *   同步响应 `{ created, data:[{url}] }`（省略 response_format 时默认 url）→ 下载字节落永久资产（id 是真理）。
 *
 * ⚠ **一把 Key 绑定一种「接口类型」**（文档 §认证）：OpenAI Images 的 Key 调不了 Gemini 模型，反之亦然，
 *   错配返回 **403 permission_error**。故种子按接口类型分了两个渠道（ch-yali-openai / ch-yali-gemini），
 *   各填各的 Key；403 的错误文案已明确指向「渠道 Key 与模型接口类型不匹配」，勿改成笼统「无权限」。
 *
 * 规格字段（§参数规则）——⚠ 一律**原样透传绝不静默改写**（§9 第188/215轮定稿），档位由管理端模型参数把关，
 *   非法值由上游明确报错（失败自动退款）：
 *   - `size`：像素（1024x1024 / 2048x1152）或比例写法（16:9 等）；比例写法**必须同时给 resolution** 才会映射，
 *     单传 ratio/aspect_ratio 不替代 size（文档明示）→ 我方参数表只给 size+resolution 两项，不给 ratio。
 *   - `resolution`：1k/2k/4k。⚠ Gemini 3.1 Flash 的最小档 "512" **不是 OpenAI Images 规格**（文档明示
 *     「0.5k 与 512 仅属 Gemini 3.1 Flash 的原生 imageSize」）→ 走本形态时该档不开（要用需改走
 *     /v1beta/...:generateContent 原生路径，属后续可选项）。
 *   - `quality`：auto/low/medium/high，**仅 OpenAI Images 类发送**；Grok 与 Gemini 类不是质量参数
 *     （文档 Grok 节明示上游会剥掉 quality）→ 按上游名判定，gemini 系不发。
 *   - `n` 不发：网关向上游恒提交 n:1（文档明示不能用它请求多图），发了纯噪声。
 *   - `response_format` 不发：省略即 url（文档推荐默认值；亦规避 openai.ts 记录的「多发该字段触发 502」教训）。
 *
 * 参考图（§参数规则·图像参考素材）：最多 6 张；**优先公网 HTTPS URL**（不占内联预算、不撑大请求体）——
 *   走既有 resolveEditRefs（死链探活 → 按资产 id 回查台账当前直链自愈 → 明确报错，⚠ 一张都不许静默丢：
 *   垫图与 @ImageN 图例按位对齐）；仅剩服务端字节（未配 OSS）时按文档支持的**完整 Data URL** 内联，
 *   并守住单张 12 MiB / 合计 30 MiB 上限（超限明确报错并引导配 OSS，绝不发出去让上游 413）。
 *
 * 异步：上游支持请求带 async:true 走统一任务协议（202 + 轮询）——本轮**不用**：createImageTask 已把同步调用
 *   包成我方异步任务（客户端体验一致），且 submitSignal() 已取消提交短超时（第169轮）；真机若出现同步长连接
 *   被中断，再改走 async:true + query_path 轮询（与 jmz-image 同构走 createVideoPollingTask）。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import { submitSignal } from "./submitTimeout.ts";
import { resolveEditRefs, readImageResult } from "./openai.ts";
import type { OnUpstream, ImageResult } from "./openai.ts";
import type { Upstream } from "./upstream.ts";
import type { GenerateRequest } from "../contract.ts";

/** 文档硬限：参考图张数 / 单张内联 Data URL / 内联合计 */
const MAX_REFS = 6;
const MAX_INLINE_ONE = 12 * 1024 * 1024;
const MAX_INLINE_TOTAL = 30 * 1024 * 1024;

/** 显式给了才取（空/缺省=不发该字段，走上游默认）——§9 原样透传，绝不补默认值改写用户请求 */
function opt(v: unknown): string | undefined {
	const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
	return s || undefined;
}

const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);

/** 上游错误 → 人话（文档 §错误处理：error.message + code + failure_category + trace_id） */
function yaliError(data: any, status: number): string {
	const e = data?.error ?? {};
	const msg = (typeof data?.error === "string" ? data.error : e.message) || data?.message || "";
	const code = data?.code || e.code || data?.failure_category || "";
	const trace = data?.trace_id ? `（trace ${data.trace_id}）` : "";
	if (status === 401) return "Yali 上游密钥无效或已过期，请联系运营检查渠道密钥";
	if (status === 403) {
		return `Yali 上游拒绝该请求：Key 已停用、该模型未对本 Key 开放，或 **API Key 与模型的接口类型不匹配**${msg ? `：${msg}` : ""}`
			+ "——请确认该模型归属的渠道里填的是对应接口类型（OpenAI Images / Banana·Gemini）的 Key";
	}
	if (status === 402) return "Yali 上游余额不足，请联系运营充值后重试";
	if (status === 413) return `Yali 请求体过大：${msg || "参考图单张或合计超出上限"}，请精简图片素材后重试`;
	if (status === 422) return `Yali 当前线路无法满足该请求的规格能力${msg ? `：${msg}` : ""}，请更换分辨率/比例档后重试`;
	if (status === 429) return "Yali 上游并发、频率或队列容量受限，请稍后重试";
	if (status === 503 || status === 502 || status === 504) {
		return `Yali 上游暂不可用${msg ? `：${msg}` : ""}${trace}，请稍后重试`;
	}
	if (msg) return `Yali 出图失败：${msg}${code ? `（${code}）` : ""}${trace}`;
	return `Yali 出图失败 HTTP ${status}${trace}`;
}

/** 请求体日志折叠：内联 Data URL 只记体积（防把几 MB base64 写进请求记录） */
function maskBody(body: Record<string, unknown>): Record<string, unknown> {
	const imgs = body.image;
	if (!Array.isArray(imgs)) return body;
	return {
		...body,
		image: imgs.map((u) => (typeof u === "string" && u.startsWith("data:") ? `data:...base64（${Math.round(u.length / 1024)}KB）` : u)),
	};
}

/** 响应日志折叠：b64_json 只记体积 */
function maskResp(data: any): any {
	const b64 = data?.data?.[0]?.b64_json;
	if (typeof b64 !== "string" || !b64) return data;
	return { ...data, data: [{ b64_json: `base64（${Math.round(b64.length / 1024)}KB）` }] };
}

/** 图片生成（同步单请求）：无垫图 → /v1/images/generations；有垫图 → /v1/images/edits（image 数组） */
export async function translateYaliImage(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<ImageResult> {
	if (!up.apiKey) {
		return { ok: false, error: "Yali 未配置上游密钥（请在管理端对应的「Yali」渠道填该接口类型的 Key，或设环境 YALI_API_KEY）" };
	}
	const model = up.upstreamModel;
	// Gemini 类不接受 quality（与 Grok 同——文档明示上游会剥掉；只有 OpenAI Images 类是真质量参数）
	const isGemini = /gemini|banana/i.test(model);

	const body: Record<string, unknown> = { model, prompt: buildPrompt(req) };
	const size = opt(req.params?.size);
	if (size) body.size = size;
	const resolution = opt(req.params?.resolution);
	if (resolution) body.resolution = resolution;
	if (!isGemini) {
		const quality = opt(req.params?.quality);
		if (quality) body.quality = quality;
	}

	const refCount = req.inputs?.images?.length ?? 0;
	let url = `${up.baseUrl}/v1/images/generations`;

	if (refCount > 0) {
		if (refCount > MAX_REFS) {
			return { ok: false, error: `参考图最多 ${MAX_REFS} 张（当前 ${refCount} 张），请精简图片素材后重试` };
		}
		// 死链探活/台账自愈/明确报错（复用 openai.ts 同一把尺，见其 resolveEditRefs 注释）
		const { refs, missing } = await resolveEditRefs(req);
		if (missing.length) {
			return { ok: false, error: `垫图无法获取：${missing.join("、")}——直链已失效且台账无可用直链，请重新生成/上传该资产后再试` };
		}
		if (!refs.length) {
			return { ok: false, error: "垫图无法获取：参考图需为公网可达直链、或服务端持有其资产字节（请配置 OSS，或确认资产 id 有效）" };
		}
		const images: string[] = [];
		let inlineTotal = 0;
		for (let i = 0; i < refs.length; i++) {
			const r = refs[i];
			if (r.url) { images.push(r.url); continue; } // 公网直链优先：不占内联预算
			// 只有服务端字节（未配 OSS 等）→ 完整 Data URL 内联（文档支持形态），并守住两道体积上限
			const buf = Buffer.from(await r.bytes!.blob.arrayBuffer());
			if (buf.length > MAX_INLINE_ONE) {
				return { ok: false, error: `第${i + 1}张参考图 ${mb(buf.length)}MB 超过单张内联上限 12MB——请配置 OSS 让素材有公网直链，或换用更小的图片` };
			}
			inlineTotal += buf.length;
			if (inlineTotal > MAX_INLINE_TOTAL) {
				return { ok: false, error: `参考图内联合计 ${mb(inlineTotal)}MB 超过上限 30MB——请配置 OSS 让素材有公网直链，或减少图片素材` };
			}
			images.push(`data:${r.bytes!.blob.type || "image/png"};base64,${buf.toString("base64")}`);
		}
		body.image = images;
		url = `${up.baseUrl}/v1/images/edits`;
	}

	const headers = { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` };
	onUpstream?.({
		request: {
			url, method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` },
			body: maskBody(body),
		},
	});

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST", headers, body: JSON.stringify(body),
			signal: submitSignal(), // 同步阻塞出图——第169轮取消短超时（详见 submitTimeout.ts）
		});
	} catch (e) {
		return { ok: false, error: `Yali 提交失败：${(e as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: maskResp(data) } });
	if (!resp.ok || data?.error) {
		return { ok: false, error: yaliError(data, resp.status) };
	}
	// data[0].url → 下载字节（服务端拉不动时带 fallbackUrl 交客户端接力，第158轮止血语义）；或 b64_json 兜底
	return readImageResult(data);
}
