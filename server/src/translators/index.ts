/**
 * 翻译器路由：按模型的 protocol 把 GenerateRequest 分派到具体翻译器，
 * 并在各分支收尾对应的请求日志（finishLog）。
 *
 * 文本（同步）：echo / openai-chat / anthropic-messages。
 * 图像（真异步）：openai-image / gemini-image → 落资产。
 * stub：占位异步任务（无密钥联调 / 暂无上游的 video/audio）。
 */
import type { GenerateRequest, TaskState, AssetOut, Capability } from "../contract.ts";
import { getModelDef } from "../store/models.ts";
import { getTemplateDef } from "../store/templates.ts";
import { createTask, createRunningTask, completeTask, failTask, appendTaskText, setTaskProgress, setTaskResume, type TaskRecord } from "../store/tasks.ts";
import { createAsset } from "../store/assets.ts";
import { isOssConfigured } from "../store/oss.ts";
import { finishLog, attachUpstream } from "../store/logs.ts";
import { resolveUpstream } from "./upstream.ts";
import { translateOpenAIText, translateOpenAIImage, translateEcho, type ImageResult, type OnDelta, type OnUpstream } from "./openai.ts";
import { translateAnthropicText } from "./anthropic.ts";
import { translateGeminiImage } from "./gemini.ts";
import { submitJianmengVideo, pollJianmengVideo, type VideoSubmit, type VideoPoll } from "./jianmeng.ts";
import { submitOpenAIVideo, pollOpenAIVideo } from "./videos.ts";
import { submitVolcProcess, pollVolcProcess, translateVolcEnhanceImage } from "./volc.ts";
import { submitSudashuiVideo, pollSudashuiVideo } from "./sudashui.ts";
import { submitAistarsVideo, pollAistarsVideo, submitAistarsImage } from "./aistars.ts";
import { submitHuayingVideo, pollHuayingVideo } from "./huaying.ts";
import { submitDimensioVideo, pollDimensioVideo } from "./dimensio.ts";
import { submitAivideVideo, pollAivideVideo } from "./aivide.ts";
import { submitJianmengpVideo, pollJianmengpVideo } from "./jianmengp.ts";
import { submitMusemVideo, pollMusemVideo } from "./musem.ts";
import { submitJmzVideo, pollJmzVideo, submitJmzImage, pollJmzImage } from "./jmz.ts";
import { submitJmtVideo, pollJmtVideo } from "./jmt.ts";
import { submitJmfVideo, pollJmfVideo } from "./jmf.ts";
import { submitOverseasVideo, pollOverseasVideo } from "./overseas.ts";
import { submitSuanliVideo, pollSuanliVideo } from "./suanli.ts";
import { translateJmhImage, translateJmhVideo } from "./jmh.ts";
import { translateYaliImage } from "./yali.ts";
import { submitRelay808Image, pollRelay808Image } from "./relay808.ts";
import { translateConggeImage, submitConggeVideo, pollConggeVideo } from "./congge.ts";
import { submitAutodlVideo, pollAutodlVideo } from "./autodl.ts";
import { isBuiltinProtocol, getProtocolDef, type CustomProtocol } from "../store/protocols.ts";
import { runCustomText, runCustomImmediate, customSubmit, customPoll } from "./custom.ts";
import { resolveContentType } from "./contentType.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 资产 id 类型前缀：客户端可用 params.idPrefix 覆盖（如群像 G / 配角 A），否则按 purpose 推导 */
function assetPrefixFor(req: GenerateRequest): string {
	const override = (req.params?.idPrefix as string) || "";
	if (override) return override;
	const p = req.purpose || "";
	if (p.startsWith("asset.scene")) return "S";
	if (p.startsWith("asset.creature")) return "M";
	if (p.startsWith("asset.prop")) return "P";
	if (p.startsWith("asset.character")) return "C";
	if (p === "video.generate" || p === "video.upscale" || p === "video.desub") return "video";
	if (p === "audio.tts") return "audio";
	return "a"; // 其余（含 image.upscale 图像增强产物）走通用图片前缀
}
const assetNameOf = (req: GenerateRequest): string | undefined => (req.params?.assetName as string) || undefined;

