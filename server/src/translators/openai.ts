/**
 * OpenAI 兼容文本翻译器（真）。
 *
 * 负责把本协议的 GenerateRequest 翻译成下游 chat/completions 调用，
 * 并在 output.format==="json" 时启用结构化输出（json_schema）+ 解析校验。
 */
import { getSchema } from "../catalog.ts";
import { maskToken } from "../store/logs.ts";
import { buildPrompt } from "./prompt.ts";
import type { Upstream } from "./upstream.ts";
import type { GenerateRequest, TaskState } from "../contract.ts";

export type SyncResult = { status: "success" | "failed"; result?: TaskState["result"]; error?: string };

/** 流式增量回调：每次收到 token 时回传"已累积全文"（边流边落任务，轮询可见） */
export type OnDelta = (fullText: string) => void;

/** 上游请求/响应记录回调：把「管理端↔上游」的请求体与原始响应回传给日志 */
export type OnUpstream = (rec: { request?: unknown; response?: unknown }) => void;

/** 图像翻译器统一返回：成功给字节 + MIME，失败给原因 */
export type ImageResult = { ok: true; data: Buffer; contentType: string } | { ok: false; error: string };

/** 空闲超时：只要持续有 token 流入就一直等；超过此时长无新数据才中断（规避网关/代理空闲断连） */
const STREAM_IDLE_MS = 120000;

/**
 * OpenAI 兼容文本翻译器（真，SSE 流式）。
 * 用 stream:true 持续接收 token：连接保活、可累积部分正文与进度、不受单次总时长限制。
 * 结构化输出(json)同样流式累积，末尾整体 JSON.parse。
 */
