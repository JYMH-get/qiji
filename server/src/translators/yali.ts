/**
 * 鸭梨图像：用户提供 Banana/Gemini、Seedream、Grok 文档（2026-09-15）。
 * 情报源 https://api.yaliai.com/docs（公开SPA）；本轮Web工具无法打开，以用户文档为依据。
 * Bearer；Key按接口类型隔离，模型覆盖Key可在同一鸭梨渠道内分别配置。
 * Gemini已知三款走原生 generateContent（yaliGemini.ts），支持精确512/1K/2K/4K能力。
 * Seedream图生图与文生图都走generations，Grok参考图走edits；均同步调用并复用Qiji图片任务。
 * 所有模型不自动重试付费提交；规格不近似降档；参考图数量与体积由上游判断。
 * 既有GPT Image 2仍走原OpenAI兼容路径和参数。新模型价为占位，开放前核实对应Key与价格。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import { submitSignal } from "./submitTimeout.ts";
import { resolveEditRefs, readImageResult } from "./openai.ts";
import type { OnUpstream, ImageResult } from "./openai.ts";
import type { Upstream } from "./upstream.ts";
import type { GenerateRequest } from "../contract.ts";
import { translateYaliGemini } from './yaliGemini.ts';
import { YALI_GEMINI_SPECS, YALI_GROK_RATIOS, YALI_SEEDREAM_PRO_SIZES } from './yaliSpecs.ts';

/** 显式给了才取（空/缺省=不发该字段，走上游默认）——§9 原样透传，绝不补默认值改写用户请求 */
function opt(v: unknown): string | undefined {
	const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
	return s || undefined;
}


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
	if(!model?.trim())return {ok:false,error:'鸭梨未配置上游模型名'};
	const prompt=buildPrompt(req).trim();
	if(!prompt||prompt==='{}')return {ok:false,error:'提示词不能为空'};
	if(req.inputs?.videos?.length||req.inputs?.audios?.length)return {ok:false,error:'鸭梨图片模型只支持图片参考'};
	const isSeedream=/seedream/i.test(model),isGrok=/^grok-imagine-image(?:-quality)?$/.test(model);
	if(YALI_GEMINI_SPECS[model]&&up.imageMaterialMode!=='url')return translateYaliGemini(req,up,onUpstream);
	// Gemini 类不接受 quality（与 Grok 同——文档明示上游会剥掉；只有 OpenAI Images 类是真质量参数）
	const isGemini = /gemini|banana/i.test(model);

	const body: Record<string, unknown> = { model, prompt: buildPrompt(req) };
	const size = opt(req.params?.size);
	if (size) body.size = size;
	const resolution = opt(req.params?.resolution);
	if (resolution) body.resolution = resolution;
	if (!isGemini && !isSeedream && !isGrok) {
		const quality = opt(req.params?.quality);
		if (quality) body.quality = quality;
	}

	const refCount = req.inputs?.images?.length ?? 0;
	const base=up.baseUrl.replace(/\/+$/,'').replace(/\/v1$/,'');
	let url = `${base}/v1/images/generations`;
	if(isGrok){
		const ratio=opt(req.params?.aspect_ratio??req.params?.size)??'1:1';
		const res=(resolution??'1k').toLowerCase();
		if(!['1k','2k'].includes(res)||!YALI_GROK_RATIOS.includes(ratio))return {ok:false,error:'Grok 仅支持1K/2K及文档比例，禁止近似取档'};
		delete body.size;body.resolution=res;body.aspect_ratio=ratio;body.response_format='url';
	}
	if(isSeedream){
		let pixels=size;
		if(!pixels||pixels.includes(':')){
			const ratio=opt(req.params?.aspect_ratio)??pixels??'1:1';
			pixels=YALI_SEEDREAM_PRO_SIZES[ratio]?.[(resolution??'2k').toLowerCase()];
			if(!pixels)return {ok:false,error:'Seedream 未配置该分辨率与比例的精确尺寸'};
		}
		body.size=pixels;delete body.resolution;body.n=1;body.watermark=false;body.output_format='png';body.response_format='url';
	}

	if (refCount > 0) {
		// 死链探活/台账自愈/明确报错（复用 openai.ts 同一把尺，见其 resolveEditRefs 注释）
		const { refs, missing } = await resolveEditRefs(req,up.imageMaterialMode);
		if (missing.length) {
			return { ok: false, error: `垫图无法获取：${missing.join("、")}——直链已失效且台账无可用直链，请重新生成/上传该资产后再试` };
		}
		if (!refs.length) {
			return { ok: false, error: "垫图无法获取：参考图需为公网可达直链、或服务端持有其资产字节（请配置 OSS，或确认资产 id 有效）" };
		}
		const images: string[] = [];
		for (let i = 0; i < refs.length; i++) {
			const r = refs[i];
			if (r.url) { images.push(r.url); continue; } // 公网直链优先：不占内联预算
			// 只有服务端字节时使用完整 Data URL，体积限制交给上游返回。
			const buf = Buffer.from(await r.bytes!.blob.arrayBuffer());
			images.push(`data:${r.bytes!.blob.type || "image/png"};base64,${buf.toString("base64")}`);
		}
		body.image = images;
		if(!isSeedream)url = `${base}/v1/images/edits`;
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