export type DispatchResult =
	| { kind: "sync"; status: "success" | "failed"; result?: TaskState["result"]; error?: string }
	| { kind: "async"; taskId: string };

function placeholder(capability: Capability): { data: Buffer; contentType: string } {
	if (capability === "image") {
		const svg =
			`<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512'>` +
			`<rect width='100%' height='100%' fill='#1e1e24'/>` +
			`<text x='50%' y='50%' fill='#8b5cf6' font-size='28' text-anchor='middle' dominant-baseline='middle'>Qiji 占位图</text></svg>`;
		return { data: Buffer.from(svg, "utf8"), contentType: "image/svg+xml" };
	}
	return { data: Buffer.from(`Qiji ${capability} 占位产物`, "utf8"), contentType: "text/plain; charset=utf-8" };
}

async function createStubTask(req: GenerateRequest, capability: Capability, logId?: string): Promise<DispatchResult> {
	const ph = placeholder(capability);
	const asset = await createAsset(ph.data, ph.contentType, capability, { prefix: assetPrefixFor(req), name: assetNameOf(req) });
	const stubAsset: AssetOut = { id: asset.id, type: capability, url: asset.url, meta: { stub: true, model: req.model } };
	const rec = createTask({ clientTaskId: req.clientTaskId, capability, stubAsset });
	if (logId) finishLog(logId, { status: "success", response: { taskId: rec.taskId, stub: true, assetId: asset.id }, taskId: rec.taskId });
	return { kind: "async", taskId: rec.taskId };
}

/**
 * 把远程视频链接（上游自托管，如 r2.dev 6h 链接）转存为**永久 OSS 公网直链**。
 *  - 目的：①根治过期；②给客户端一个 CORS 友好、可下载到本地 asset:// 的源（webview 直接 <video src=https> 被 CSP media-src 拦）。
 *  - 未配 OSS → 直接返回 null（内存兜底对大视频无意义，且非公网永久链）。
 *  - 带重试（3 次退避）：应对下载瞬时抖动 / 大视频超时。
 * 成功返回 { id, url }(OSS)；失败返回 null（调用方回退上游直链）。
 */
export async function rehostVideo(url: string, opts?: { prefix?: string; name?: string; headers?: Record<string, string> }): Promise<{ id: string; url: string } | null> {
	if (!isOssConfigured()) return null; // 无 OSS：无法产出永久公网链
	if (!/^https?:\/\//i.test(url)) return null;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const vr = await fetch(url, { signal: AbortSignal.timeout(180000), headers: opts?.headers });
			if (!vr.ok) throw new Error(`下载视频 HTTP ${vr.status}`);
			const buf = Buffer.from(await vr.arrayBuffer());
			// ⚠ 泛型二进制类型（binary/application octet-stream）视同缺失——上游托管站（如 MinIO）
			// 元数据没配好时会返回它，照单全收会落成 .bin 资产且直链拒播（2026-08-03 出海营实锤）。
			const ct = resolveContentType(vr.headers.get("content-type"), "video/mp4");
			const rec = await createAsset(buf, ct, "video", { prefix: opts?.prefix || "video", name: opts?.name });
			if (rec.url) return { id: rec.id, url: rec.url };
			return null; // createAsset 未产出 OSS 直链（配置异常）→ 交由调用方回退
		} catch (e) {
			if (attempt === 3) {
				console.warn(`[video] 视频转存失败（第 ${attempt} 次），回退上游链接：`, (e as Error).message);
				return null;
			}
			await sleep(1500 * attempt);
		}
	}
	return null;
}

