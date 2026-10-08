/**
 * rtcGenSink —— 实时剪辑「结果占位」的**唯一落笔路径**（一切生成链路的结果都从这里写进 doc）。
 *
 * 谁在用：
 *   - [placeholderSwap](./placeholderSwap.ts)：分镜出片 / 超分 / 去字幕（走 generationQueue 的
 *     在途台账 pendingGens）的状态镜像与终态落笔；
 *   - [freeGenActions](./freeGenActions.ts)：自由占位（无 shotRef，走 runPurpose 直连）的
 *     提交 / 进度 / 终态。
 * 收成一条路径的原因：项目身份守卫、"只认还是占位的片段"、撤销栈分工、资产落地（下载+转存+
 * 三元映射）这四件事只该有一份实现。
 *
 * ⚠ 撤销栈分工（勿混用，见 rtcStore.patchSilent 注释）：
 *   - `armRunning` / `markFailed` / `landMedia` = 用户动作与终态 → `commit`（进撤销栈）；
 *   - `mirrorProgress` / `mirrorStatus` = 机器产生的在途帧 → `patchSilent`（不进撤销栈）。
 *
 * ⚠ 项目身份守卫（照抄 placeholderSwap 范式）：所有异步落笔在写之前比对 projectInstanceId——
 *   复制/导入的项目会撞 segId，切了项目就绝不能把上一个项目的结果写进来。
 *   （rtcStore 内部还有一层同款守卫，这里是"发起时的项目"这一层，两层互补。）
 */
import { useProjectStore, resolveEpisodeKey } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import type { AssetBlob, RtcGenerationTarget } from "@/services/projectFile";
import type { TaskExtra } from "@/services/adapters/types";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
import { resizeGeneratedVideo } from "@/lib/rtcGenerationResize";
import { useRtcQueueStore } from "./rtcQueueStore";
import {
	clampProgress,
	failedPatch,
	mediaPatch,
	runningPatch,
	segPatchIsNoop,
	shouldWriteProgress,
	sourceWindowFor,
	type SegPatch,
} from "./rtcGenCore";

/* ────────────────────────── 项目身份 ────────────────────────── */

/** 当前项目身份（发起生成时记一份，落笔前比对） */
export function currentOwner(): string {
	return useProjectStore.getState().projectInstanceId;
}

/** 身份仍一致？（切项目=作废本次落笔） */
export function ownerAlive(owner: string): boolean {
	const state = useProjectStore.getState();
	return state.projectInstanceId === owner && !state.isProjectLoading;
}

/* ────────────────────────── doc 写入原语 ────────────────────────── */

/**
 * 对片段应用补丁（内联不可变更新）。
 * `placeholderOnly` = 只对仍是 placeholder 的片段生效（终态落笔用——用户可能已经把它删了、
 * 拖了别的素材替换掉，绝不抢别人的片段）。补丁什么都不改时返回原 doc 引用（no-op）。
 */
export type RtcSinkGuard = { target?: RtcGenerationTarget; expectedTaskRef?: string; shouldContinue?: () => boolean };

interface GenerationTiming { durationUs: number; warning?: string }

function patchDoc(doc: RtcDoc, segId: string, patch: SegPatch, placeholderOnly: boolean, guard?: RtcSinkGuard, timing?: GenerationTiming): RtcDoc {
	if (guard?.target?.subDocId) {
		const id = guard.target.subDocId, sub = doc.subDocs?.[id];
		if (!sub) return doc;
		const view = { ...doc, tracks: sub.tracks, markers: undefined };
		const next = patchDoc(view, segId, patch, placeholderOnly, { ...guard, target: undefined }, timing);
		return next === view ? doc : { ...doc, subDocs: { ...doc.subDocs, [id]: { ...sub, tracks: next.tracks } } };
	}
	if (timing) {
		const seg = findSegIn(doc, segId);
		if (!seg || (placeholderOnly && seg.kind !== "placeholder") || (guard?.expectedTaskRef && seg.taskRef !== guard.expectedTaskRef)) return doc;
		const adjusted = resizeGeneratedVideo(doc, segId, timing.durationUs);
		doc = adjusted.doc;
		timing.warning = adjusted.reason;
	}
	let hit = false;
	const tracks = doc.tracks.map((t) => {
		const idx = t.segments.findIndex((s) => s.id === segId);
		if (idx < 0) return t;
		const seg = t.segments[idx];
		if (guard?.expectedTaskRef && seg.taskRef !== guard.expectedTaskRef) return t;
		if (placeholderOnly && seg.kind !== "placeholder") return t;
		if (segPatchIsNoop(seg, patch)) return t;
		hit = true;
		const segments = [...t.segments];
		segments[idx] = { ...seg, ...patch } as RtcSegment;
		return { ...t, segments };
	});
	return hit ? { ...doc, tracks } : doc;
}

