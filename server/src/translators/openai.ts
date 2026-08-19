/**
 * OpenAI 兼容文本翻译器（真）。
 *
 * 负责把本协议的 GenerateRequest 翻译成下游 chat/completions 调用，
 * 并在 output.format==="json" 时启用结构化输出（json_schema）+ 解析校验。
 */
import { randomUUID } from "node:crypto";
import { getSchema } from "../catalog.ts";
import { maskToken } from "../store/logs.ts";
import { buildPrompt, collectImageUrls } from "./prompt.ts";
import { getAsset, getAssetBytes } from "../store/assets.ts";
import type { Upstream } from "./upstream.ts";
import type { GenerateRequest, TaskState } from "../contract.ts";

export type SyncResult = { status: "success" | "failed"; result?: TaskState["result"]; error?: string };

/** 流式增量回调：每次收到 token 时回传"已累积全文"（边流边落任务，轮询可见） */
export type OnDelta = (fullText: string) => void;

/** 上游请求/响应记录回调：把「管理端↔上游」的请求体与原始响应回传给日志 */
export type OnUpstream = (rec: { request?: unknown; response?: unknown }) => void;

/** 图像翻译器统一返回：成功给字节 + MIME，失败给原因 */
export type ImageResult =
	| { ok: true; data: Buffer; contentType: string }
	/** fallbackUrl（第158轮）：结果下载失败但上游已成功出图时的原始成品直链——仅在「服务端可能到不了、
	 *  客户端可能到得了」的网络类失败（超时/连接失败/5xx）携带；4xx（链接本身已死）不带。
	 *  createImageTask 见它则以 meta.rehosted=false 完成任务而非整单报废（上游已扣费）。 */
	| { ok: false; error: string; fallbackUrl?: string };

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
	// 多模态：携带图片时，用户消息内容用 [text + image_url...] 数组（OpenAI 兼容）；无图则纯文本
	const promptText = buildPrompt(req);
	const imageUrls = collectImageUrls(req);
	const userContent: unknown = imageUrls.length
		? [{ type: "text", text: promptText }, ...imageUrls.map((u) => ({ type: "image_url", image_url: { url: u } }))]
		: promptText;
	const body: Record<string, unknown> = {
		model: up.upstreamModel,
		messages: [{ role: "user", content: userContent }],
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

/** 公网可达的 http(s) 直链（排除 localhost/asset.localhost/回环地址——g-aisc 服务器拉取不到内网/本机 URL） */
function isPublicHttp(url: string): boolean {
	if (!/^https?:\/\//i.test(url)) return false;
	try {
		const h = new URL(url).hostname.toLowerCase();
		// asset.localhost 是 Tauri 客户端的本机资产地址，上游绝对拉取不到 → 必须排除（含任意 *.localhost）
		return h !== "localhost" && !h.endsWith(".localhost") && h !== "127.0.0.1" && h !== "0.0.0.0" && h !== "::1";
	} catch {
		return false;
	}
}

/** 从资产 url 的文件名反推服务端资产 id（形如 C00000066 / video00000001 / TP00000001：前缀字母 + ≥6 位数字）。 */
function assetIdFromUrl(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const base = decodeURIComponent(url).split(/[\\/?#]/).filter(Boolean).pop() || "";
		const name = base.replace(/\.[a-z0-9]+$/i, "");
		return /^[A-Za-z]+\d{6,}$/.test(name) ? name : null;
	} catch {
		return null;
	}
}

/** 把字节封装成可上传文件（multipart image[] 字段） */
function bytesToBlob(bytes: Buffer, contentType: string): Blob {
	return new Blob([new Uint8Array(bytes)], { type: contentType || "image/png" });
}

/** 从公网直链下载成 Blob（与脚本一致：把 URL 下载回字节再上传）；失败返回 null */
async function downloadBlob(url: string): Promise<Blob | null> {
	try {
		const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
		if (!r.ok) return null;
		const buf = Buffer.from(await r.arrayBuffer());
		return bytesToBlob(buf, r.headers.get("content-type") || "image/png");
	} catch {
		return null;
	}
}

function refFilename(urlOrId: string, index: number): string {
	try {
		const n = new URL(urlOrId).pathname.split("/").pop();
		if (n) return n;
	} catch { /* not a url */ }
	return `${urlOrId || `ref_${index}`}.png`;
}

/**
 * 单次探活（HEAD → 不支持时降级 GET Range 1 字节）。死链发给网关会让其下载失败、报出难排查的 502「stream interrupted」。
 * ⚠ 三态而非布尔：只有 404/410 才能断言「死」——超时/网络抖动/5xx/限流/WAF 拦探测都只是「本次没探到」，
 * 一次失败就判死会把好链误报成「直链已失效」（用户实报的误报即此因）。
 */
async function urlProbeOnce(url: string): Promise<"alive" | "dead" | "transient"> {
	const deadStatus = (s: number) => s === 404 || s === 410;
	try {
		const r = await fetch(url, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
		if (r.ok) return "alive";
		if (deadStatus(r.status)) return "dead";
		const g = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Range: "bytes=0-0" }, signal: AbortSignal.timeout(15000) });
		if (g.ok) return "alive";
		return deadStatus(g.status) ? "dead" : "transient";
	} catch {
		return "transient";
	}
}

/** 直链当下是否真实可达：最多探 3 次（退避 1.5s/3s），只有明确 404/410 才提前判死 */
async function urlAlive(url: string): Promise<boolean> {
	for (let attempt = 1; attempt <= 3; attempt++) {
		const s = await urlProbeOnce(url);
		if (s === "alive") return true;
		if (s === "dead") return false;
		if (attempt < 3) await sleep(attempt * 1500);
	}
	return false;
}

/** 单张垫图的解析结果：实测可达的公网直链，或服务端持有的字节（未配 OSS 时） */
export type ResolvedEditRef = { url?: string; bytes?: { blob: Blob; filename: string } };

/**
 * 逐张把垫图 ref 解析为「实测可达的公网直链」或「服务端字节」：
 * ref.url 公网直链（先探活）→ 死链按资产 id 回查台账**当前**直链再探（id 是真理，url 只是缓存；
 * 旧项目常存着旧 OSS 桶的过期直链，2026-07-11 实测即此况）→ 内存字节兜底 → 全无则记入 missing。
 * ⚠ 一张都不许静默丢：垫图与提示词图例 @ImageN 按位对齐，丢一张=整段图例错位（宁可明确报错）。
 */
export async function resolveEditRefs(req: GenerateRequest): Promise<{ refs: ResolvedEditRef[]; missing: string[] }> {
	const out: ResolvedEditRef[] = [];
	const missing: string[] = [];
	let i = 0;
	for (const ref of req.inputs?.images ?? []) {
		i++;
		const cands: string[] = [];
		if (ref.url && isPublicHttp(ref.url)) cands.push(ref.url);
		const aid = (ref.id && getAsset(ref.id)) ? ref.id : assetIdFromUrl(ref.url);
		const ledgerUrl = aid ? getAsset(aid)?.url : undefined;
		if (ledgerUrl && isPublicHttp(ledgerUrl) && !cands.includes(ledgerUrl)) cands.push(ledgerUrl);
		let hit: string | null = null;
		for (const u of cands) {
			if (await urlAlive(u)) { hit = u; break; }
		}
		if (hit) { out.push({ url: hit }); continue; }
		const bytes = aid ? getAssetBytes(aid) : undefined;
		if (bytes) { out.push({ bytes: { blob: bytesToBlob(bytes, "image/png"), filename: `${aid}.png` } }); continue; }
		missing.push(`第${i}张${ref.name ? `「${ref.name}」` : ""}${aid ? `（${aid}）` : ""}`);
	}
	return { refs: out, missing };
}

/** 把解析结果统一取成可上传字节（multipart 兜底模式用）；任一张取不到返回 null（不静默缺张）。 */
export async function buildEditBlobs(refs: ResolvedEditRef[]): Promise<{ blob: Blob; filename: string }[] | null> {
	const out: { blob: Blob; filename: string }[] = [];
	let i = 0;
	for (const r of refs) {
		i++;
		if (r.bytes) { out.push(r.bytes); continue; }
		const b = await downloadBlob(r.url!);
		if (!b) return null;
		out.push({ blob: b, filename: refFilename(r.url!, i) });
	}
	return out;
}

/**
 * 下载上游结果图为字节：带浏览器 UA + 重试。
 * 结果 url 刚由上游生成时，CDN 偶发 ECONNRESET/瞬断（实测同一 url 稍后可正常下载）——重试并退避；
 * 错因经 fetchErrDetail 还原真相（非笼统 "fetch failed"）。
 * ⚠ 第158轮（用户定，勿回退 3×120s）：服务端只快速试 **2×30s**——部分成片托管域（实锤 vip.edu888.top）
 * 对服务器机房是网络黑洞，长超时×多次只是把整单拖满十分钟仍失败。服务端拉不动时返回 fallbackUrl，
 * 由客户端用本机网络接力下载（3×30s）再经 POST /v1/assets 传回 OSS——两侧任一次成功即可。
 */
async function downloadImageBytes(url: string): Promise<ImageResult> {
	let lastErr = "下载图像失败";
	let mayFallback = false;
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const img = await fetch(url, {
				headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*,*/*" },
				signal: AbortSignal.timeout(30000),
			});
			if (!img.ok) {
				lastErr = `下载图像 HTTP ${img.status}`;
				mayFallback = img.status >= 500; // 4xx=链接本身已死，回给客户端也必然失败 → 不给 fallback
				if (attempt < 2) { await sleep(attempt * 1500); continue; }
				return { ok: false, error: lastErr, fallbackUrl: mayFallback ? url : undefined };
			}
			const buf = Buffer.from(await img.arrayBuffer());
			return { ok: true, data: buf, contentType: img.headers.get("content-type") || "image/png" };
		} catch (err) {
			lastErr = `下载图像失败：${fetchErrDetail(err)}`;
			mayFallback = true; // 超时/连接失败：服务端网络路径问题，客户端可能到得了
			if (attempt < 2) { await sleep(attempt * 1500); continue; }
			return { ok: false, error: lastErr, fallbackUrl: url };
		}
	}
	return { ok: false, error: lastErr, fallbackUrl: mayFallback ? url : undefined };
}

/** 统一从上游响应取图像字节（response_format=url → 下载链接回字节；或 b64_json 兜底） */
export async function readImageResult(data: any): Promise<ImageResult> {
	const item = data?.data?.[0];
	if (item?.url) return downloadImageBytes(item.url);
	if (item?.b64_json) return { ok: true, data: Buffer.from(item.b64_json, "base64"), contentType: "image/png" };
	return { ok: false, error: "图像上游未返回 url/b64_json" };
}

/** 提取 fetch 失败真因：undici 把网络错误包成 "fetch failed"，真正原因在 err.cause */
function fetchErrDetail(err: unknown): string {
	const e = err as { message?: string; cause?: { code?: string; message?: string } };
	const cause = e?.cause ? (e.cause.code || e.cause.message) : "";
	return [e?.message, cause].filter(Boolean).join("：") || String(err);
}

// 图像上游超时：成功路径会被网关长时间占用（同步生成后返回 url），给足时长；不在我方超时上重试（避免叠加 1 小时）。
const IMAGE_TIMEOUT_MS = 60 * 60 * 1000; // 图像上游超时 1 小时
const IMAGE_MAX_ATTEMPTS = 3;
// 可重试的瞬时故障：5xx/限流/Cloudflare 5xx + 网关"流中断/请稍后重试"文案
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

function isRetryable(status: number, data: any): boolean {
	if (RETRYABLE_STATUS.has(status)) return true;
	const msg = String(data?.error?.message ?? data?.message ?? "").toLowerCase();
	return msg.includes("interrupted before completion") || msg.includes("stream was interrupted") || msg.includes("please retry");
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带退避重试的上游图像请求：对 5xx / 流中断 / 网络抖动重试（网关明确提示 "Please retry later"）。
 * 每次重试重建 RequestInit（FormData 需重新构造）；我方超时（TimeoutError）视为非瞬时、不重试。
 */
async function fetchImageWithRetry(url: string, makeInit: () => RequestInit, onUpstream?: OnUpstream): Promise<ImageResult> {
	let lastErr = "图像上游请求失败";
	for (let attempt = 1; attempt <= IMAGE_MAX_ATTEMPTS; attempt++) {
		let resp: Response;
		try {
			resp = await fetch(url, { ...makeInit(), signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
		} catch (err) {
			if ((err as Error)?.name === "TimeoutError") {
				return { ok: false, error: `图像上游超时（${IMAGE_TIMEOUT_MS / 1000}s 未返回）` };
			}
			lastErr = `图像上游请求失败（${fetchErrDetail(err)}）`;
			if (attempt < IMAGE_MAX_ATTEMPTS) { await sleep(attempt * 2000); continue; }
			return { ok: false, error: lastErr };
		}
		const data: any = await resp.json().catch(() => ({}));
		onUpstream?.({ response: { httpStatus: resp.status, attempt, body: data } });
		if (resp.ok) return readImageResult(data);
		lastErr = data?.error?.message || `图像上游 HTTP ${resp.status}`;
		if (isRetryable(resp.status, data) && attempt < IMAGE_MAX_ATTEMPTS) { await sleep(attempt * 2000); continue; }
		return { ok: false, error: lastErr };
	}
	return { ok: false, error: lastErr };
}

/**
 * 图像生成（g-aisc image2）——**严格对齐官方 /v1/images API 文档**。
 * 由 createImageTask 包成真异步任务：先回 taskId（=请求 id），后台调上游 → 落资产 → 客户端按 taskId 取结果。
 *
 * 关键点（2026-07-11 与用户共同定稿，勿回退）：
 * - 无垫图：文生图 → POST /v1/images/generations（JSON，只发 model/prompt/size/quality/n）。
 * - 有垫图：图生图 → POST /v1/images/edits，**主模式=JSON `images:[{image_url}]`**（网关多垫图约定格式，用户确认；
 *   multipart `image[]` 多文件上游只读第一张——多垫图必须走 JSON）。
 * - **发送前逐张探活**（resolveEditRefs）：把死链发给网关会让其下载失败、报出难排查的 502
 *   「Upstream stream was interrupted before completion」（本轮 502 连环报错的真正根因=旧项目垫图存着旧 OSS 桶的过期直链）；
 *   死链按资产 id 回查台账当前直链自愈，仍不可达 → 明确报错（垫图与 @ImageN 图例按位对齐，绝不静默丢图）。
 * - multipart `image[]` 仅两种兜底：①垫图只有服务端字节（未配 OSS）；②账号组内个别账号拒收 JSON
 *   （500「request Content-Type isn't multipart/form-data」）时降级重发一次。
 * - quality/background/output_format/n 为上游原生参数，按能力透传。
 * 链路追踪头 X-Request-ID；瞬时 5xx/流中断由 fetchImageWithRetry 退避重试；拿到 url 后下载回字节落本地资产（id 是真理）。
 */
export async function translateOpenAIImage(req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream): Promise<ImageResult> {
	if (!up.apiKey) return { ok: false, error: "该图像模型未配置上游密钥" };
	const prompt = buildPrompt(req);
	const size = (req.params?.size as string) ?? "1024x1024";
	// quality 默认「高」（用户要求；上游支持 low/medium/high/auto）
	const quality = (req.params?.quality as string) || "high";
	const n = Number(req.params?.n ?? 1) || 1;
	const hasRefs = (req.inputs?.images?.length ?? 0) > 0;

	// 链路追踪头
	const reqId = `qiji-image-${randomUUID().replace(/-/g, "")}`;
	const traceHeaders = { "X-Request-ID": reqId, "X-Client-Request-ID": reqId };

	// 透传可选 OpenAI 原生图片参数（按上游能力）
	const extra: Record<string, unknown> = {};
	if (req.params?.background) extra.background = req.params.background;
	if (req.params?.output_format) extra.output_format = req.params.output_format;

	// ── 图生图：/v1/images/edits ──
	if (hasRefs) {
		const editUrl = `${up.baseUrl}/v1/images/edits`;

		// 逐张探活解析（死链自愈/明确报错，见 resolveEditRefs 注释）
		const { refs, missing } = await resolveEditRefs(req);
		if (missing.length) {
			return { ok: false, error: `垫图无法获取：${missing.join("、")}——直链已失效且台账无可用直链，请重新生成/上传该资产后再试` };
		}
		if (!refs.length) {
			return { ok: false, error: "垫图无法获取：参考图需为公网可达直链、或服务端持有其资产字节（请配置 OSS，或确认资产 id 有效）" };
		}

		// multipart `image[]` 兜底发送（⚠ 多文件时上游只读第一张，仅在 JSON 不可用时使用）
		const sendMultipart = (blobs: { blob: Blob; filename: string }[]): Promise<ImageResult> => {
			onUpstream?.({ request: { url: editUrl, method: "POST", headers: { "Content-Type": "multipart/form-data", Authorization: `Bearer ${maskToken(up.apiKey)}`, ...traceHeaders }, body: { model: up.upstreamModel, prompt, size, quality, n, response_format: "url", ...extra, "image[]": blobs.map((b) => b.filename) } } });
			return fetchImageWithRetry(editUrl, () => {
				// FormData 作 body 时 fetch 自动带 multipart/form-data; boundary，勿手动设 Content-Type；每次重试重建
				const form = new FormData();
				form.append("model", up.upstreamModel);
				form.append("prompt", prompt);
				form.append("size", size);
				form.append("quality", quality);
				form.append("n", String(n));
				form.append("response_format", "url");
				for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
				for (const b of blobs) form.append("image[]", b.blob, b.filename);
				return { method: "POST", headers: { Authorization: `Bearer ${up.apiKey}`, ...traceHeaders }, body: form };
			}, onUpstream);
		};

		// (a) 主模式：JSON `images:[{image_url}]`（网关多垫图约定格式，2026-07-11 用户确认；全部垫图有实测可达直链才可用）
		if (refs.every((r) => r.url)) {
			const body: Record<string, unknown> = {
				model: up.upstreamModel,
				prompt,
				images: refs.map((r) => ({ image_url: r.url })),
				size,
				quality,
				n,
				response_format: "url",
				...extra,
			};
			onUpstream?.({ request: { url: editUrl, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}`, ...traceHeaders }, body } });
			const res = await fetchImageWithRetry(editUrl, () => ({
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}`, ...traceHeaders },
				body: JSON.stringify(body),
			}), onUpstream);
			// 账号组内个别账号只收 multipart（实测 500「request Content-Type isn't multipart/form-data」）→ 降级 multipart 重发一次
			if (!res.ok && /multipart\/form-data/i.test(res.error ?? "")) {
				const blobs = await buildEditBlobs(refs);
				if (blobs?.length) return sendMultipart(blobs);
			}
			return res;
		}

		// (b) 部分垫图只有服务端字节（未配 OSS 等）→ multipart 文件上传兜底
		const blobs = await buildEditBlobs(refs);
		if (!blobs?.length) {
			return { ok: false, error: "垫图下载失败：垫图直链探活通过但下载未成功，请稍后重试" };
		}
		return sendMultipart(blobs);
	}

	// ── 文生图：/v1/images/generations（JSON）──
	// 严格对齐可跑通的「文生图.py」：只发 model/prompt/size/quality/n。
	// 不发 response_format/stream——实测多发这两个字段会稳定触发上游 502「stream interrupted」。
	const body: Record<string, unknown> = {
		model: up.upstreamModel,
		prompt,
		size,
		quality,
		n,
		...extra,
	};
	const genUrl = `${up.baseUrl}/v1/images/generations`;
	onUpstream?.({ request: { url: genUrl, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${maskToken(up.apiKey)}`, ...traceHeaders }, body } });
	return fetchImageWithRetry(genUrl, () => ({
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.apiKey}`, ...traceHeaders },
		body: JSON.stringify(body),
	}), onUpstream);
}

/** echo 翻译器：无需密钥，原样回声，供链路联调与离线验收 */
export function translateEcho(req: GenerateRequest): SyncResult {
	const text = buildPrompt(req);
	if (req.output?.format === "json") {
		return { status: "success", result: { json: { echo: text }, text } };
	}
	return { status: "success", result: { text: `「回声」${text}` } };
}
