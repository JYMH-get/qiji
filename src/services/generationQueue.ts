/**
 * generationQueue —— 生成的断连保护层（资产出图 + 分镜故事板/视频）。
 *
 * 问题：界面直接 `await runPurpose` 后写结果，绑定只活在组件闭包 + 内存轮询器里；
 * 切页/关软件即丢（管理端已完成、用户端没接到，且无 taskId 可找回）。
 *
 * 方案：把「在途生成」持久化到项目（projectStore.pendingGens，随项目落盘）：
 *  - 提交即登记 pending（含原始请求，供重试）+ 显示持久占位；
 *  - 提交确认拿到 taskId/adapterKey 立即落盘（找回的关键）；
 *  - 完成回调走**全局 store**（与当前在哪个页面无关）→ 落资产/分镜 + 清 pending；
 *  - 失败 → 标红保留，供「重试」按原请求重发；
 *  - App 启动 `resumePendingGenerations()`：对带 taskId 的 running 在途**重新挂轮询**
 *    （服务端 task 仍在即可接回，管理端常驻不重启）；没拿到 taskId 就断的 → 标失败可重试。
 *
 * 两类目标共用同一条 pending 管线，靠 PendingGen.shot 区分：
 *  - asset：写 projectStore.addAssetImage（cat/assetId/variantId）
 *  - shot ：写分镜 storyboardUri/videoUri + 历史（shot.episodeId/shotId/field）
 */
import type { Purpose } from "@/contract";
import { useProjectStore, type AssetCat } from "@/store/projectStore";
import type { PendingGen, RtcGenerationTarget } from "@/services/projectFile";
import { runPurpose } from "./purposeRunner";
import { trackTask } from "./taskCenter";
import { saveRemoteAsset, uploadBlobToOss } from "./assetPersist";
import { managedClient } from "./managedClient";
import type { TaskExtra } from "./adapters/types";
import { extractPromptText, buildLegend, withLegend } from "@/lib/shotMaterials";
import { resolvePresets } from "@/lib/presetSchemes";
import { rememberGenerationReceipt, readGenerationReceipt, forgetGenerationReceipt, type GenerationOwner } from "./generationReceipts";
import { isProjectWriter } from "./windowSync";
import { rtcPendingReady, deliverRtcPending, failRtcPending, pendingRtcTarget } from "./rtcGenerationDelivery";
import { forgetRtcGenerationResult, readRtcGenerationResult, rememberRtcGenerationResult } from "./rtcGenerationReceipts";

type QueueOwner = GenerationOwner & { active?: () => boolean };
const attempts = new Map<string, symbol>();
const currentProject = (owner: QueueOwner) => {
	const state = useProjectStore.getState();
	return state.projectInstanceId === owner.projectInstanceId && !state.isProjectLoading && owner.active?.() !== false;
};
const ownerOf = (state = useProjectStore.getState()): GenerationOwner => ({ projectInstanceId: state.projectInstanceId, savePath: state.savePath });
const claimRun = (id: string, state = useProjectStore.getState()): QueueOwner => {
	const key = JSON.stringify([state.savePath || state.projectInstanceId, id]), token = Symbol(id);
	attempts.set(key, token);
	return { ...ownerOf(state), active: () => attempts.get(key) === token };
};
type LiveRun = { owner: QueueOwner; pending: PendingGen; taskId?: string; adapterKey?: string };
// Same-process reopen keeps purposeRunner's terminal callback so its Promise/activity can finish.
// Only a restart (or an already finished/lost runner) needs a new taskCenter callback.
const liveRuns = new Set<LiveRun>();
function adoptLiveRun(run: LiveRun, pending: PendingGen, state = useProjectStore.getState()): boolean {
	if (state.isProjectLoading || run.owner.active?.() === false || run.pending.id !== pending.id || run.pending.createdAt !== pending.createdAt) return false;
	if (state.projectInstanceId !== run.owner.projectInstanceId && (!run.owner.savePath || state.savePath !== run.owner.savePath)) return false;
	if (pending.taskId && pending.taskId !== run.taskId) return false;
	run.owner.projectInstanceId = state.projectInstanceId;
	run.owner.savePath = state.savePath;
	state.updatePendingGen(pending.id, { status: "running", error: undefined, recoverable: false,
		...(run.taskId && run.adapterKey ? { taskId: run.taskId, adapterKey: run.adapterKey } : {}) });
	return true;
}
function resumeLiveRun(pending: PendingGen, state = useProjectStore.getState()): boolean {
	for (const run of liveRuns) if (adoptLiveRun(run, pending, state)) return true;
	return false;
}
async function saveGenerationCheckpoint(owner: QueueOwner, id: string): Promise<void> {
	await useProjectStore.getState().save(true);
	const state = useProjectStore.getState();
	// save 会捕获磁盘错误；非写者仅转发保存且可能清 dirty，均不是落盘确认。
	if (currentProject(owner) && isProjectWriter() && !state.isDirty && !state.pendingGens.some(x => x.id === id)) {
		forgetGenerationReceipt(owner, id);
		forgetRtcGenerationResult(owner, id);
	}
}