/** 按明确的根层/子层地址找片段。 */
function findSegIn(doc: RtcDoc | null, segId: string, subDocId?: string): RtcSegment | null {
	if (!doc) return null;
	for (const t of (subDocId ? doc.subDocs?.[subDocId]?.tracks ?? [] : doc.tracks)) {
		const s = t.segments.find((x) => x.id === segId);
		if (s) return s;
	}
	return null;
}

/**
 * 分集化补写（⚠ 勿删）：片段不在激活分集的工作副本里 → 逐个**非激活分集档位**找，命中就直接
 * 写档位（setRtcEpisodeDoc）。用户「在 A 集提交生成 → 切到 B 集 → A 集结果回来」的落笔全靠这条：
 * 非激活档位没有 undo 栈（切分集即清栈），直写安全、不区分 commit/silent。
 */
function projectRtcDocs(): Record<string, RtcDoc> {
	const ps = useProjectStore.getState(), rs = useRtcStore.getState();
	const docs = { ...ps.rtcDocs };
	if (rs.doc && rs.ownerProjectId === ps.projectInstanceId) {
		const key = rs.ownerEpisodeKey || resolveEpisodeKey(ps.rtcEpisodeId, ps.episodes);
		if (key) docs[key] = rs.doc;
	}
	return docs;
}

/** 全项目所有时间轴；当前合法工作副本覆盖其分集档位，子层地址明确分开。 */
export function rtcSegments(): Array<{ target: RtcGenerationTarget; seg: RtcSegment }> {
	const out: Array<{ target: RtcGenerationTarget; seg: RtcSegment }> = [];
	for (const [episodeId, doc] of Object.entries(projectRtcDocs())) {
		for (const track of doc.tracks) for (const seg of track.segments) out.push({ target: { episodeId, segId: seg.id }, seg });
		for (const [subDocId, sub] of Object.entries(doc.subDocs ?? {})) {
			for (const track of sub.tracks) for (const seg of track.segments) out.push({ target: { episodeId, segId: seg.id, subDocId }, seg });
		}
	}
	return out;
}

export function resolveRtcTarget(segId: string): RtcGenerationTarget | null {
	const hits = rtcSegments().filter(x => x.seg.id === segId);
	return hits.length === 1 ? hits[0].target : null;
}

/** 走 commit（进撤销栈）写占位补丁；owner 不匹配/片段已删/已非占位 → 静默 no-op */
function commitPatch(segId: string, patch: SegPatch, owner?: string, guard?: RtcSinkGuard, silent = false, timing?: GenerationTiming): boolean {
	if ((owner && !ownerAlive(owner)) || guard?.shouldContinue?.() === false) return false;
	const target = guard?.target ?? resolveRtcTarget(segId);
	if (!target || target.segId !== segId) return false;
	const ps = useProjectStore.getState(), rs = useRtcStore.getState();
	const doc = projectRtcDocs()[target.episodeId];
	if (!doc) return false;
	const next = patchDoc(doc, segId, patch, true, { ...guard, target }, timing);
	if (next === doc) return false;
	if (rs.doc === doc && rs.ownerProjectId === ps.projectInstanceId && rs.ownerEpisodeKey === target.episodeId) {
		(silent ? rs.patchSilent : rs.commit)((current) => patchDoc(current, segId, patch, true, { ...guard, target }, timing));
	} else ps.setRtcEpisodeDoc(target.episodeId, next);
	return true;
}

/** 走 patchSilent（不进撤销栈）写占位补丁——高频在途帧专用 */
function silentPatch(segId: string, patch: SegPatch, owner?: string, guard?: RtcSinkGuard): void {
	commitPatch(segId, patch, owner, guard, true);
}

/** 现查片段（不订阅；调用方判断"还在不在、还是不是占位"）。
 *  分集化：激活分集的工作副本优先，找不到再查非激活分集档位（跨集落笔判定用）。 */
export function liveSegment(segId: string, target?: RtcGenerationTarget): RtcSegment | null {
	const address = target ?? resolveRtcTarget(segId);
	return address && address.segId === segId ? findSegIn(projectRtcDocs()[address.episodeId] ?? null, segId, address.subDocId) : null;
}

/* ────────────────────────── 对外动作 ────────────────────────── */

function canWrite(segId: string, owner?: string, guard?: RtcSinkGuard): boolean {
	if ((owner && !ownerAlive(owner)) || guard?.shouldContinue?.() === false) return false;
	const seg = liveSegment(segId, guard?.target);
	return !!seg && seg.kind === "placeholder" && (!guard?.expectedTaskRef || seg.taskRef === guard.expectedTaskRef);
}