/** 视频驱动：不同渠道（简梦 / OpenAI 风格）各自的提交+轮询，由 createVideoPollingTask 复用轮询循环 */
interface VideoDriver {
	submit: (req: GenerateRequest, up: Upstream, onUpstream?: OnUpstream) => Promise<VideoSubmit>;
	poll: (up: Upstream, taskId: string, onUpstream?: OnUpstream) => Promise<VideoPoll>;
}

/** 协议 → 视频驱动（createVideoPollingTask 与重启续轮询 resumeVideoPolling 共用） */
const VIDEO_DRIVERS: Record<string, VideoDriver> = {
	"jianmeng-video": { submit: submitJianmengVideo, poll: pollJianmengVideo },
	"openai-video": { submit: submitOpenAIVideo, poll: pollOpenAIVideo },
	"volc-mediakit": { submit: submitVolcProcess, poll: pollVolcProcess },
	"sudashui-video": { submit: submitSudashuiVideo, poll: pollSudashuiVideo },
	"aistars-video": { submit: submitAistarsVideo, poll: pollAistarsVideo },
	// 星辰图片（第162轮）：提交走 create/image、轮询回执与视频同形状 → poll 直接复用
	"aistars-image": { submit: submitAistarsImage, poll: pollAistarsVideo },
	"huaying-video": { submit: submitHuayingVideo, poll: pollHuayingVideo },
	"dimensio-video": { submit: submitDimensioVideo, poll: pollDimensioVideo },
	"aivide-video": { submit: submitAivideVideo, poll: pollAivideVideo },
	"jianmengp-video": { submit: submitJianmengpVideo, poll: pollJianmengpVideo },
	"musem-video": { submit: submitMusemVideo, poll: pollMusemVideo },
	"jmz-video": { submit: submitJmzVideo, poll: pollJmzVideo },
	"jmz-image": { submit: submitJmzImage, poll: pollJmzImage },
	"jmt-video": { submit: submitJmtVideo, poll: pollJmtVideo },
	"jmf-video": { submit: submitJmfVideo, poll: pollJmfVideo },
	"overseas-video": { submit: submitOverseasVideo, poll: pollOverseasVideo },
	"suanli-video": { submit: submitSuanliVideo, poll: pollSuanliVideo },
	// Skylee 图片（第230轮）：上游本身异步（?async=true → /v1/images/tasks/{id}）→ 复用轮询管线
	"skylee-image": { submit: submitRelay808Image, poll: pollRelay808Image },
	"congge-video": { submit: submitConggeVideo, poll: pollConggeVideo },
	// autodl（autodl.art·ComfyUI 工作流，第234轮）：提交 /comfyui_workflow/{workflow_id}、查询 /result/{task_id}
	"autodl-video": { submit: submitAutodlVideo, poll: pollAutodlVideo },
};

/** 内置协议轮询间隔覆盖（缺省 8s）。Aivide 文档 §4.4 明确要求 10-15s、勿高频轮询 → 12s；
 *  简梦P 文档建议每 10-15 秒轮询一次 → 同 12s；简梦T/简梦F 文档建议每 3-5 秒轮询 → 5s；
 *  congge 文档「接入注意」建议 3-8 秒一次 → 5s。
 *  提交（createVideoPollingTask）与重启续轮询（resumeVideoPolling）共用本表。 */
const BUILTIN_POLL_INTERVALS: Record<string, number> = { "aivide-video": 12000, "jianmengp-video": 12000, "jmt-video": 5000, "jmf-video": 5000, "congge-video": 5000 };

/** 自定义协议（async-poll）→ 视频驱动：把数据配置包成 submit/poll */
function customVideoDriver(proto: CustomProtocol): VideoDriver {
	return {
		submit: (req, up, onUpstream) => customSubmit(req, up, proto, onUpstream),
		poll: (up, taskId, onUpstream) => customPoll(up, taskId, proto, onUpstream),
	};
}