const isTauri = (): boolean =>
	typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export interface GenSpec {
	cat: AssetCat;
	assetId: string;
	variantId: string | null;
	purpose: Purpose;
	prompt: string;
	params?: Record<string, unknown>;
	/** 生效模型 key（来自界面模型选择器）；空=按设置默认解析 */
	modelKey?: string;
	/** 额外输入（图生图垫图 images:[{url}] 等） */
	input?: Record<string, unknown>;
	/** 垫图详情（可渲染预览 uri + 名称 + 资产 id）：供「详情」回看，完成后转存 genMeta */
	refs?: { name?: string; uri: string; id?: string }[];
	label: string;
}

/** 分镜故事板/视频/提示词推理目标 */
export interface ShotGenSpec {
	rtcTarget?: RtcGenerationTarget;
	episodeId: string;
	shotId: string;
	field: "storyboard" | "video" | "storyboardPrompt" | "videoPrompt";
	purpose: Purpose;
	prompt: string;
	/** 推理用模板变量（与 prompt 二选一，优先 variables） */
	variables?: Record<string, string>;
	/** 推理用 catalog 模板 id */
	templateId?: string;
	params?: Record<string, unknown>;
	modelKey?: string;
	input?: Record<string, unknown>;
	label: string;
}

let _seq = 0;
const uid = () => `gen-${Date.now()}-${++_seq}`;

// ── 在途进度（会话态）─────────────────────────────────────────────────────────
/**
 * ⚠ **绝不写进 PendingGen / InferTask**：那两个结构随项目文件落盘，而排队位次/百分比是瞬时信息
 * （落盘=项目文件里永远躺着一句「排队第 3 位」，重开还当真）。故单独放模块级 Map，重启即空。
 * 消费方（表格模式 jobChips / 推理按钮）用 useSyncExternalStore 订阅版本号后读 getJobProgress。
 * key = pendingGen.id（出图/视频）或 inferTask.id（推理/拆分）。
 */
export interface JobProgress {
	progress: number;
	/** 排队/阶段情报（服务端自有队列才有）——类型复用 adapters/types.TaskExtra，勿另立一份 */
	extra?: TaskExtra;
}

const jobProgress = new Map<string, JobProgress>();
const jobProgressListeners = new Set<() => void>();
let jobProgressVer = 0;

const sameExtra = (a?: TaskExtra, b?: TaskExtra): boolean =>
	(a?.queuePosition ?? -1) === (b?.queuePosition ?? -1)
	&& (a?.queueTotal ?? -1) === (b?.queueTotal ?? -1)
	&& (a?.stageText ?? "") === (b?.stageText ?? "");

function bumpJobProgress(): void {
	jobProgressVer++;
	for (const fn of jobProgressListeners) fn();
}

/** 订阅在途进度变化（配 useSyncExternalStore：快照=版本号，取值走 getJobProgress） */
export function subscribeJobProgress(fn: () => void): () => void {
	jobProgressListeners.add(fn);
	return () => { jobProgressListeners.delete(fn); };
}
export function jobProgressVersion(): number {
	return jobProgressVer;
}
export function getJobProgress(id: string): JobProgress | undefined {
	return jobProgress.get(id);
}
/** 记录一次进度（值无变化则不通知，避免轮询期无谓重渲染） */
export function setJobProgress(id: string, progress: number, extra?: TaskExtra): void {
	const p = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
	const cur = jobProgress.get(id);
	if (cur && cur.progress === p && sameExtra(cur.extra, extra)) return;
	jobProgress.set(id, { progress: p, extra });
	bumpJobProgress();
}
export function clearJobProgress(id: string): void {
	if (!jobProgress.delete(id)) return;
	bumpJobProgress();
}