/**
 * 提交生成 → 占位转「生成中」并记下 taskRef（用户动作，进撤销栈）。
 * taskRef 语义见 [rtcGenCore.parseTaskRef]（pending 台账 id 或 `adapterKey|taskId`）。
 */
export function armRunning(segId: string, taskRef?: string, owner?: string, guard?: RtcSinkGuard): void {
	if (!canWrite(segId, owner, guard)) return;
	useRtcQueueStore.getState().setInfo(segId, null); // 清掉上一轮的排队信息（新任务从零起算）
	const staleResult = taskRef && liveSegment(segId, guard?.target)?.taskRef !== taskRef;
	commitPatch(segId, { ...runningPatch(taskRef ? { taskRef } : undefined), ...(staleResult ? { rtcResult: undefined } : {}) }, owner, guard);
}

/** 在途状态镜像（台账说它还在跑/已失败）——不进撤销栈 */
export function mirrorStatus(segId: string, patch: SegPatch, owner?: string, guard?: RtcSinkGuard): void {
	silentPatch(segId, patch, owner, guard);
}

/** segId → 上次写进度的时间与值（节流基准；纯内存，重开后由首帧重新起算） */
const progressMark = new Map<string, { at: number; val: number }>();

/**
 * 进度回填（不进撤销栈 + 节流）：变化 <2% 且距上次 <500ms 的帧直接丢弃，
 * 不惊动 doc 回写 / 去抖落盘 / React 渲染。
 *
 * `extra`（排队位次/阶段文案，第251轮）走 [rtcQueueStore](./rtcQueueStore.ts) **只进内存不落盘**——
 * 它每轮轮询都在变、且重开客户端后由首帧重新给出，写进片段只会白白惊动落盘链；
 * ⚠ 且它**不受进度节流约束**（0% 排队期间进度恒定不动，位次却在往前走，节流会把它全丢掉）。
 */
export function mirrorProgress(segId: string, progress: number, owner?: string, extra?: TaskExtra, guard?: RtcSinkGuard): void {
	if (!canWrite(segId, owner, guard)) return;
	useRtcQueueStore.getState().setInfo(segId, extra ?? null);
	const now = Date.now();
	const mark = progressMark.get(segId);
	const val = clampProgress(progress);
	if (!shouldWriteProgress(mark?.val, val, mark?.at ?? 0, now)) return;
	progressMark.set(segId, { at: now, val });
	silentPatch(segId, { status: "running", progress: val, error: undefined }, owner, guard);
}

/** 生成失败（终态，进撤销栈）：片段**保留不删**，用户能看到失败原因并重试 */
export function markFailed(segId: string, error: string, owner?: string, guard?: RtcSinkGuard): void {
	if (!canWrite(segId, owner, guard)) return;
	progressMark.delete(segId);
	useRtcQueueStore.getState().setInfo(segId, null);
	commitPatch(segId, failedPatch(error), owner, guard);
}

/**
 * 占位 → 结果（终态，进撤销栈）：更新媒体与 source 窗口，清空占位态字段。
 * 新生成视频可按真实时长调时：缩短留空隙，增长推开后续；与媒体落位合为一次撤销。
 * 派生处理显式 sourceWindow 保持原裁剪窗口与 target 时间窗。
 * 片段已被删 / 已不是占位 → 静默 no-op。
 */
export function landMedia(
	segId: string,
	args: RtcSinkGuard & {
		media: NonNullable<RtcSegment["media"]>;
		uri: string;
		assetId?: string;
		/** 产物真实时长（秒）；缺省/0=不建 source 窗口。新生成的素材用这个 */
		durationSec?: number;
		/** 仅新生成视频启用；未知时长/派生显式 sourceWindow 不调时。 */
		resizeToDuration?: boolean;
		/** 锁轨或组合冲突时媒体仍落位，由交付层解释未能调时的原因。 */
		onResizeWarning?: (reason: string) => void;
		/** 显式指定 source 窗口（优先于 durationSec）——超分/去字幕沿用源片段窗口时用 */
		sourceWindow?: { sourceStartUs: number; sourceDurationUs: number } | null;
		owner?: string;
	},
): boolean {
	if (!canWrite(segId, args.owner, args)) return false;
	progressMark.delete(segId);
	useRtcQueueStore.getState().setInfo(segId, null);
	const source =
		args.sourceWindow !== undefined ? args.sourceWindow : sourceWindowFor(args.media, args.durationSec ?? 0);
	const timing: GenerationTiming | undefined = args.resizeToDuration && args.media === "video" && args.sourceWindow === undefined
		&& Number.isFinite(args.durationSec) && (args.durationSec ?? 0) > 0
		? { durationUs: Math.round(args.durationSec! * 1_000_000) } : undefined;
	const written = commitPatch(segId, {
		...mediaPatch(args.media, args.uri, args.assetId, source),
		...(timing ? { speed: undefined } : {}),
		rtcResult: undefined,
		...(args.expectedTaskRef ? { resultTaskRef: args.expectedTaskRef } : {}),
	}, args.owner, args, false, timing);
	if (written && timing?.warning) args.onResizeWarning?.(timing.warning);
	return written;
}