/** 协议 id → 轮询驱动（内置优先；否则查自定义 async-poll 协议）。用于提交与重启续轮询 */
function videoDriverFor(protocol: string): VideoDriver | null {
	if (VIDEO_DRIVERS[protocol]) return VIDEO_DRIVERS[protocol];
	const proto = getProtocolDef(protocol);
	return proto && proto.enabled && proto.mode === "async-poll" ? customVideoDriver(proto) : null;
}

const VIDEO_DEADLINE_MS = 2 * 60 * 60 * 1000; // 视频生成超时 2 小时

/**
 * 视频轮询循环（提交后 / 重启续轮询 共用）：周期轮询上游(8s)，
 * completed 取视频链接落任务（再下载转存为本机/OSS 永久资产），failed/超时置失败。进度随上游推进。
 * req 只需 purpose/model/params（转存命名与日志用），续轮询场景由落盘信息重建。
 */
async function runVideoPollLoop(opts: {
	taskId: string;
	req: GenerateRequest;
	up: Upstream;
	driver: VideoDriver;
	upstreamTaskId: string;
	deadline: number;
	logId?: string;
	onUpstream?: OnUpstream;
	/** 结果能力：video=转存 OSS 永久链；image/audio=下载字节落资产。缺省 video（内置视频协议） */
	capability?: Capability;
	/** 轮询间隔（毫秒）；缺省 8s（内置协议）。自定义协议可在 poll.intervalMs 配 */
	intervalMs?: number;
}): Promise<void> {
	const { taskId, req, up, driver, upstreamTaskId, deadline, logId, onUpstream } = opts;
	const capability = opts.capability ?? "video";
	const interval = Math.max(2000, opts.intervalMs || 8000);
	while (Date.now() < deadline) {
		await sleep(interval);
		const st = await driver.poll(up, upstreamTaskId, onUpstream);
		if (st.status === "completed") {
			let result: TaskState["result"];
			if (capability === "video") {
				// 把上游视频（如简梦 6h 链接 / r2.dev 直链）转存为**永久 OSS 直链**：
				// ①根治过期；②给客户端一个 CORS 友好、可下载到本地 asset:// 的源（直显 https 被 CSP media-src 拦）。
				// 转存失败（未配 OSS / 源不可达）→ 回退上游直链，并标记 meta.rehosted=false 供客户端二次补救。
				const re = await rehostVideo(st.videoUrl, { prefix: assetPrefixFor(req), name: assetNameOf(req), headers: st.resultHeaders });
				const vAsset = re
					? { id: re.id, url: re.url, rehosted: true }
					: { id: `vid-${upstreamTaskId}`, url: st.videoUrl, rehosted: false };
				result = { assets: [{ id: vAsset.id, type: "video" as Capability, url: vAsset.url, meta: { cover: st.coverUrl, model: req.model, rehosted: vAsset.rehosted } }] };
			} else {
				// 图/音异步：下载完成链接的字节，落为永久资产（OSS/本机），与图像任务同归宿
				// （resultHeaders：结果链接带鉴权的渠道（简梦Z 图片）由 poll 附下载头，第153轮）
				try {
					const dl = await fetch(st.videoUrl, { signal: AbortSignal.timeout(180000), headers: st.resultHeaders });
					if (!dl.ok) throw new Error(`下载结果资产 HTTP ${dl.status}`);
					const ct = resolveContentType(dl.headers.get("content-type"), capability === "audio" ? "audio/mpeg" : "image/png");
					const bytes = Buffer.from(await dl.arrayBuffer());
					const asset = await createAsset(bytes, ct, capability, { prefix: assetPrefixFor(req), name: assetNameOf(req) });
					result = { assets: [{ id: asset.id, type: capability, url: asset.url, meta: { model: req.model } }] };
				} catch (e) {
					const m = (e as Error).message;
					failTask(taskId, m);
					if (logId) finishLog(logId, { status: "failed", error: m, taskId });
					return;
				}
			}
			completeTask(taskId, result);
			if (logId) finishLog(logId, { status: "success", response: result, taskId });
			return;
		}
		if (st.status === "failed") {
			failTask(taskId, st.error);
			if (logId) finishLog(logId, { status: "failed", error: st.error, taskId });
			return;
		}
		setTaskProgress(taskId, st.progress);
	}
	const to = "生成超时（超过轮询时限）";
	failTask(taskId, to);
	if (logId) finishLog(logId, { status: "failed", error: to, taskId });
}