/** 把成功结果落到分镜：媒体→主图/主视频+历史；文本→推理出的提示词+基线 */
function applyShotResult(target: NonNullable<PendingGen["shot"]>, uri: string): void {
	const st = useProjectStore.getState();
	const ep = st.episodes.find((e) => e.id === target.episodeId);
	const sh = ep?.shots.find((s) => s.id === target.shotId);
	if (!sh) return; // 分镜已删 → 丢弃
	if (target.field === "storyboardPrompt" || target.field === "videoPrompt") {
		// 文本推理：清洗 JSON 外壳 + 保留素材图例前缀（视频含全模态，故事板仅图像），同步写基线供高亮更改
		const isVideo = target.field === "videoPrompt";
		const text = withLegend(extractPromptText(uri), buildLegend(sh.materials, !isVideo));
		st.updateShot(target.episodeId, target.shotId, isVideo
			? { videoPrompt: text, videoPromptBase: text }
			: { storyboardPrompt: text, storyboardPromptBase: text });
	} else if (target.field === "storyboard") {
		if (!(sh.storyboardImages || []).includes(uri)) st.updateShot(target.episodeId, target.shotId, { storyboardUri: uri, storyboardImages: [...(sh.storyboardImages || []), uri] });
	} else {
		if (!(sh.videoUris || []).includes(uri)) st.updateShot(target.episodeId, target.shotId, { videoUri: uri, videoUris: [...(sh.videoUris || []), uri] });
	}
}
/** 该 shot 目标是否为文本推理（提示词），不走资产下载 */
function isPromptField(p: PendingGen): boolean {
	return p.shot?.field === "storyboardPrompt" || p.shot?.field === "videoPrompt";
}

/** 把结果落到媒体处理派生记录（视频超分/去字幕、故事板图像超分）：成功写 uri+清状态；失败标红（记录仍在，可重跑覆盖）。 */
function applyDerivedResult(target: NonNullable<PendingGen["derived"]>, ok: boolean, uri?: string, error?: string): void {
	const st = useProjectStore.getState();
	const ep = st.episodes.find((e) => e.id === target.episodeId);
	const sh = ep?.shots.find((s) => s.id === target.shotId);
	const field = target.field === "storyboard" ? "sbDerived" : "videoDerived";
	const list = sh?.[field];
	const rec = list?.find((d) => d.id === target.recId);
	if (!sh || !rec) return; // 记录已被删除/覆盖 → 丢弃结果
	const next = list!.map((d) =>
		d.id === target.recId
			? ok
				? { ...d, uri: uri || d.uri, status: undefined, error: undefined }
				: { ...d, status: "failed" as const, error: error || "处理失败" }
			: d,
	);
	st.updateShot(target.episodeId, target.shotId, { [field]: next });
}

/**
 * 结果落地：成功写资产/分镜 + 清 pending；失败标红保留。仅当该 pending 仍属当前项目时生效（防切项目串写）。
 * 成功时（Tauri）把原件下载到本地、登记三元映射（assetId/url/localPath），界面图改走本地 uri 秒级加载。
 */
/** 客户端补转存（rawLink）上传的资产 id 前缀：资产图按分类前缀（与服务端出图归档一致），视频走 video，其余 TP */
function uploadPrefixOf(p: PendingGen): string {
	if ((p.purpose || "").startsWith("video.")) return "video";
	const CAT_PREFIX: Record<string, string> = { characters: "C", crowds: "G", scenes: "S", organisms: "M", items: "P" };
	return (p.cat && CAT_PREFIX[p.cat]) || "TP";
}

const applyingResults = new Set<string>();
const applyKey = (owner: QueueOwner, id: string) => JSON.stringify([owner.projectInstanceId, id]);

