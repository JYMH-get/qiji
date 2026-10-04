import { resolveEditRefs } from './openai.ts';
import { serializeGeminiImageRequest } from './imageWireDiagnostics.ts';
import { geminiGenerationConfig, geminiRequestOptions } from './geminiImageParams.ts';
/**
 * Gemini 原生图像翻译器（generateContent，含图像模态）。
 *
 * 网关用 Authorization: Bearer 鉴权（非官方 ?key=）。模型名在 URL path 里。
 * 请求体按 AISC 当前 Gemini 对接文档：
 *  - 直传 parts 用 `inlineData/mimeType`；文本在前、垫图在后；
 *  - **全部垫图**都发（此前只取第一张，多图垫图全丢）；
 *  - 显式 generationConfig 原样保留，仅从公共比例/分辨率补齐缺失的 imageConfig 字段。
 * 响应从 candidates[].content.parts[].inlineData / inline_data 取 base64 图像字节（两种命名都兼容）。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import type { ImageResult, OnUpstream } from "./openai.ts";
import type { Upstream } from "./upstream.ts";
import type { GenerateRequest } from "../contract.ts";


/** 从客户端 size（如 "2048x1152"）推导 Gemini imageConfig 的 aspectRatio + imageSize */
function imageConfigFromParams(params?: Record<string, unknown>): { aspectRatio?: string; imageSize?: string } {
	const out: { aspectRatio?: string; imageSize?: string } = {};
	// 显式参数优先（catalog 模型参数可直配）
	if (typeof params?.aspectRatio === "string" && params.aspectRatio) out.aspectRatio = params.aspectRatio as string;
	if (typeof params?.imageSize === "string" && params.imageSize) out.imageSize = params.imageSize as string;
	const size = typeof params?.size === "string" ? (params.size as string) : "";
	const m = size.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
	if (m) {
		const w = Number(m[1]), h = Number(m[2]);
		if (!out.aspectRatio && w > 0 && h > 0) {
			const r = w / h;
			out.aspectRatio = Math.abs(r - 1) < 0.05 ? "1:1" : Math.abs(r - 16 / 9) < 0.1 ? "16:9" : Math.abs(r - 9 / 16) < 0.05 ? "9:16" : undefined;
		}
		if (!out.imageSize) {
			const long = Math.max(w, h);
			out.imageSize = long >= 3840 ? "4K" : long >= 2048 ? "2K" : "1K";
		}
	}
	return out;
}

export async function translateGeminiImage(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<ImageResult> {
	if (!up.apiKey) return { ok: false, error: "该图像模型未配置上游密钥" };
	const prompt = buildPrompt(req);
	const url = `${up.baseUrl}/v1beta/models/${encodeURIComponent(up.upstreamModel)}:generateContent`;
	// 按网关文档：文本在前、垫图在后；全部垫图都发（图生图/多图参考）
	const resolved=await resolveEditRefs(req,up.imageMaterialMode??'direct');
 if(resolved.missing.length)return {ok:false,error:resolved.missing.join('、')};
 const imgParts=up.imageMaterialMode==='url'?resolved.refs.map(r=>({file_data:{mime_type:'image/png',file_uri:r.url}})):await Promise.all(resolved.refs.map(async r=>({inlineData:{mimeType:r.bytes!.blob.type||'image/png',data:Buffer.from(await r.bytes!.blob.arrayBuffer()).toString('base64')}})));
	const reqParts: unknown[] = [{ text: prompt }, ...imgParts];
	const imgCfg = imageConfigFromParams(req.params as Record<string, unknown> | undefined);
	const body: Record<string, unknown> = {
		contents: [{ role: "user", parts: reqParts }],
		...geminiRequestOptions(req.params),
		generationConfig: geminiGenerationConfig(req.params, imgCfg, ["TEXT", "IMAGE"]),
	};

	const wire = serializeGeminiImageRequest(body);
	onUpstream?.({ request: { url, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, refImages: imgParts.length, prompt, generationConfig: body.generationConfig, wire: wire.diagnostics } });

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: wire.bodyText,
			signal: AbortSignal.timeout(60 * 60 * 1000), // 图像生成超时 1 小时
		});
	} catch (err) {
		return { ok: false, error: `Gemini 请求失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	if (!resp.ok) return { ok: false, error: data?.error?.message || `Gemini HTTP ${resp.status}` };

	// 响应兼容 camelCase(官方)与 snake_case(部分网关)两种命名
	const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
	const imgPart = parts.find((p) => p?.inlineData?.data || p?.inline_data?.data);
	if (imgPart) {
		const inline = imgPart.inlineData ?? imgPart.inline_data;
		return {
			ok: true,
			data: Buffer.from(inline.data, "base64"),
			contentType: inline.mimeType || inline.mime_type || "image/png",
		};
	}
	return { ok: false, error: "Gemini 未返回图像（inlineData 为空）" };
}