/**
 * 异步视频通用管线：上游本身异步（submit→poll）。先回 taskId，后台提交后进入轮询循环。
 * 提交成功即把上游 task_id 等续轮询信息随任务落盘——进程重启后由启动对账原 taskId 续轮询，
 * 而不是判失败退款（不重提交、不重扣费）。
 */
function createVideoPollingTask(req: GenerateRequest, up: Upstream, protocol: string, driver: VideoDriver, logId?: string, onUpstream?: OnUpstream, capability: Capability = "video", pollOpts?: { intervalMs?: number; timeoutMs?: number }): DispatchResult {
	const rec = createRunningTask(capability, req.clientTaskId, logId);
	const deadlineMs = pollOpts?.timeoutMs && pollOpts.timeoutMs > 0 ? pollOpts.timeoutMs : VIDEO_DEADLINE_MS;
	(async () => {
		const sub = await driver.submit(req, up, onUpstream);
		if (!sub.ok) {
			failTask(rec.taskId, sub.error);
			if (logId) finishLog(logId, { status: "failed", error: sub.error, taskId: rec.taskId });
			return;
		}
		setTaskResume(rec.taskId, {
			kind: "video",
			protocol,
			upstreamTaskId: sub.taskId,
			model: req.model,
			purpose: req.purpose,
			params: req.params as Record<string, unknown> | undefined,
			capability,
		});
		await runVideoPollLoop({
			taskId: rec.taskId, req, up, driver,
			upstreamTaskId: sub.taskId, deadline: Date.now() + deadlineMs, logId, onUpstream, capability,
			intervalMs: pollOpts?.intervalMs,
		});
	})().catch((err) => {
		const m = (err as Error).message;
		failTask(rec.taskId, m);
		if (logId) finishLog(logId, { status: "failed", error: m, taskId: rec.taskId });
	});
	return { kind: "async", taskId: rec.taskId };
}

/**
 * 重启续轮询（启动对账调用）：凭落盘的续轮询信息恢复视频轮询循环，沿用原 taskId——
 * 客户端断连找回的轮询、请求日志（④段追加、终态收尾）全部无缝衔接。
 * 无法恢复（缺信息/协议无驱动/模型已删）→ 返回 false，由对账方判失败+退款。
 */
export function resumeVideoPolling(rec: TaskRecord): boolean {
	const rs = rec.resume;
	if (!rs || rs.kind !== "video" || !rs.upstreamTaskId) return false;
	const driver = videoDriverFor(rs.protocol);
	const model = getModelDef(rs.model);
	if (!driver || !model) return false;
	const req = { purpose: rs.purpose, model: rs.model, params: rs.params, clientTaskId: rec.clientTaskId ?? "" } as GenerateRequest;
	const up = resolveUpstream(model, req);
	const logId = rec.logId;
	const onUpstream: OnUpstream | undefined = logId ? (r) => attachUpstream(logId, r) : undefined;
	// 剩余期限沿用原截止（自定义协议按其 poll.timeoutMs，缺省 2 小时）；停机太久也至少再看 10 分钟（上游可能早已完成，一拍即收）
	const customProto = !isBuiltinProtocol(rs.protocol) ? getProtocolDef(rs.protocol) : undefined;
	const totalMs = customProto?.poll?.timeoutMs && customProto.poll.timeoutMs > 0 ? customProto.poll.timeoutMs : VIDEO_DEADLINE_MS;
	const deadline = Math.max(Date.now() + 10 * 60 * 1000, rec.submittedAt + totalMs);
	runVideoPollLoop({ taskId: rec.taskId, req, up, driver, upstreamTaskId: rs.upstreamTaskId, deadline, logId, onUpstream, capability: rs.capability, intervalMs: customProto?.poll?.intervalMs ?? BUILTIN_POLL_INTERVALS[rs.protocol] }).catch((err) => {
		const m = (err as Error).message;
		failTask(rec.taskId, m);
		if (logId) finishLog(logId, { status: "failed", error: m, taskId: rec.taskId });
	});
	return true;
}