async function applyResult(owner: QueueOwner, id: string, status: "success" | "failed", resultUri?: string, error?: string, assetId?: string, opts?: { recoverable?: boolean; rawLink?: boolean; saveToOss?: boolean }, hint?: PendingGen): Promise<void> {
	if (owner.active?.() === false) return;
	const currentPending = currentProject(owner) ? useProjectStore.getState().pendingGens.find(x => x.id === id) : undefined;
	const evidence = currentPending ?? hint;
	const target = evidence && (currentProject(owner) ? pendingRtcTarget(evidence) : evidence.rtcTarget);
	if (evidence && (target || evidence.derived || (evidence.shot && !isPromptField(evidence))) && status === "success" && resultUri) {
		const result = readRtcGenerationResult(owner, evidence)?.result ?? evidence.rtcResult ?? hint?.rtcResult ?? { uri: resultUri, assetId, taskId: evidence.taskId,
			media: evidence.derived?.field === "storyboard" || evidence.shot?.field === "storyboard" ? "image" as const : "video" as const,
			rawLink: opts?.rawLink, saveToOss: opts?.saveToOss };
		rememberRtcGenerationResult(owner, evidence, target, result);
	}
	const key = applyKey(owner, id);
	if (applyingResults.has(key)) return;
	applyingResults.add(key);
	try { await applyResultInner(owner, id, status, resultUri, error, assetId, opts); }
	catch (err) { console.warn("[generation] 结果待保存，保留任务凭据", err); }
	finally { applyingResults.delete(key); }
}

