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
import { createTask, createRunningTask, completeTask, failTask, appendTaskText, setTaskProgress } from "../store/tasks.ts";
import { createAsset } from "../store/assets.ts";
import { finishLog, attachUpstream } from "../store/logs.ts";
import { resolveUpstream } from "./upstream.ts";
import { translateOpenAIText, translateOpenAIImage, translateEcho, type ImageResult, type OnDelta, type OnUpstream } from "./openai.ts";
import { translateAnthropicText } from "./anthropic.ts";
import { translateGeminiImage } from "./gemini.ts";
import { submitJianmengVideo, pollJianmengVideo } from "./jianmeng.ts";

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
	if (p === "video.generate") return "video";
	if (p === "audio.tts") return "audio";
	return "a";
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
 * 简梦视频：上游本身异步（submit→poll）。先回 taskId，后台提交+周期轮询上游(8s)，
 * completed 取 video_url 落任务（链接 6h 有效），failed/超时置失败。进度随上游推进。
 */
function createVideoPollingTask(req: GenerateRequest, up: Upstream, logId?: string, onUpstream?: OnUpstream): DispatchResult {
	const rec = createRunningTask("video", req.clientTaskId);
	(async () => {
		const sub = await submitJianmengVideo(req, up, onUpstream);
		if (!sub.ok) {
			failTask(rec.taskId, sub.error);
			if (logId) finishLog(logId, { status: "failed", error: sub.error, taskId: rec.taskId });
			return;
		}
		const deadline = Date.now() + 20 * 60 * 1000;
		while (Date.now() < deadline) {
			await sleep(8000);
			const st = await pollJianmengVideo(up, sub.taskId, onUpstream);
			if (st.status === "completed") {
				const result = {
					assets: [{ id: `jm-${sub.taskId}`, type: "video" as Capability, url: st.videoUrl, meta: { cover: st.coverUrl, model: req.model } }],
				};
				completeTask(rec.taskId, result);
				if (logId) finishLog(logId, { status: "success", response: result, taskId: rec.taskId });
				return;
			}
			if (st.status === "failed") {
				failTask(rec.taskId, st.error);
				if (logId) finishLog(logId, { status: "failed", error: st.error, taskId: rec.taskId });
				return;
			}
			setTaskProgress(rec.taskId, st.progress);
		}
		const to = "简梦视频生成超时（20 分钟）";
		failTask(rec.taskId, to);
		if (logId) finishLog(logId, { status: "failed", error: to, taskId: rec.taskId });
	})().catch((err) => {
		const m = (err as Error).message;
		failTask(rec.taskId, m);
		if (logId) finishLog(logId, { status: "failed", error: m, taskId: rec.taskId });
	});
	return { kind: "async", taskId: rec.taskId };
}

/** 真异步图像任务：先返回 taskId，后台调上游 → 落资产 → 回填任务与日志 */
function createImageTask(req: GenerateRequest, run: () => Promise<ImageResult>, logId?: string): DispatchResult {
	const rec = createRunningTask("image", req.clientTaskId);
	run()
		.then(async (r) => {
			if (!r.ok) {
				failTask(rec.taskId, r.error);
				if (logId) finishLog(logId, { status: "failed", error: r.error, taskId: rec.taskId });
				return;
			}
			const asset = await createAsset(r.data, r.contentType, "image", { prefix: assetPrefixFor(req), name: assetNameOf(req) });
			const result = { assets: [{ id: asset.id, type: "image" as Capability, url: asset.url, meta: { model: req.model } }] };
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
	const rec = createRunningTask("text", req.clientTaskId);
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
	const up = resolveUpstream(model);
	// 上游(管理端↔网关/第三方)请求/响应记录器：写入对应日志（③④）
	const onUpstream: OnUpstream | undefined = logId ? (rec) => attachUpstream(logId, rec) : undefined;

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
		case "jianmeng-video":
			return createVideoPollingTask(req, up, logId, onUpstream);
		case "stub":
		default:
			return await createStubTask(req, model.capability, logId);
	}
}