export async function translateOpenAIText(req: GenerateRequest, up: Upstream, onDelta?: OnDelta, onUpstream?: OnUpstream): Promise<SyncResult> {
	if (!up.apiKey) {
		return { status: "failed", error: "该模型未配置上游密钥（管理端模型设置或网关 GATEWAY_API_KEY），可改用 echo-text 联调" };
	}

	const wantJson = req.output?.format === "json";
	const body: Record<string, unknown> = {
		model: up.upstreamModel,
		messages: [{ role: "user", content: buildPrompt(req) }],
		temperature: Number(req.params?.temperature ?? 0.7),
		stream: true,
	};
	if (req.params?.maxTokens) body.max_tokens = Number(req.params.maxTokens);

	if (wantJson) {
		const schema = req.output?.schemaId ? getSchema(req.output.schemaId) : undefined;
		if (schema) {
			body.response_format = {
				type: "json_schema",
				json_schema: {
					name: (req.output!.schemaId ?? "output").replace(/[^A-Za-z0-9_]/g, "_"),
					schema,
				},
			};
		} else {
			body.response_format = { type: "json_object" };
		}
	}

	onUpstream?.({ request: { url: `${up.baseUrl}/v1/chat/completions`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	// 空闲超时控制器：每收到一个 chunk 就重置计时；只有长时间无数据才中断
	const ctrl = new AbortController();
	let idle: ReturnType<typeof setTimeout> | null = null;
	const armIdle = () => {
		if (idle) clearTimeout(idle);
		idle = setTimeout(() => ctrl.abort(new Error(`上游空闲超时：${STREAM_IDLE_MS / 1000}秒无新数据`)), STREAM_IDLE_MS);
	};
	const clearIdle = () => { if (idle) clearTimeout(idle); idle = null; };

	let resp: Response;
	try {
		armIdle();
		resp = await fetch(`${up.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: ctrl.signal,
		});
	} catch (err) {
		clearIdle();
		return { status: "failed", error: `下游请求失败：${(err as Error).message}` };
	}

	if (!resp.ok || !resp.body) {
		clearIdle();
		const data: any = await resp.json().catch(() => ({}));
		onUpstream?.({ response: { httpStatus: resp.status, body: data } });
		return { status: "failed", error: data?.error?.message || `下游 HTTP ${resp.status}` };
	}

	let content = "";
	let buffer = "";
	const decoder = new TextDecoder();
	try {
		for await (const chunk of resp.body as any as AsyncIterable<Uint8Array>) {
			armIdle();
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const s = line.trim();
				if (!s.startsWith("data:")) continue;
				const payload = s.slice(5).trim();
				if (payload === "[DONE]") continue;
				try {
					const j = JSON.parse(payload);
					const delta = j?.choices?.[0]?.delta?.content;
					if (typeof delta === "string" && delta) {
						content += delta;
						onDelta?.(content);
					}
				} catch {
					/* 忽略非 JSON 的心跳/注释行 */
				}
			}
		}
	} catch (err) {
		clearIdle();
		return { status: "failed", error: `下游流式中断：${(err as Error).message}` };
	}
	clearIdle();
	onUpstream?.({ response: { httpStatus: resp.status, content } });

	if (!content) return { status: "failed", error: "下游未返回任何内容" };
	if (wantJson) {
		try {
			return { status: "success", result: { json: JSON.parse(content), text: content } };
		} catch {
			return { status: "failed", error: "下游未返回合法 JSON（结构化输出解析失败）" };
		}
	}
	return { status: "success", result: { text: content } };
}

/**
 * 图像生成（g-aisc /v1/images/generations）。
 * 文生图 + 图生图（images[].image_url，须公网 HTTPS）；response_format=url，再下载回字节落本地资产。
 */
export async function translateOpenAIImage(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<ImageResult> {
	if (!up.apiKey) return { ok: false, error: "该图像模型未配置上游密钥" };
	const prompt = buildPrompt(req);
	const inputImages = (req.inputs?.images ?? [])
		.map((r) => r.url)
		.filter((u): u is string => !!u && /^https?:\/\//i.test(u));

	const body: Record<string, unknown> = {
		model: up.upstreamModel,
		prompt,
		n: 1,
		size: (req.params?.size as string) ?? "1024x1024",
		response_format: "url",
	};
	// 图生图：参考图作为 images[].image_url（平台会中转到海外对象存储再发上游）
	if (inputImages.length) body.images = inputImages.map((u) => ({ image_url: u }));

	onUpstream?.({ request: { url: `${up.baseUrl}/v1/images/generations`, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}` }, body } });

	let resp: Response;
	try {
		resp = await fetch(`${up.baseUrl}/v1/images/generations`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}` },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(180000),
		});
	} catch (err) {
		return { ok: false, error: `图像上游请求失败：${(err as Error).message}` };
	}
	const data: any = await resp.json().catch(() => ({}));
	onUpstream?.({ response: { httpStatus: resp.status, body: data } });
	if (!resp.ok) return { ok: false, error: data?.error?.message || `图像上游 HTTP ${resp.status}` };

	const item = data?.data?.[0];
	if (item?.url) {
		// 平台 url 仅 24h 有效 → 下载回字节落本地资产（id 是真理）
		try {
			const img = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
			const buf = Buffer.from(await img.arrayBuffer());
			return { ok: true, data: buf, contentType: img.headers.get("content-type") || "image/png" };
		} catch (err) {
			return { ok: false, error: `下载图像失败：${(err as Error).message}` };
		}
	}
	if (item?.b64_json) {
		return { ok: true, data: Buffer.from(item.b64_json, "base64"), contentType: "image/png" };
	}
	return { ok: false, error: "图像上游未返回 url/b64_json" };
}

/** echo 翻译器：无需密钥，原样回声，供链路联调与离线验收 */
export function translateEcho(req: GenerateRequest): SyncResult {
	const text = buildPrompt(req);
	if (req.output?.format === "json") {
		return { status: "success", result: { json: { echo: text }, text } };
	}
	return { status: "success", result: { text: `「回声」${text}` } };
}