async function applyResultInner(owner: QueueOwner, id: string, status: "success" | "failed", resultUri?: string, error?: string, assetId?: string, opts?: { recoverable?: boolean; rawLink?: boolean; saveToOss?: boolean }): Promise<void> {
	if (!currentProject(owner)) return;
	clearJobProgress(id); // 已终态，进度/排队位次作废（重试/重连会重新登记）
	const st = useProjectStore.getState();
	let p = st.pendingGens.find((x) => x.id === id);
	if (!p) return; // 已切换项目/已被清除 → 丢弃（原项目重开时会续跑）
	const taskId = p.taskId, createdAt = p.createdAt;
	const current = () => currentProject(owner) && useProjectStore.getState().pendingGens.some(x => x.id === id && x.createdAt === createdAt && x.taskId === taskId);
	const receipt = readRtcGenerationResult(owner, p);
	if (receipt && status === "success") {
		p = { ...p, rtcTarget: receipt.target ?? p.rtcTarget, rtcResult: receipt.result };
		st.updatePendingGen(id, { rtcTarget: p.rtcTarget, rtcResult: receipt.result });
		// 原始产物先有持久凭据再开始下载/探时长；保存失败仍保留独立副本与 pending。
		await st.save(true);
		if (!current()) return;
	}
	if (status === "success" && resultUri) {
		// 文本推理结果（提示词）：直接写分镜，不下载、不当资产
		if (p.shot && isPromptField(p)) {
			applyShotResult(p.shot, resultUri);
			useProjectStore.getState().removePendingGen(id);
			await saveGenerationCheckpoint(owner, id);
			return;
		}
		// 本地落盘 + 三元映射；失败/非 Tauri 退回直接用 url
		let displayUri = p.rtcResult?.displayUri || resultUri;
		let displayAssetId = p.rtcResult?.assetId || assetId;
		try { if (!p.rtcResult?.displayUri) {
			// rawLink（第158轮）：服务端未转存（meta.rehosted=false，resultUri=上游原始时效直链，
			// 多为服务器到成片托管域网络不通）→ 客户端用本机网络快重试下载（图 3×30s / 视频 2×120s）
			const dl = opts?.rawLink
				? ((p.purpose || "").startsWith("video.") ? { attempts: 2, timeoutSecs: 120 } : { attempts: 3, timeoutSecs: 30 })
				: undefined;
			let blob = await saveRemoteAsset(assetId || `local-${id}`, resultUri, { ...dl, keepRemoteUrl: opts?.saveToOss !== false, shouldContinue: current });
			if (!current()) return;
			// 下载成功 → 把本地字节经上传接口传回服务端落 OSS，三元映射换成永久直链（原始直链会过期）；
			// 带 taskId=顺带改写服务端任务响应体（rehosted→true，断连找回不再重复接力转存）
			if (blob && opts?.rawLink && opts?.saveToOss !== false) blob = await uploadBlobToOss(blob, p.label, uploadPrefixOf(p), p.taskId, { shouldContinue: current });
			if (!current()) return;
			// 兜底：直链未能落本地（如上游直链被 CORS/网络拦、服务端未转存 OSS）→
			// 请管理端把该直链转存到 OSS，再从 OSS（同 S3、CORS 友好）下载到本地。
			if (opts?.saveToOss !== false && !blob && isTauri() && /^https?:\/\//i.test(resultUri)) {
				const re = await managedClient.rehost(resultUri, undefined, p.label);
				if (!current()) return;
				if (re?.url) blob = await saveRemoteAsset(re.id, re.url, { shouldContinue: current });
			}
			if (!current()) return;
			if (blob) {
				st.registerAssetBlob(blob);
				displayUri = blob.localUri || resultUri;
				displayAssetId = blob.id;
			}
		} } catch { /* 落盘失败：用 url 兜底 */ }
		// 重新取最新状态（落盘是异步，期间可能变化）
		if (!current()) return;
		if (p.derived) applyDerivedResult(p.derived, true, displayUri);
		else if (p.shot) applyShotResult(p.shot, displayUri);
		else {
			// 资产图：记录本次请求详情（出图提示词 + 垫图），按结果图 uri 存，供展示区「详情」回看
			useProjectStore.getState().addGenMeta(displayUri, { prompt: p.prompt, refs: p.refsMeta || [], at: Date.now() });
			useProjectStore.getState().addAssetImage(p.cat as AssetCat, p.assetId as string, p.variantId ?? null, displayUri, true);
		}
		if (p.rtcResult) {
			const rtcTarget = p.rtcTarget;
			p = { ...p, rtcResult: { ...p.rtcResult, displayUri, assetId: displayAssetId } };
			rememberRtcGenerationResult(owner, p, rtcTarget, p.rtcResult!);
			useProjectStore.getState().updatePendingGen(id, { rtcResult: p.rtcResult });
			if (!(await deliverRtcPending(owner, p, current))) return;
		}
		if (!current()) return;
		useProjectStore.getState().removePendingGen(id);
	} else if (p.derived) {
		// 派生记录（超分/去字幕）失败：失败态标在记录本身（chip 变红），pending 直接清
		//（重试=菜单里重新处理一次，同标号覆盖；不走 pending 的重试/重连 UI）
		applyDerivedResult(p.derived, false, undefined, error);
		await failRtcPending(owner, p, error || "处理失败");
		if (!current()) return;
		useProjectStore.getState().removePendingGen(id);
	} else {
		// recoverable（服务端丢任务的 lost 态）：标失败但带可重连标记，保留 taskId 供「重连原任务」
		st.updatePendingGen(id, { status: "failed", error: error || "生成失败", recoverable: opts?.recoverable || false });
		await failRtcPending(owner, p, error || "生成失败");
	}
	// 成功写回前始终保留 pending / taskId；存盘后才能清独立受理凭据。
	await saveGenerationCheckpoint(owner, id);
}

