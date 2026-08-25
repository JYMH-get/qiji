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
import type { AssetBlob } from "@/services/projectFile";
import type { TaskExtra } from "@/services/adapters/types";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
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
	return useProjectStore.getState().projectInstanceId === owner;
}

/* ────────────────────────── doc 写入原语 ────────────────────────── */

/**
 * 对片段应用补丁（内联不可变更新）。
 * `placeholderOnly` = 只对仍是 placeholder 的片段生效（终态落笔用——用户可能已经把它删了、
 * 拖了别的素材替换掉，绝不抢别人的片段）。补丁什么都不改时返回原 doc 引用（no-op）。
 */
function patchDoc(doc: RtcDoc, segId: string, patch: SegPatch, placeholderOnly: boolean): RtcDoc {
	let hit = false;
	const tracks = doc.tracks.map((t) => {
		const idx = t.segments.findIndex((s) => s.id === segId);
		if (idx < 0) return t;
		const seg = t.segments[idx];
		if (placeholderOnly && seg.kind !== "placeholder") return t;
		if (segPatchIsNoop(seg, patch)) return t;
		hit = true;
		const segments = [...t.segments];
		segments[idx] = { ...seg, ...patch } as RtcSegment;
		return { ...t, segments };
	});
	return hit ? { ...doc, tracks } : doc;
}