/* ────────────────────────── 生成结果 → 本地资产 ────────────────────────── */

/**
 * 把生成结果落成本地资产并登记三元映射（assetId ↔ 公网url ↔ 本地路径），返回展示用 uri。
 * **与 [generationQueue.applyResult](@/services/generationQueue) 逐步同语义**（那条路服务分镜/资产
 * 目标，这里服务"结果直接落在时间轴片段"的自由占位——两处都只是同一套资产落地动作的调用方）：
 *   ① saveRemoteAsset 下载到本机（rawLink=服务端未转存的上游时效直链 → 加重试）；
 *   ② rawLink 成功 → uploadBlobToOss 传回服务端落 OSS（原始直链会过期，且顺带改写任务响应体）；
 *   ③ 仍拿不到本地副本且是 http(s) → 请服务端 rehost 到 OSS 再下一次（CORS 友好）；
 *   ④ registerAssetBlob 登记映射，显示改走本地 uri。
 * 全程 best-effort：任何一步失败都回退用远程 url（能播就行，不因落地失败丢结果）。
 */
export async function persistGenAsset(args: {
	resultUri: string;
	assetId?: string;
	rawLink?: boolean;
	saveToOss?: boolean;
	kind: "video" | "image" | "audio";
	label: string;
	owner: string;
	shouldContinue?: () => boolean;
}): Promise<{ uri: string; assetId?: string }> {
	const { resultUri, rawLink, kind, label, owner } = args;
	const current = () => ownerAlive(owner) && args.shouldContinue?.() !== false;
	if (!current()) return { uri: resultUri, assetId: args.assetId };
	let displayUri = resultUri;
	let blobId = args.assetId;
	try {
		const { saveRemoteAsset, uploadBlobToOss } = await import("@/services/assetPersist");
		if (!current()) return { uri: resultUri, assetId: args.assetId };
		const known = args.assetId ? useProjectStore.getState().assetBlobs[args.assetId] : undefined;
		let blob: AssetBlob | null = known?.localUri ? known : null;
		if (!blob) {
			const dl = rawLink ? (kind === "video" ? { attempts: 2, timeoutSecs: 120 } : { attempts: 3, timeoutSecs: 30 }) : undefined;
			blob = await saveRemoteAsset(args.assetId || `rtc-${Date.now()}`, resultUri, { ...dl, keepRemoteUrl: args.saveToOss !== false, shouldContinue: current });
			if (!current()) return { uri: resultUri, assetId: args.assetId };
			if (blob && rawLink && args.saveToOss !== false) {
				const prefix = kind === "video" ? "video" : kind === "audio" ? "audio" : "TP";
				blob = await uploadBlobToOss(blob, label, prefix, undefined, { shouldContinue: current });
				if (!current()) return { uri: resultUri, assetId: args.assetId };
			}
			if (args.saveToOss !== false && !blob && /^https?:\/\//i.test(resultUri)) {
				const { managedClient } = await import("@/services/managedClient");
				if (!current()) return { uri: resultUri, assetId: args.assetId };
				const re = await managedClient.rehost(resultUri, undefined, label);
				if (!current()) return { uri: resultUri, assetId: args.assetId };
				if (re?.url) blob = await saveRemoteAsset(re.id, re.url, { shouldContinue: current });
			}
		}
		if (blob && current()) {
			useProjectStore.getState().registerAssetBlob(blob);
			displayUri = blob.localUri || blob.url || resultUri;
			blobId = blob.id || blobId;
		}
	} catch {
		/* 落地失败：用远程 url 兜底（结果不丢） */
	}
	return { uri: displayUri, ...(blobId ? { assetId: blobId } : {}) };
}

/** 探测产物真实时长（秒）——视频/音频用；探不到返回 0（不建 source 窗口） */
export async function probeDurationSec(uri: string, kind: "video" | "image" | "audio"): Promise<number> {
	if (kind === "image") return 0;
	try {
		const { probeVideoDuration } = await import("@/canvas/videoCapture");
		const sec = await probeVideoDuration(uri);
		return Number.isFinite(sec) && sec > 0 ? sec : 0;
	} catch {
		return 0;
	}
}