/** 按 pending 记录发起一次 runPurpose（start/retry/分镜共用），结果统一落 applyResult。 */
function runFromPending(id: string): void {
	const owner = claimRun(id);
	const p = useProjectStore.getState().pendingGens.find((x) => x.id === id);
	if (!p) return;
	const live: LiveRun = { owner, pending: p };
	liveRuns.add(live);
	const finishLiveRun = () => {
		liveRuns.delete(live);
		const pending = useProjectStore.getState().pendingGens.find(x => x.id === id);
		if (pending) adoptLiveRun(live, pending);
	};
	const visualStyle = useProjectStore.getState().visualStyle || "";
	const common = {
		params: p.params,
		modelKey: p.modelKey || undefined,
		input: p.input,
		templateId: p.templateId || undefined,
		onTaskId: (taskId: string, adapterKey: string) => {
			live.taskId = taskId;
			live.adapterKey = adapterKey;
			if (owner.active?.() === false) return;
			if (currentProject(owner)) owner.savePath = useProjectStore.getState().savePath;
			rememberGenerationReceipt(owner, p, taskId, adapterKey);
			if (!currentProject(owner)) {
				const pending = useProjectStore.getState().pendingGens.find(x => x.id === id);
				if (!pending || !adoptLiveRun(live, pending)) return;
			}
			useProjectStore.getState().updatePendingGen(id, { taskId, adapterKey, status: "running", error: undefined });
			void useProjectStore.getState().save(true);
		},
		// 进度/排队位次（第251轮）：只进会话态 Map，不落 PendingGen（瞬时信息勿随项目落盘）
		onProgress: (progress: number, _status: string, _partial?: string, extra?: TaskExtra) => { if (currentProject(owner)) setJobProgress(id, progress, extra); },
	};
	// 推理（带 variables）走存盘的变量；分镜出图走自由 prompt+视觉风格；资产走自由 prompt。
	// 第174轮：提交前把提示词里的预设胶囊【预设:id】展开成正文（资产拆分自动挂的 画风前缀/类别前后缀、
	// 用户手插的预设都在此收口；无胶囊的文本原样零开销）。
	const run = (p.shot && p.variables)
		? runPurpose(p.purpose as Purpose, { ...common, variables: p.variables })
		: p.shot
			? runPurpose(p.purpose as Purpose, { ...common, variables: { prompt: resolvePresets(p.prompt), 视觉风格: visualStyle } })
			: runPurpose(p.purpose as Purpose, { ...common, prompt: resolvePresets(p.prompt) });
	run
		.then((r) => {
			finishLiveRun();
			if (r.status === "success") void applyResult(owner, id, "success", r.resultUri, undefined, r.assetId, { rawLink: r.rawLink, saveToOss: r.saveToOss }, { ...p, taskId: live.taskId, adapterKey: live.adapterKey });
			else if (r.status === "no_model") void applyResult(owner, id, "failed", undefined, "无可用模型：请检查「设置 → 管理端」连接与目录拉取后重试。");
			// 服务端丢任务（lost）→ 可重连找回（前提是已拿到 taskId）
			else void applyResult(owner, id, "failed", undefined, r.error, undefined, { recoverable: !!r.lost });
		})
		.catch((err) => {
			finishLiveRun();
			void applyResult(owner, id, "failed", undefined, err instanceof Error ? err.message : "生成失败");
		});
}

function startPendingRun(pending: PendingGen): void {
	if (!pending.rtcTarget) { runFromPending(pending.id); return; }
	const owner = claimRun(pending.id);
	void (async () => {
		const bound = await rtcPendingReady(pending, owner, true);
		if (!currentProject(owner)) return;
		if (!bound) { useProjectStore.getState().removePendingGen(pending.id); await saveGenerationCheckpoint(owner, pending.id); return; }
		await useProjectStore.getState().save(true);
		if (!currentProject(owner) || !useProjectStore.getState().pendingGens.some(p => p.id === pending.id)) return;
		const ready = await rtcPendingReady(pending, owner);
		if (!currentProject(owner)) return;
		if (!ready) { useProjectStore.getState().removePendingGen(pending.id); await saveGenerationCheckpoint(owner, pending.id); return; }
		runFromPending(pending.id);
	})().catch(error => console.warn("[rtc] 提交准备未完成，保留任务记录", error));
}

/** 提交一次资产出图（异步，不阻塞调用方）；UI 由 pendingGens 持久占位驱动。 */
export function startGeneration(spec: GenSpec): void {
	const id = uid();
	const pending: PendingGen = {
		id,
		cat: spec.cat,
		assetId: spec.assetId,
		variantId: spec.variantId,
		purpose: spec.purpose,
		prompt: spec.prompt,
		params: spec.params,
		modelKey: spec.modelKey,
		input: spec.input,
		refsMeta: spec.refs,
		label: spec.label,
		status: "running",
		createdAt: Date.now(),
	};
	useProjectStore.getState().addPendingGen(pending);
	void useProjectStore.getState().save(true);
	runFromPending(id);
}

