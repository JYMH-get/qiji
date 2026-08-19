/**
 * Gemini 原生图像翻译器（generateContent，含图像模态）。
 *
 * 网关用 Authorization: Bearer 鉴权（非官方 ?key=）。模型名在 URL path 里。
 * 请求体按网关文档（第88轮对齐，修"无法垫图"）：
 *  - parts 用 **snake_case** `inline_data/mime_type`（官方两种命名都收，聚合网关只认文档写法——
 *    此前发 camelCase `inlineData` 被网关忽略，垫图等于没发）；文本在前、垫图在后；
 *  - **全部垫图**都发（此前只取第一张，多图垫图全丢）；
 *  - generationConfig.imageConfig 的 aspectRatio/imageSize 从客户端 params.size（如 "2048x1152"）
 *    推导（此前读从未下发的 params.aspectRatio，配置从未生效）。
 * 响应从 candidates[].content.parts[].inlineData / inline_data 取 base64 图像字节（两种命名都兼容）。
 */
import { buildPrompt } from "./prompt.ts";
import { maskToken } from "../store/logs.ts";
import type { ImageResult, OnUpstream } from "./openai.ts";
import type { Upstream } from "./upstream.ts";
import type { GenerateRequest } from "../contract.ts";
import { getAsset, getAssetBytes } from "../store/assets.ts";

type InlinePart = { inline_data: { mime_type: string; data: string } };

/** 取单张垫图字节 → inline_data part；取不到返回 null（跳过该图，不整单失败） */
async function imagePart(ref: { id?: string; url?: string }): Promise<InlinePart | null> {
	// 优先按 id：内存字节(未配 OSS) → 否则取该资产的 OSS 直链
	if (ref.id) {
		const bytes = getAssetBytes(ref.id);
		const rec = getAsset(ref.id);
		if (bytes) return { inline_data: { mime_type: rec?.contentType || "image/png", data: bytes.toString("base64") } };
		if (rec?.url) {
			try {
				const r = await fetch(rec.url, { signal: AbortSignal.timeout(60000) });
				if (r.ok) {
					const buf = Buffer.from(await r.arrayBuffer());
					return { inline_data: { mime_type: r.headers.get("content-type") || rec.contentType || "image/png", data: buf.toString("base64") } };
				}
			} catch { /* 取不到则跳过该图 */ }
		}
	}
	if (ref.url) {
		try {
			const r = await fetch(ref.url, { signal: AbortSignal.timeout(60000) });
			if (r.ok) {
				const buf = Buffer.from(await r.arrayBuffer());
				return { inline_data: { mime_type: r.headers.get("content-type") || "image/png", data: buf.toString("base64") } };
			}
		} catch { /* 取不到则跳过该图 */ }
	}
	return null;
}

/** 全部垫图 → inline_data parts（保序，供 @ImageN 对齐；单图失败跳过不拖累整单） */
async function refImageParts(req: GenerateRequest): Promise<InlinePart[]> {
	const refs = req.inputs?.images ?? [];
	const out: InlinePart[] = [];
	for (const ref of refs) {
		const p = await imagePart(ref);
		if (p) out.push(p);
	}
	return out;
}

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
	const imgParts = await refImageParts(req);
	const reqParts: unknown[] = [{ text: prompt }, ...imgParts];
	const imgCfg = imageConfigFromParams(req.params as Record<string, unknown> | undefined);
	const body: Record<string, unknown> = {
		contents: [{ role: "user", parts: reqParts }],
		generationConfig: {
			responseModalities: ["TEXT", "IMAGE"],
			...(imgCfg.aspectRatio || imgCfg.imageSize
				? { imageConfig: { ...(imgCfg.aspectRatio ? { aspectRatio: imgCfg.aspectRatio } : {}), ...(imgCfg.imageSize ? { imageSize: imgCfg.imageSize } : {}) } }
				: {}),
		},
	};

	onUpstream?.({ request: { url, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, refImages: imgParts.length, prompt, generationConfig: body.generationConfig } });

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
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