/** 真异步图像任务：先返回 taskId，后台调上游 → 落资产 → 回填任务与日志（capability 缺省 image，自定义音频协议传 audio） */
function createImageTask(req: GenerateRequest, run: () => Promise<ImageResult>, logId?: string, capability: Capability = "image"): DispatchResult {
	const rec = createRunningTask(capability, req.clientTaskId, logId);
	run()
		.then(async (r) => {
			if (!r.ok) {
				// 第158轮（用户定）：上游已成功出图、只是**服务端下载结果失败**（fallbackUrl 仅网络类失败携带）
				// → 绝不整单报废退款（上游已扣费=平台亏损）。以原始直链完成任务并标 meta.rehosted=false，
				// 客户端凭本机网络下载后经 POST /v1/assets 上传回服务端落 OSS、替换成永久直链。
				if (r.fallbackUrl) {
					const result = {
						assets: [{ id: `img-${rec.taskId}`, type: capability, url: r.fallbackUrl, meta: { model: req.model, rehosted: false, downloadError: r.error } }],
					};
					completeTask(rec.taskId, result);
					if (logId) finishLog(logId, { status: "success", response: result, taskId: rec.taskId });
					return;
				}
				failTask(rec.taskId, r.error);
				if (logId) finishLog(logId, { status: "failed", error: r.error, taskId: rec.taskId });
				return;
			}
			const asset = await createAsset(r.data, r.contentType, capability, { prefix: assetPrefixFor(req), name: assetNameOf(req) });
			const result = { assets: [{ id: asset.id, type: capability, url: asset.url, meta: { model: req.model } }] };
			completeTask(rec.taskId, result);
			if (logId) finishLog(logId, { status: "success", response: result, taskId: rec.taskId });
		})
		.catch((err) => {
			const msg = (err as Error).message;
			failTask(rec.taskId, msg);
			if (logId) finishLog(logId, { status: "failed", error: msg, taskId: rec.taskId });
		});
	return { kind: "async", taskId: rec.taskId };
}

type SyncOutcome = { status: "success" | "failed"; result?: TaskState["result"]; error?: string };
type ModelDef = NonNullable<ReturnType<typeof getModelDef>>;
type Upstream = ReturnType<typeof resolveUpstream>;

const TEXT_PROTOCOLS = new Set(["echo", "openai-chat", "anthropic-messages"]);

/** 内部：执行文本翻译器（echo/openai-chat/anthropic-messages）；onDelta 边流边回传部分正文 */
async function runTextSync(req: GenerateRequest, model: ModelDef, up: Upstream, onDelta?: OnDelta, onUpstream?: OnUpstream): Promise<SyncOutcome> {
	switch (model.protocol) {
		case "echo": {
			const r = translateEcho(req);
			if (r.status === "success" && r.result?.text) onDelta?.(r.result.text);
			onUpstream?.({ request: { protocol: "echo", prompt: req.variables?.prompt ?? req.promptOverride }, response: r.result });
			return r;
		}
		case "openai-chat":
			return await translateOpenAIText(req, up, onDelta, onUpstream);
		case "anthropic-messages":
			return await translateAnthropicText(req, up, onDelta, onUpstream);
		default:
			return { status: "failed", error: `非文本协议无法同步执行：${model.protocol}` };
	}
}