/** 提交一次分镜故事板/视频生成（异步，持久化在途，切页/重启可找回）。 */
export function startShotGeneration(spec: ShotGenSpec): string {
	const id = uid();
	const pending: PendingGen = {
		id,
		shot: { episodeId: spec.episodeId, shotId: spec.shotId, field: spec.field },
		rtcTarget: spec.rtcTarget,
		purpose: spec.purpose,
		prompt: spec.prompt,
		variables: spec.variables,
		templateId: spec.templateId,
		params: spec.params,
		modelKey: spec.modelKey,
		input: spec.input,
		label: spec.label,
		status: "running",
		createdAt: Date.now(),
	};
	useProjectStore.getState().addPendingGen(pending);
	void useProjectStore.getState().save(true);
	startPendingRun(pending);
	return id;
}

/** 媒体处理派生目标（视频超分/去字幕、故事板图像超分，火山 MediaKit）：结果写回 shot.videoDerived / sbDerived[recId] */
export interface DerivedGenSpec {
	rtcTarget?: RtcGenerationTarget;
	episodeId: string;
	shotId: string;
	recId: string;
	/** 记录归属：video（默认，视频区）/ storyboard（故事板区，图像超分） */
	field?: "video" | "storyboard";
	purpose: Purpose; // video.upscale | video.desub | image.upscale
	params?: Record<string, unknown>;
	modelKey: string;
	/** 源素材引用：inputs.videos / inputs.images = [{id?, url, name?}]（url 须公网可达） */
	input: Record<string, unknown>;
	label: string;
}

/** 提交一次媒体处理（超分/去字幕；异步，持久化在途，切页/重启可找回）。 */
export function startDerivedGeneration(spec: DerivedGenSpec): string {
	const id = uid();
	const pending: PendingGen = {
		id,
		derived: { episodeId: spec.episodeId, shotId: spec.shotId, recId: spec.recId, field: spec.field },
		rtcTarget: spec.rtcTarget,
		purpose: spec.purpose,
		prompt: "",
		params: spec.params,
		modelKey: spec.modelKey,
		input: spec.input,
		label: spec.label,
		status: "running",
		createdAt: Date.now(),
	};
	useProjectStore.getState().addPendingGen(pending);
	void useProjectStore.getState().save(true);
	startPendingRun(pending);
	return id;
}

/** 重试：按原始请求**重新生成**（复用同一条 pending；丢弃旧 taskId，会再次扣费） */
export function retryGeneration(id: string): void {
	const st = useProjectStore.getState();
	const p = st.pendingGens.find((x) => x.id === id);
	if (!p) return;
	forgetGenerationReceipt(ownerOf(st), id);
	forgetRtcGenerationResult(ownerOf(st), id);
	st.updatePendingGen(id, { status: "running", error: undefined, recoverable: false, taskId: undefined, adapterKey: undefined, rtcResult: undefined });
	void st.save(true);
	startPendingRun({ ...p, taskId: undefined, adapterKey: undefined, rtcResult: undefined });
}

/**
 * 重连原任务：凭原 taskId 重新挂轮询找回结果（**不重新生成、不再扣费**）。
 * 用于服务端临时异常/重启后：若服务端任务仍在 → 接回结果；若确实已丢 → 再次 lost、仍可重连或改重新生成。
 * 没有 taskId（提交未确认就断）则无从找回，回退为重新生成。
 */
export function recallPendingGeneration(id: string): void {
	const st = useProjectStore.getState();
	let p = st.pendingGens.find((x) => x.id === id);
	if (!p) return;
	const rtcTarget = pendingRtcTarget(p);
	if (!p.rtcTarget && rtcTarget) { p = { ...p, rtcTarget }; st.updatePendingGen(id, { rtcTarget }); }
	if (replayRtcCompletion(p)) return;
	if (resumeLiveRun(p, st)) { void st.save(true); return; }
	if (!p.taskId || !p.adapterKey) { retryGeneration(id); return; }
	const owner = claimRun(id, st);
	st.updatePendingGen(id, { status: "running", error: undefined, recoverable: false });
	void st.save(true);
	trackTask({
		taskId: p.taskId,
		adapterKey: p.adapterKey,
		onUpdate: (progress, status, resultUri, error, assetId, _partial, rawLink, extra) => {
			if (status === "success") { void applyResult(owner, p.id, "success", resultUri, undefined, assetId, { rawLink, saveToOss: extra?.saveToOss }, p); return; }
			if (!currentProject(owner)) return;
			// 重连找回同样喂进度/排队位次（重连回来的单可能仍在服务端队列里）
			if (status === "queued" || status === "running") setJobProgress(p.id, progress, extra);
			if (status === "failed") void applyResult(owner, p.id, "failed", undefined, error);
			else if (status === "lost") void applyResult(owner, p.id, "failed", undefined, error || "服务端异常：仍未找到原任务", undefined, { recoverable: true });
		},
	});
}