/** doc 顶层轨道里找片段（不进 subDocs——占位落笔历来只作用于顶层，与 patchDoc 同口径） */
function findSegIn(doc: RtcDoc | null, segId: string): RtcSegment | null {
	if (!doc) return null;
	for (const t of doc.tracks) {
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
function patchInactiveSlots(segId: string, patch: SegPatch, placeholderOnly: boolean): void {
	const ps = useProjectStore.getState();
	const activeKey = resolveEpisodeKey(ps.rtcEpisodeId, ps.episodes);
	for (const [epKey, doc] of Object.entries(ps.rtcDocs)) {
		if (epKey === activeKey) continue; // 激活分集以 rtcStore.doc 为工作副本，归上面两条路
		const next = patchDoc(doc, segId, patch, placeholderOnly);
		if (next !== doc) {
			ps.setRtcEpisodeDoc(epKey, next);
			return;
		}
	}
}

/** 走 commit（进撤销栈）写占位补丁；owner 不匹配/片段已删/已非占位 → 静默 no-op */
function commitPatch(segId: string, patch: SegPatch, owner?: string): void {
	if (owner && !ownerAlive(owner)) return;
	if (findSegIn(useRtcStore.getState().doc, segId)) {
		useRtcStore.getState().commit((doc) => patchDoc(doc, segId, patch, true));
		return;
	}
	patchInactiveSlots(segId, patch, true);
}

/** 走 patchSilent（不进撤销栈）写占位补丁——高频在途帧专用 */
function silentPatch(segId: string, patch: SegPatch, owner?: string): void {
	if (owner && !ownerAlive(owner)) return;
	if (findSegIn(useRtcStore.getState().doc, segId)) {
		useRtcStore.getState().patchSilent((doc) => patchDoc(doc, segId, patch, true));
		return;
	}
	patchInactiveSlots(segId, patch, true);
}

/** 现查片段（不订阅；调用方判断"还在不在、还是不是占位"）。
 *  分集化：激活分集的工作副本优先，找不到再查非激活分集档位（跨集落笔判定用）。 */
export function liveSegment(segId: string): RtcSegment | null {
	const hit = findSegIn(useRtcStore.getState().doc, segId);
	if (hit) return hit;
	const ps = useProjectStore.getState();
	const activeKey = resolveEpisodeKey(ps.rtcEpisodeId, ps.episodes);
	for (const [epKey, doc] of Object.entries(ps.rtcDocs)) {
		if (epKey === activeKey) continue;
		const s = findSegIn(doc, segId);
		if (s) return s;
	}
	return null;
}

/* ────────────────────────── 对外动作 ────────────────────────── */

/**
 * 提交生成 → 占位转「生成中」并记下 taskRef（用户动作，进撤销栈）。
 * taskRef 语义见 [rtcGenCore.parseTaskRef]（pending 台账 id 或 `adapterKey|taskId`）。
 */
export function armRunning(segId: string, taskRef?: string, owner?: string): void {
	useRtcQueueStore.getState().setInfo(segId, null); // 清掉上一轮的排队信息（新任务从零起算）
	commitPatch(segId, runningPatch(taskRef ? { taskRef } : undefined), owner);
}

/** 在途状态镜像（台账说它还在跑/已失败）——不进撤销栈 */
export function mirrorStatus(segId: string, patch: SegPatch, owner?: string): void {
	silentPatch(segId, patch, owner);
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
export function mirrorProgress(segId: string, progress: number, owner?: string, extra?: TaskExtra): void {
	if (owner && !ownerAlive(owner)) return;
	useRtcQueueStore.getState().setInfo(segId, extra ?? null);
	const now = Date.now();
	const mark = progressMark.get(segId);
	const val = clampProgress(progress);
	if (!shouldWriteProgress(mark?.val, val, mark?.at ?? 0, now)) return;
	progressMark.set(segId, { at: now, val });
	silentPatch(segId, { status: "running", progress: val, error: undefined }, owner);
}

/** 生成失败（终态，进撤销栈）：片段**保留不删**，用户能看到失败原因并重试 */
export function markFailed(segId: string, error: string, owner?: string): void {
	progressMark.delete(segId);
	useRtcQueueStore.getState().setInfo(segId, null);
	commitPatch(segId, failedPatch(error), owner);
}

/**
 * 占位 → 结果（终态，进撤销栈）：只改 kind/media/assetId/uri/source 窗口并清空占位态字段；
 * **targetStartUs / targetDurationUs 分毫不动**（时长不符留给用户裁剪）。
 * 片段已被删 / 已不是占位 → 静默 no-op。
 */
export function landMedia(
	segId: string,
	args: {
		media: NonNullable<RtcSegment["media"]>;
		uri: string;
		assetId?: string;
		/** 产物真实时长（秒）；缺省/0=不建 source 窗口。新生成的素材用这个 */
		durationSec?: number;
		/** 显式指定 source 窗口（优先于 durationSec）——超分/去字幕沿用源片段窗口时用 */
		sourceWindow?: { sourceStartUs: number; sourceDurationUs: number } | null;
		owner?: string;
	},
): void {
	progressMark.delete(segId);
	useRtcQueueStore.getState().setInfo(segId, null);
	const source =
		args.sourceWindow !== undefined ? args.sourceWindow : sourceWindowFor(args.media, args.durationSec ?? 0);
	commitPatch(segId, mediaPatch(args.media, args.uri, args.assetId, source), args.owner);
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
	kind: "video" | "image" | "audio";
	label: string;
	owner: string;
}): Promise<{ uri: string; assetId?: string }> {
	const { resultUri, rawLink, kind, label, owner } = args;
	let displayUri = resultUri;
	let blobId = args.assetId;
	try {
		const { saveRemoteAsset, uploadBlobToOss } = await import("@/services/assetPersist");
		const known = args.assetId ? useProjectStore.getState().assetBlobs[args.assetId] : undefined;
		let blob: AssetBlob | null = known?.localUri ? known : null;
		if (!blob) {
			const dl = rawLink ? (kind === "video" ? { attempts: 2, timeoutSecs: 120 } : { attempts: 3, timeoutSecs: 30 }) : undefined;
			blob = await saveRemoteAsset(args.assetId || `rtc-${Date.now()}`, resultUri, dl);
			if (blob && rawLink) {
				const prefix = kind === "video" ? "video" : kind === "audio" ? "audio" : "TP";
				blob = await uploadBlobToOss(blob, label, prefix);
			}
			if (!blob && /^https?:\/\//i.test(resultUri)) {
				const { managedClient } = await import("@/services/managedClient");
				const re = await managedClient.rehost(resultUri, undefined, label);
				if (re?.url) blob = await saveRemoteAsset(re.id, re.url);
			}
		}
		if (blob && ownerAlive(owner)) {
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