/**
 * 链式两段复合（文本→文本）：先跑 A（强制文本），把输出注入 B 的 chainPipeVar 再跑 B。
 * 全程服务端内部同步完成；对外由 createTextTask 包装为异步任务。限两段（B 不再链）。
 */
async function runChain(
	req: GenerateRequest,
	tplA: NonNullable<ReturnType<typeof getTemplateDef>>,
	model: ModelDef,
	up: Upstream,
	onDelta?: OnDelta,
	onUpstream?: OnUpstream,
): Promise<SyncOutcome> {
	// A 段为中间结果，不对外回传部分正文；B 段是最终输出，流式回传（上游记录以 B 段为准）
	const a = await runTextSync({ ...req, output: { format: "text" } }, model, up);
	if (a.status !== "success") return { status: "failed", error: a.error || "链式A段失败" };
	const outputA = a.result?.text ?? "";
	const pipeVar = tplA.chainPipeVar || "上一步";
	const reqB: GenerateRequest = {
		...req,
		templateId: tplA.chainNextId,
		variables: { ...(req.variables ?? {}), [pipeVar]: outputA },
		promptOverride: undefined,
	};
	return runTextSync(reqB, model, up, onDelta, onUpstream);
}

/**
 * 真异步文本任务：提交即返回 taskId，后台执行（含链式）→ 回填任务与日志。
 * 文本也走异步轮询，避免长输入(≤20w字)/长耗时被浏览器或代理的连接时限掐断。
 */
function createTextTask(req: GenerateRequest, run: (onDelta: OnDelta) => Promise<SyncOutcome>, logId?: string): DispatchResult {
	const rec = createRunningTask("text", req.clientTaskId, logId);
	const onDelta: OnDelta = (full) => appendTaskText(rec.taskId, full);
	run(onDelta)
		.then((r) => {
			if (r.status === "success") {
				completeTask(rec.taskId, r.result);
				if (logId) finishLog(logId, { status: "success", response: r.result, taskId: rec.taskId });
			} else {
				failTask(rec.taskId, r.error || "生成失败");
				if (logId) finishLog(logId, { status: "failed", error: r.error, taskId: rec.taskId });
			}
		})
		.catch((err) => {
			const msg = (err as Error).message;
			failTask(rec.taskId, msg);
			if (logId) finishLog(logId, { status: "failed", error: msg, taskId: rec.taskId });
		});
	return { kind: "async", taskId: rec.taskId };
}