/** 已拿到终态时只重放该单产物，不重新挂轮询，更不重新付费提交。 */
function replayRtcCompletion(pending: PendingGen): boolean {
	const state = useProjectStore.getState(), baseOwner = ownerOf(state);
	const stored = readRtcGenerationResult(baseOwner, pending);
	const result = stored?.result ?? pending.rtcResult;
	const target = pending.rtcTarget ?? stored?.target;
	if (!result || (!target && !pending.derived && (!pending.shot || isPromptField(pending)))) return false;
	if (applyingResults.has(applyKey(baseOwner, pending.id))) return true;
	const owner = claimRun(pending.id, state);
	const p = { ...pending, rtcTarget: target, rtcResult: result };
	void applyResult(owner, p.id, "success", result.uri, undefined, result.assetId, { rawLink: result.rawLink, saveToOss: result.saveToOss }, p);
	return true;
}

export function resumeRtcPendingResults(): void {
	const state = useProjectStore.getState();
	if (state.isProjectLoading) return;
	for (const pending of state.pendingGens) replayRtcCompletion(pending);
}

/** App 启动调用：把上次未完成的在途任务接回来。 */
export function resumePendingGenerations(): void {
	const st = useProjectStore.getState();
	for (let p of st.pendingGens) {
		const rtcTarget = pendingRtcTarget(p);
		if (!p.rtcTarget && rtcTarget) { p = { ...p, rtcTarget }; st.updatePendingGen(p.id, { rtcTarget }); }
		if (replayRtcCompletion(p)) continue;
		if (resumeLiveRun(p, st)) continue;
		const owner = ownerOf(st) as QueueOwner;
		const receipt = readGenerationReceipt(owner, p);
		if (receipt && !p.taskId) {
			st.updatePendingGen(p.id, { taskId: receipt.taskId, adapterKey: receipt.adapterKey, status: "running", error: undefined });
			p = { ...p, taskId: receipt.taskId, adapterKey: receipt.adapterKey, status: "running" };
		}
		if (p.status !== "running") continue;
		if (p.taskId && p.adapterKey) {
			Object.assign(owner, claimRun(p.id, st));
			// 服务端 task 仍在（管理端常驻）→ 重新挂轮询，结果照常落地
			trackTask({
				taskId: p.taskId,
				adapterKey: p.adapterKey,
				onUpdate: (progress, status, resultUri, error, assetId, _partial, rawLink, extra) => {
					if (status === "success") { void applyResult(owner, p.id, "success", resultUri, undefined, assetId, { rawLink, saveToOss: extra?.saveToOss }, p); return; }
					if (!currentProject(owner)) return;
					// 重挂轮询的在途单同样喂进度/排队位次（重启后接回的单可能仍在服务端队列里）
					if (status === "queued" || status === "running") setJobProgress(p.id, progress, extra);
					if (status === "failed") void applyResult(owner, p.id, "failed", undefined, error);
					// 服务端重启丢任务 → 标可重连，UI 提示「服务端异常」+「重连原任务」
					else if (status === "lost") void applyResult(owner, p.id, "failed", undefined, error || "服务端异常：未找到原任务", undefined, { recoverable: true });
				},
			});
		} else {
			// 提交未确认就断了 → 无法恢复，标失败可重试
			st.updatePendingGen(p.id, { status: "failed", error: "上次未完成（提交未确认），可重试" });
		}
	}
	void st.save(true);
	// 项目可在资产/画布页打开；自由占位的续接不能依赖 RTC 页面挂载。
	if (Object.keys(st.rtcDocs ?? {}).length) {
		const owner = ownerOf(st);
		void import("@/rtc/panel/freeGenActions").then(({ resumeFreeGens }) => { if (currentProject(owner)) resumeFreeGens(); });
	}
}
