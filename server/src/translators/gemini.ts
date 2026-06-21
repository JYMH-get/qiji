/**
 * Gemini 原生图像翻译器（generateContent，含图像模态）。
 *
 * 网关用 Authorization: Bearer 鉴权（非官方 ?key=）。模型名在 URL path 里。
 * 响应从 candidates[].content.parts[].inlineData 取 base64 图像字节。
 */
import { buildPrompt } from "./prompt.ts";
import type { ImageResult, OnUpstream } from "./openai.ts";
import type { Upstream } from "./upstream.ts";
import type { GenerateRequest } from "../contract.ts";
import { getAsset } from "../store/assets.ts";

/** 取底图(image-edit/变体图生图)：从 req.inputs.images 第一张取字节作 inlineData */
async function baseImagePart(req: GenerateRequest): Promise<{ inlineData: { mimeType: string; data: string } } | null> {
	const ref = req.inputs?.images?.[0];
	if (!ref) return null;
	if (ref.id) {
		const rec = getAsset(ref.id);
		if (rec) return { inlineData: { mimeType: rec.contentType, data: rec.data.toString("base64") } };
	}
	if (ref.url) {
		try {
			const r = await fetch(ref.url, { signal: AbortSignal.timeout(60000) });
			if (r.ok) {
				const buf = Buffer.from(await r.arrayBuffer());
				return { inlineData: { mimeType: r.headers.get("content-type") || "image/png", data: buf.toString("base64") } };
			}
		} catch {
			/* 底图取不到则退化为纯文生图 */
		}
	}
	return null;
}

export async function translateGeminiImage(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<ImageResult> {
	if (!up.apiKey) return { ok: false, error: "该图像模型未配置上游密钥" };
	const prompt = buildPrompt(req);
	const url = `${up.baseUrl}/v1beta/models/${encodeURIComponent(up.upstreamModel)}:generateContent`;
	// 有底图 → 图生图(变体/编辑)：图像在前、文本在后；无底图 → 纯文生图
	const baseImg = await baseImagePart(req);
	const reqParts = baseImg ? [baseImg, { text: prompt }] : [{ text: prompt }];
	const body: Record<string, unknown> = {
		contents: [{ role: "user", parts: reqParts }],
		generationConfig: {
			responseModalities: ["TEXT", "IMAGE"],
			...(req.params?.aspectRatio ? { imageConfig: { aspectRatio: req.params.aspectRatio } } : {}),
		},
	};

	onUpstream?.({ request: { url, hasBaseImage: !!baseImg, prompt, generationConfig: body.generationConfig } });

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(180000),
		});
	} catch (err) {
		return { ok: false, error: `Gemini 请求失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	if (!resp.ok) return { ok: false, error: data?.error?.message || `Gemini HTTP ${resp.status}` };

	const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
	const imgPart = parts.find((p) => p?.inlineData?.data);
	if (imgPart) {
		return {
			ok: true,
			data: Buffer.from(imgPart.inlineData.data, "base64"),
			contentType: imgPart.inlineData.mimeType || "image/png",
		};
	}
	return { ok: false, error: "Gemini 未返回图像（inlineData 为空）" };
}