export async function dispatchGenerate(
	req: GenerateRequest,
	logId?: string,
	opts?: { noChain?: boolean },
): Promise<DispatchResult> {
	const model = getModelDef(req.model);
	if (!model || !model.enabled) {
		const error = `模型不存在或已禁用：${req.model}`;
		if (logId) finishLog(logId, { status: "failed", error });
		return { kind: "sync", status: "failed", error };
	}
	const up = resolveUpstream(model, req);
	// 上游(管理端↔网关/第三方)请求/响应记录器：写入对应日志（③④）
	const onUpstream: OnUpstream | undefined = logId ? (rec) => attachUpstream(logId, rec) : undefined;

	// 自定义协议（翻译官招募市场）：模型 protocol 指向非内置协议 → 通用引擎按数据配置执行
	if (!isBuiltinProtocol(model.protocol)) {
		const proto = getProtocolDef(model.protocol);
		if (!proto || !proto.enabled) {
			const error = `协议不存在或已禁用：${model.protocol}`;
			if (logId) finishLog(logId, { status: "failed", error });
			return { kind: "sync", status: "failed", error };
		}
		switch (proto.mode) {
			case "sync":
				return createTextTask(req, (onDelta) => runCustomText(req, up, proto, onDelta, onUpstream), logId);
			case "async-immediate":
				return createImageTask(req, () => runCustomImmediate(req, up, proto, onUpstream), logId, proto.capability);
			case "async-poll":
				return createVideoPollingTask(req, up, proto.id, customVideoDriver(proto), logId, onUpstream, proto.capability,
					{ intervalMs: proto.poll?.intervalMs, timeoutMs: proto.poll?.timeoutMs });
		}
	}

	// 文本：一律异步任务 + 后台执行（含链式），客户端轮询取结果
	if (TEXT_PROTOCOLS.has(model.protocol)) {
		const tplA = !opts?.noChain && req.templateId ? getTemplateDef(req.templateId) : undefined;
		const runner = tplA?.chainNextId
			? (onDelta: OnDelta) => runChain(req, tplA, model, up, onDelta, onUpstream)
			: (onDelta: OnDelta) => runTextSync(req, model, up, onDelta, onUpstream);
		return createTextTask(req, runner, logId);
	}

	switch (model.protocol) {
		case "openai-image":
			return createImageTask(req, () => translateOpenAIImage(req, up, onUpstream), logId);
		case "gemini-image":
			return createImageTask(req, () => translateGeminiImage(req, up, onUpstream), logId);
		case "yali-image":
			// Yali（api.yaliai.com，第229轮）：同步单请求出图（OpenAI Images 形态，generations/edits 两路径）
			return createImageTask(req, () => translateYaliImage(req, up, onUpstream), logId);
		case "congge-image":
			// congge（congchen.top，第233轮）：同步单请求出图（generations 文生图 / edits 图生图，垫图≤4 张）
			return createImageTask(req, () => translateConggeImage(req, up, onUpstream), logId);
		case "jmh-image":
			// 简梦H（ZhengAPI，第154轮）：同步单请求出图（grok=images/generations、firefly=chat stream:false）
			return createImageTask(req, () => translateJmhImage(req, up, onUpstream), logId);
		case "jmh-video":
			// 简梦H 视频（第155轮）：chat/completions SSE 流式单请求（整流读完即有链接，1~10 分钟）——
			// 非 submit+poll，复用 createImageTask 管线按 video 能力落资产（下载成片字节→createAsset 永久 OSS）
			return createImageTask(req, () => translateJmhVideo(req, up, onUpstream), logId, "video");
		case "jianmeng-video":
		case "openai-video":
		case "sudashui-video":
		case "aistars-video":
		case "huaying-video":
		case "dimensio-video":
		case "aivide-video":
		case "jianmengp-video":
		case "musem-video":
		case "jmz-video":
		case "jmt-video":
		case "jmf-video":
		case "overseas-video":
		case "suanli-video":
		case "congge-video":
		case "autodl-video":
			return createVideoPollingTask(req, up, model.protocol, VIDEO_DRIVERS[model.protocol], logId, onUpstream,
				"video", { intervalMs: BUILTIN_POLL_INTERVALS[model.protocol] });
		case "jmz-image":
		case "aistars-image":
		case "skylee-image":
			// 简梦Z（第153轮）/ 星辰（第162轮）/ Skylee（第230轮）图片：上游本身异步 submit+poll → 复用视频轮询管线按 image 能力落资产
			//（jmz 的 poll 附 resultHeaders：结果链接须带 Bearer 下载、约 2h 失效——完成即取字节落永久资产）
			return createVideoPollingTask(req, up, model.protocol, VIDEO_DRIVERS[model.protocol], logId, onUpstream, "image");
		case "volc-mediakit":
			// 火山 MediaKit：图像增强走**同步接口**（无需轮询，复用图像任务管线落资产）；视频处理走轮询驱动
			return model.capability === "image-enhance"
				? createImageTask(req, () => translateVolcEnhanceImage(req, up, onUpstream), logId)
				: createVideoPollingTask(req, up, model.protocol, VIDEO_DRIVERS[model.protocol], logId, onUpstream);
		case "stub":
		default:
			return await createStubTask(req, model.capability, logId);
	}
}
