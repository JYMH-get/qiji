/**
 * segActions —— 时间轴右键菜单的**实际动作**：片段菜单（超分 / 去字幕 / 音频分离 / 重新生成）
 * 与空白区菜单（添加视频/图片/音频占位）。
 *
 * 自包含：不改 RtcTimeline.tsx / RtcTrackLane.tsx / rtcOps.ts / types/rtc.ts——两个 hook 各自
 * 返回「要挂的处理函数」+「要渲染的节点」，由 RtcTimeline 一处接线（接线代码见文末「接线说明」）。
 *
 * ⚠ 锁定规则一（第237轮用户定稿）——**轨道即结果堆叠，生成绝不就地覆盖**：
 *   轨道上的片段代表「结果」，任何生成动作都不得删除/覆盖已有结果。
 *   超分 / 去字幕 / 对已有成片的重新生成 ⇒ **源片段分毫不动**，在**上方轨道**同 target 窗口新建一个
 *   「结果占位」（带血缘 originSegId + genKind），生成完成后**那个占位**就地变成 media
 *   （只改 kind/media/assetId/uri/source 窗口，targetStartUs/targetDurationUs 分毫不动）。
 *   片段本身还是未完成占位时，重新生成=原地重跑（它本就是这一版的坑位，不新增）。
 *   上方轨道的挑选见 [segActionsCore.pickResultTrack](./segActionsCore)。
 *
 * ⚠ 锁定规则二：生成请求**只走库内唯一路径**——
 *   超分/去字幕 = [generationQueue.startDerivedGeneration](@/services/generationQueue)（断连保护/任务态/
 *   结果落分镜派生记录全由它承载），参数组装逐字段对齐 [Frame161195.doProcessVideo](@/views/Frame161195)；
 *   重新生成 = [shotGenActions.genShotVideo](@/rtc/panel/shotGenActions)（内部即 startShotGeneration
 *   + armPlaceholderSwap）。本文件不拼提示词、不改写生成参数语义。
 *
 * ⚠ 锁定规则三：数据变更**只走 `useRtcStore.getState().commit(mutator)`**，一次用户动作一条 undo。
 *
 * ⚠ 锁定规则四（项目身份守卫，照抄 [placeholderSwap](@/rtc/panel/placeholderSwap)）：
 *   arm 时记录 projectInstanceId，订阅回调入口比对——切项目立即 disarm；异步探测时长回来后落笔前
 *   再验一次（复制/导入的项目会撞 episodeId/shotId/segId，不校验会写进别的项目）。
 *
 * 落地锚点说明（已知边界）：超分/去字幕的结果由 generationQueue 写进**分镜的派生记录表**
 * （shot.videoDerived / sbDerived，库内唯一的媒体处理结果落点，资产模式视频区同一份数据可见），
 * 所以只有**关联分镜的片段（seg.shotRef）**能处理；素材面板直接拖进来的视频没有锚点，菜单点了会
 * 明确报错说明原因（绝不静默失败）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import VideoProcessModal, {
	PROCESS_PURPOSE,
	type VideoProcessMode,
	type VideoProcessSpec,
} from "@/components/VideoProcessModal";
import { startDerivedGeneration } from "@/services/generationQueue";
import { ensurePublicUrl } from "@/lib/publicUrl";
import { uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { genShotVideo } from "@/rtc/panel/shotGenActions";
// 三条生成链（分镜/派生/自由占位）共用的落笔层：台账对账 + 占位→media 字段变换 + 失败标记
import { armPendingWatch } from "@/rtc/panel/placeholderSwap";
import { markFailed } from "@/rtc/panel/rtcGenSink";
import { patchSegmentDoc } from "@/rtc/panel/rtcSegUtils";
import { useProjectStore } from "@/store/projectStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import { useRtcStore } from "@/store/rtcStore";
import { addSegment, replaceSegmentMedia, trackTypeForMedia } from "@/lib/rtcOps";
import { createRtcTrack, type RtcDoc, type RtcSegment, type RtcTrack } from "@/types/rtc";
import { genId } from "@/lib/id";
import type { VideoDerivedRecord } from "@/services/projectFile";
import { useRtcAssetSelStore } from "../rtcAssetSelStore";
import { collectProjectImageItems, type ProjectCatAsset } from "../asset/rtcAssetData";
import { imageDefaultUsFromSettings } from "../settings/rtcEditorSettingsStore";
import { probeMediaDurationSec } from "./timelineUtil";
import type { RtcSegMenuProps } from "./RtcSegContextMenu";
import {
	audioSegmentFor,
	blankPlaceholderKinds,
	buildBlankPlaceholder,
	buildResultPlaceholder,
	derivedVideoLabel,
	pickAudioTrack,
	pickResultTrack,
	segActionAvailability,
	type Availability,
	type ResultAction,
	type TrackPick,
} from "./segActionsCore";
/* 集成轮：右键菜单直连 定格/倒放/裁剪/复合 动作（与键盘快捷键同一批函数，一把尺） */
import { freezeAtPlayhead } from "./rtcFreezeActions";
import { toggleReverse } from "../panel/reverseActions";
import { requestCropEditor } from "../panel/cropEditorStore";
import { createCompoundFromSelection, dissolveSelectedCompound, enterSelectedCompound } from "./compoundActions";

const isTauri = (): boolean =>
	typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/* ────────────────────────── doc 落位小工具（内联不可变更新，不往 rtcOps 加函数） ────────────────────────── */

/** 按落位决策插入片段：复用既有轨道 / 在指定下标新建轨道后插入。返回新 doc（不改入参） */
function insertByPick(doc: RtcDoc, pick: TrackPick, type: RtcTrack["type"], seg: RtcSegment): RtcDoc {
	if (pick.kind === "existing") return addSegment(doc, pick.trackId, seg);
	const created = createRtcTrack(type);
	const tracks = [...doc.tracks];
	tracks.splice(Math.max(0, Math.min(pick.insertAtIndex, tracks.length)), 0, created);
	return addSegment({ ...doc, tracks }, created.id, seg);
}

/** 全 doc 找片段 + 其所在轨道 */
function findSeg(doc: RtcDoc, segId: string): { track: RtcTrack; seg: RtcSegment } | null {
	for (const t of doc.tracks) {
		const seg = t.segments.find((s) => s.id === segId);
		if (seg) return { track: t, seg };
	}
	return null;
}

/** 实时取片段（组件传入的可能是陈旧快照） */
function liveSeg(segId: string): { track: RtcTrack; seg: RtcSegment } | null {
	const doc = useRtcStore.getState().doc;
	return doc ? findSeg(doc, segId) : null;
}

/**
 * 在源片段上方轨道新建「结果占位」（一次 commit）。返回新占位 id；源片段不存在则返回 null。
 * ⚠ 源片段分毫不动——这是「轨道即结果堆叠」的核心。
 */
function spawnResultPlaceholder(
	srcSegId: string,
	action: ResultAction,
	opts?: { status?: RtcSegment["status"]; taskRef?: string },
): string | null {
	const found = liveSeg(srcSegId);
	if (!found) return null;
	const newId = genId("seg");
	const placeholder = buildResultPlaceholder(found.seg, { id: newId, action, ...opts });
	useRtcStore.getState().commit((doc) => {
		const live = findSeg(doc, srcSegId);
		if (!live) return doc; // 源片段已被删 → no-op（不进撤销栈不落盘）
		const pick = pickResultTrack(doc, live.track.id, live.seg.targetStartUs, live.seg.targetDurationUs);
		return insertByPick(doc, pick, live.track.type, placeholder);
	});
	// commit 可能 no-op（源片段刚被删）→ 确认占位真落了才回报 id
	return liveSeg(newId) ? newId : null;
}

/* ────────────────────────── 超分 / 去字幕：提交 ────────────────────────── */

/** 弹窗目标（超分/去字幕/图像超分） */
interface ProcTarget {
	segId: string;
	uri: string;
	mode: VideoProcessMode;
	episodeId: string;
	shotId: string;
	sourceName: string;
}

/**
 * 弹窗确认 → ①上方轨道建结果占位 ②分镜追加派生记录（running）③源公网化 ④提交火山 MediaKit
 * ⑤登记结果落地监听。**参数组装逐字段对齐 Frame161195.doProcessVideo**。
 */
async function submitProcess(target: ProcTarget, spec: VideoProcessSpec): Promise<void> {
	const { segId, uri, mode, episodeId, shotId } = target;
	const isImage = mode === "imageUpscale";
	const action: "upscale" | "desub" = mode === "desub" ? "desub" : "upscale";
	const found = liveSeg(segId);
	if (!found) {
		alert("该片段已被删除，处理已取消。");
		return;
	}
	// ① 结果占位（源片段分毫不动）
	const holderId = spawnResultPlaceholder(segId, action, { status: "running" });
	if (!holderId) {
		alert("该片段已被删除，处理已取消。");
		return;
	}
	const shot = useProjectStore
		.getState()
		.episodes.find((e) => e.id === episodeId)
		?.shots.find((s) => s.id === shotId);
	if (!shot) {
		markFailed(holderId, "关联分镜已被删除，无法处理");
		return;
	}
	// ② 派生记录（资产模式视频区/故事板区同一份数据可见）
	const field: "video" | "storyboard" = isImage ? "storyboard" : "video";
	const recId = `${isImage ? "sd" : "vd"}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	const { label, srcLabel } = isImage
		? { label: "超分", srcLabel: "故事板" }
		: derivedVideoLabel(shot, uri, action);
	const rec: VideoDerivedRecord = {
		id: recId,
		kind: isImage ? "upscale" : action,
		uri: "", // 处理完成后由 generationQueue.applyDerivedResult 写入产物本地 uri
		srcUri: uri,
		srcLabel,
		label,
		createdAt: Date.now(),
		params: spec.params,
		modelKey: spec.modelKey,
		status: "running",
	};
	const st = useProjectStore.getState();
	if (isImage) {
		// 同源唯一，后到覆盖（与 Frame161195 同尺）
		st.updateShot(episodeId, shotId, { sbDerived: [...(shot.sbDerived || []).filter((d) => d.srcUri !== uri), rec] });
	} else {
		// 同标号唯一（标号取决于最后一次处理）
		st.updateShot(episodeId, shotId, { videoDerived: [...(shot.videoDerived || []).filter((d) => d.label !== label), rec] });
	}
	const markFail = (msg: string) => {
		const cur = useProjectStore
			.getState()
			.episodes.find((e) => e.id === episodeId)
			?.shots.find((s) => s.id === shotId);
		const list = field === "storyboard" ? cur?.sbDerived : cur?.videoDerived;
		if (list?.some((d) => d.id === recId)) {
			useProjectStore.getState().updateShot(episodeId, shotId, {
				[field === "storyboard" ? "sbDerived" : "videoDerived"]: list.map((d) =>
					d.id === recId ? { ...d, status: "failed" as const, error: msg } : d,
				),
			});
		}
		markFailed(holderId, msg);
	};
	try {
		// ③ 源公网化（火山 MediaKit 只吃公网直链）
		const publicUrl = await ensurePublicUrl(uri, { name: `${shot.title || "分镜"}·${srcLabel}` });
		if (!publicUrl) {
			markFail(`源${isImage ? "图" : "视频"}公网化失败（上传 OSS 未成功），请重试`);
			return;
		}
		const blob = useProjectStore.getState().blobByUri(uri);
		const refName = `${shot.title || "分镜"}·${srcLabel}`;
		// ④ 提交（持久化在途，切页/重启可找回）
		const pendingId = startDerivedGeneration({
			episodeId,
			shotId,
			recId,
			field,
			purpose: PROCESS_PURPOSE[mode],
			params: spec.params,
			modelKey: spec.modelKey,
			input: isImage
				? { images: [{ ...(blob?.id ? { id: blob.id } : {}), url: publicUrl, name: refName }] }
				: { videos: [{ ...(blob?.id ? { id: blob.id } : {}), url: publicUrl, name: refName }] },
			label: `${shot.title || "分镜"} ${label}（${spec.modelLabel}）`,
		});
		// ⑤ 完成即把结果占位就地变成 media —— 三条生成链（分镜/派生/自由占位）共用 panel 层的
		//    通用台账对账（armPendingWatch 内部会打 running + 记 taskRef，并支持重开客户端后接续；
		//    派生结果的 source 窗口由它凭 originSegId 回查源片段沿用，不会跳画面）。
		armPendingWatch(pendingId, holderId);
	} catch (err) {
		markFail(err instanceof Error ? err.message : "提交失败");
	}
}

/* ────────────────────────── 音频分离（ffmpeg 真抽音轨） ────────────────────────── */

/** ffmpeg 进程可直接读取的源（本地文件路径或真 http(s) 直链；webview 内部协议不算）。
 *  与 [videoCapture.resolveUriSourceInfo](@/canvas/videoCapture) 同尺——那边未导出，此处按同一规则内联。 */
function isFfmpegReadable(u?: string | null): boolean {
	return !!u && /^https?:\/\//i.test(u) && !/asset\.localhost|ipc\.localhost/i.test(u);
}
function resolveFfmpegSource(uri: string): { direct?: string; fetchUri?: string } {
	const blob = useProjectStore.getState().blobByUri(uri);
	const localPath = blob?.localPath || undefined;
	const direct = localPath || [blob?.url, uri, blob?.localUri].find(isFfmpegReadable) || undefined;
	const fetchUri = uri || blob?.localUri || blob?.url || undefined;
	return { direct, fetchUri };
}

/** 调 Rust `extract_video_audio` 抽出音轨字节（m4a）。仅 Tauri；失败抛错（含「没有音轨」等明确原因）。 */
async function extractAudioBytes(uri: string): Promise<Uint8Array> {
	const { direct, fetchUri } = resolveFfmpegSource(uri);
	if (!direct && !fetchUri) throw new Error("找不到该片段的源视频文件");
	const { invoke } = await import("@tauri-apps/api/core");
	const fs = await import("@tauri-apps/plugin-fs");
	const path = await import("@tauri-apps/api/path");
	let input = direct ?? "";
	let tempInput = "";
	if (!input) {
		// 仅 webview 内部协议（asset://）→ 先 fetch 字节落临时文件再喂 ffmpeg（同 videoCapture）
		const resp = await fetch(fetchUri as string);
		if (!resp.ok) throw new Error(`读取视频源失败（HTTP ${resp.status}）`);
		const bytes = new Uint8Array(await resp.arrayBuffer());
		const dir = await path.tempDir();
		tempInput = await path.join(dir, `qiji-audioin-${Date.now()}.mp4`);
		await fs.writeFile(tempInput, bytes);
		input = tempInput;
	}
	try {
		const outPath = await invoke<string>("extract_video_audio", { src: input });
		const bytes = await fs.readFile(outPath);
		try {
			await fs.remove(outPath);
		} catch {
			/* 临时输出清理失败可忽略 */
		}
		if (!bytes || bytes.length === 0) throw new Error("ffmpeg 未产出音频文件");
		return bytes;
	} finally {
		if (tempInput) {
			try {
				await fs.remove(tempInput);
			} catch {
				/* 临时输入清理失败可忽略 */
			}
		}
	}
}

/**
 * 音频分离（剪映语义）：抽出源视频的音轨 → 落成独立音频资产 → 在音频轨插入**同 target 窗口**的
 * 音频片段，源视频片段设为静音（**不删不换**，这是用户显式动作，不算「无缘无故增删」）。
 * 插入 + 静音在**同一个 commit**（一次动作一条 undo）。
 */
async function runSeparateAudio(segId: string): Promise<void> {
	const found = liveSeg(segId);
	if (!found?.seg.uri) {
		alert("该片段没有可分离的源视频文件。");
		return;
	}
	const bytes = await extractAudioBytes(found.seg.uri);
	const safe = (found.seg.name || "视频").replace(/[\\/:*?"<>|]/g, "_");
	const file = new File([bytes as BlobPart], `${safe}·音频.m4a`, { type: "audio/mp4" });
	// 懒上传（第194轮）：只落本地 + 注册三元映射，提交生成请求时再由 ensurePublicUrl 补传 OSS
	const up = await uploadMediaToCanvasAsset(file);
	const newId = genId("seg");
	useRtcStore.getState().commit((doc) => {
		const live = findSeg(doc, segId);
		if (!live) return doc; // 源片段已被删 → no-op
		const audioSeg = audioSegmentFor(live.seg, { id: newId, assetId: up.assetId, uri: up.displayUri });
		const pick = pickAudioTrack(doc, audioSeg.targetStartUs, audioSeg.targetDurationUs);
		const withAudio = insertByPick(doc, pick, "audio", audioSeg);
		return patchSegmentDoc(withAudio, segId, { muted: true }); // 源视频片段静音（不删不换）
	});
	useRtcStore.getState().setSelection([newId]);
}

/** 音频分离防重入（模块级——右键菜单与快捷键 Ctrl+Shift+S 共用同一把锁） */
const audioBusySet = new Set<string>();

/** 带防重入与报错兜底的音频分离（onBusy 可选——键盘路径没有忙碌浮层也照常可用） */
async function runSeparateAudioGuarded(segId: string, onBusy?: (msg: string | null) => void): Promise<void> {
	if (audioBusySet.has(segId)) return;
	audioBusySet.add(segId);
	onBusy?.("正在分离音频…");
	try {
		await runSeparateAudio(segId);
	} catch (err) {
		alert(`音频分离失败：${err instanceof Error ? err.message : "未知错误"}`);
	} finally {
		audioBusySet.delete(segId);
		onBusy?.(null);
	}
}

/**
 * 键盘入口（Ctrl+Shift+S）：对当前选区里**首个视频片段**执行音频分离。
 * 可用性判定与右键菜单同一把尺（segActionAvailability）；被阻断=明确报错，绝不静默失败。
 */
export function separateAudioForSelection(): void {
	const st = useRtcStore.getState();
	if (!st.doc || st.selection.length === 0) return;
	for (const id of st.selection) {
		const found = findSeg(st.doc, id);
		if (!found) continue;
		const av = segActionAvailability(found.seg, found.track, { tauri: isTauri() }).separateAudio;
		if (!av) continue; // 不是视频片段——继续找选区里的下一个
		if (!av.ok) {
			alert(av.reason);
			return;
		}
		void runSeparateAudioGuarded(found.seg.id);
		return;
	}
	alert("请先选中一个视频片段，再分离音频。");
}

/* ────────────────────────── 用素材面板选中的素材替换（右键菜单） ────────────────────────── */

/** 面板当前选中素材归一成可替换的素材描述（uri 剔除 data:/blob:——写进 doc 的红线） */
interface PanelAsset {
	media: "image" | "video" | "audio";
	name?: string;
	assetId?: string;
	displayUri?: string;
	probeUri?: string;
}

const lightUri = (u: unknown): string | undefined =>
	typeof u === "string" && u && !/^(data|blob):/i.test(u) ? u : undefined;

/**
 * 读左栏素材面板的当前选中（rtcAssetSelStore）：
 *  - mediaSel（视频/音频卡）→ 直接可用（assetId 经三元映射反查，退卡片 key）；
 *  - selected（五类资产）→ 取当前造型的主图（与面板卡片/中栏预览同一条显示链路
 *    collectProjectImageItems——选中造型优先），无图（占位符卡）返回 null。
 * 两类都没选返回 null。
 */
function panelSelectedAsset(): PanelAsset | null {
	const sel = useRtcAssetSelStore.getState();
	const ps = useProjectStore.getState();
	if (sel.mediaSel) {
		const m = sel.mediaSel;
		const blob = ps.blobByUri(m.uri);
		return {
			media: m.media,
			name: m.name,
			assetId: blob?.id || (m.key !== m.uri ? m.key : undefined),
			displayUri: lightUri(m.uri),
			probeUri: m.uri,
		};
	}
	if (sel.selected) {
		const { cat, id } = sel.selected;
		const list = ps[cat] as unknown as ProjectCatAsset[] | undefined;
		const a = list?.find((x) => x.id === id);
		if (!a) return null;
		const item = collectProjectImageItems([a], cat, useAssetFormStore.getState().selForm)[0];
		if (!item?.uri) return null; // 尚未出图的占位符卡：无可替换的素材
		const blob = ps.blobByUri(item.uri);
		return { media: "image", name: item.name, assetId: blob?.id, displayUri: lightUri(item.uri), probeUri: item.uri };
	}
	return null;
}

/**
 * 用面板选中素材**原位替换**片段（rtcOps.replaceSegmentMedia 语义：位置不动、时长保持、
 * 新素材撑不满才收短；一次 commit = 一条 undo）。视频/音频先探测真实总长供 source 窗口。
 */
async function replaceSegWithPanelAsset(segId: string, asset: PanelAsset): Promise<void> {
	let sourceTotalUs = 0;
	if (asset.media !== "image" && asset.probeUri) {
		const sec = await probeMediaDurationSec(asset.probeUri, asset.media);
		if (sec > 0) sourceTotalUs = Math.round(sec * 1_000_000);
	}
	useRtcStore.getState().commit((doc) =>
		replaceSegmentMedia(doc, segId, {
			media: asset.media,
			...(asset.assetId ? { assetId: asset.assetId } : {}),
			...(asset.displayUri ? { uri: asset.displayUri } : {}),
			...(asset.name ? { name: asset.name } : {}),
			sourceTotalUs,
		}),
	);
	useRtcStore.getState().setSelection([segId]);
}

/**
 * 右键菜单「用素材面板选中的素材替换」的 props（文本轨不适用=不显示；
 * 无选中素材 / 类型与轨道不相容 = 置灰并带原因）。
 */
function buildReplaceMenuProps(seg: RtcSegment, track: RtcTrack): Partial<RtcSegMenuProps> {
	if (track.type === "text") return {};
	if (track.locked) return { replaceDisabled: "轨道已锁定，无法替换该片段。" };
	const asset = panelSelectedAsset();
	if (!asset) return { replaceDisabled: "请先在左侧素材面板选中一个素材（点击卡片）。" };
	if (trackTypeForMedia(asset.media) !== track.type) {
		return { replaceDisabled: `选中的素材是${asset.media === "audio" ? "音频" : "画面"}素材，与该轨道类型不符。` };
	}
	return { onReplaceWithAsset: () => void replaceSegWithPanelAsset(seg.id, asset) };
}

/* ────────────────────────── hook：片段右键菜单动作 ────────────────────────── */

const PROC_MODE: Record<"upscale" | "desub", VideoProcessMode> = { upscale: "upscale", desub: "desub" };

/**
 * 片段右键菜单的动作集合。
 * `build(seg, track)` → 传给 [RtcSegContextMenu](./RtcSegContextMenu) 的 onUpscale/onDesub/
 * onSeparateAudio/onRegenerate（不适用则为 undefined，菜单自动不显示该项）；
 * `modals` → 要渲染的弹窗/忙碌提示节点。
 */
export function useSegActions(): {
	build: (seg: RtcSegment, track: RtcTrack) => Partial<RtcSegMenuProps>;
	modals: React.ReactNode;
} {
	const [proc, setProc] = useState<ProcTarget | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const openProc = useCallback((seg: RtcSegment, mode: "upscale" | "desub") => {
		const live = liveSeg(seg.id);
		if (!live?.seg.uri || !live.seg.shotRef) {
			alert("该片段已变化或没有源文件，请重新右击试试。");
			return;
		}
		const { episodeId, shotId } = live.seg.shotRef;
		const shot = useProjectStore
			.getState()
			.episodes.find((e) => e.id === episodeId)
			?.shots.find((s) => s.id === shotId);
		if (!shot) {
			alert("该片段关联的分镜已被删除，无法处理（处理结果需要落在分镜的派生记录里）。");
			return;
		}
		const isImage = (live.seg.media ?? "video") === "image";
		setProc({
			segId: seg.id,
			uri: live.seg.uri,
			mode: isImage ? "imageUpscale" : PROC_MODE[mode],
			episodeId,
			shotId,
			sourceName: live.seg.name || shot.title || "片段",
		});
	}, []);

	// 防重入与报错兜底在模块级 runSeparateAudioGuarded（与快捷键 Ctrl+Shift+S 共用同一把锁）
	const separateAudio = useCallback(async (segId: string) => {
		await runSeparateAudioGuarded(segId, setBusy);
	}, []);

	/**
	 * 重新生成：
	 *  - 片段仍是占位（这一版的坑位还空着）→ 原地重跑，不新增片段；
	 *  - 片段已是成片 media → 上方轨道新建结果占位，生成完成后填进那个占位，**原结果原位保留**。
	 */
	const regenerate = useCallback(async (segId: string) => {
		const live = liveSeg(segId);
		if (!live?.seg.shotRef) {
			alert("该片段没有关联分镜，无法重新生成。");
			return;
		}
		const { episodeId, shotId } = live.seg.shotRef;
		const shot = useProjectStore
			.getState()
			.episodes.find((e) => e.id === episodeId)
			?.shots.find((s) => s.id === shotId);
		if (!shot) {
			alert("该片段关联的分镜已被删除，无法重新生成。");
			return;
		}
		// ⚠ 占位=原地重跑；成片=上方新占位（新结果落新占位，原结果不动）。
		//    落笔统一走 panel 层的 rtcGenSink：占位变 media 时 status/progress/taskRef/error 一律清空
		//    （不清的话替换后的成片会永远显示「生成中」）。
		const targetSegId =
			live.seg.kind === "placeholder" ? segId : spawnResultPlaceholder(segId, "shot", { status: "running" });
		if (!targetSegId) {
			alert("该片段已被删除，重新生成已取消。");
			return;
		}
		// 走库内唯一路径：内部 startShotGeneration + armPlaceholderSwap（成功即把该占位就地变成成片）
		const ok = await genShotVideo(episodeId, shotId, { swapSegId: targetSegId });
		// 提交没发出（缺提示词/首尾帧素材不足等，genShotVideo 已 alert 说明）→ 撤掉刚建的空占位，不留垃圾
		if (!ok && targetSegId !== segId) {
			useRtcStore.getState().commit((doc) => {
				const hit = findSeg(doc, targetSegId);
				if (!hit) return doc;
				return {
					...doc,
					tracks: doc.tracks.map((t) =>
						t.id === hit.track.id ? { ...t, segments: t.segments.filter((s) => s.id !== targetSegId) } : t,
					),
				};
			});
		}
	}, []);

	const build = useCallback(
		(seg: RtcSegment, track: RtcTrack): Partial<RtcSegMenuProps> => {
			const av = segActionAvailability(seg, track, { tauri: isTauri() });
			/** 可执行→真动作；被阻断→点击时明确报错（绝不静默失败） */
			const wrap = (a: Availability | undefined, run: () => void): (() => void) | undefined => {
				if (!a) return undefined; // 该动作对这类片段不适用 → 菜单不显示
				return a.ok ? run : () => alert(a.reason);
			};
			// 集成轮：定格 / 倒放 / 裁剪 / 复合片段（右键前 RtcTimeline 已 ensureSelected，选区即本片段/整组）
			const isVideoMedia = seg.kind === "media" && seg.media === "video" && !!seg.uri;
			const isVisualMedia = seg.kind === "media" && seg.media !== "audio" && !!seg.uri && track.type === "video";
			const notLocked = !track.locked;
			return {
				onUpscale: wrap(av.upscale, () => openProc(seg, "upscale")),
				onDesub: wrap(av.desub, () => openProc(seg, "desub")),
				onSeparateAudio: wrap(av.separateAudio, () => void separateAudio(seg.id)),
				onRegenerate: wrap(av.regenerate, () => void regenerate(seg.id)),
				// 「用素材面板选中的素材替换」：右击那一刻现读面板选中态（无选中/类型不符=置灰带原因）
				...buildReplaceMenuProps(seg, track),
				onFreeze: isVideoMedia && notLocked ? () => void freezeAtPlayhead(seg.id) : undefined,
				onReverse: isVideoMedia && notLocked
					? () => void toggleReverse(seg.id).then((r) => { if (!r.ok && r.error) alert(r.error); })
					: undefined,
				reverseLabel: seg.reversedFromAssetId ? "取消倒放" : "倒放",
				onCrop: isVisualMedia && notLocked
					? () => { useRtcStore.getState().setSelection([seg.id]); requestCropEditor(seg.id); }
					: undefined,
				onCompound: seg.kind === "media" && track.type !== "text" && notLocked
					? () => { const r = createCompoundFromSelection(); if (!r.ok && r.reason) alert(r.reason); }
					: undefined,
				onEnterCompound: seg.kind === "compound" ? () => { const r = enterSelectedCompound(); if (!r.ok && r.reason) alert(r.reason); } : undefined,
				onUncompound: seg.kind === "compound" && notLocked
					? () => { const r = dissolveSelectedCompound(); if (!r.ok && r.reason) alert(r.reason); }
					: undefined,
			};
		},
		[openProc, separateAudio, regenerate],
	);

	const modals = (
		<>
			{proc && (
				<VideoProcessModal
					uri={proc.uri}
					mode={proc.mode}
					sourceName={proc.sourceName}
					onCancel={() => setProc(null)}
					onConfirm={(spec) => {
						setProc(null);
						void submitProcess(proc, spec);
					}}
				/>
			)}
			{busy && (
				<div
					className="fixed left-1/2 top-1/2 z-[10600] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-white/10 bg-[#181a22] px-5 py-3 text-[12px] text-secondary-foreground shadow-2xl"
					role="status"
				>
					{busy}
				</div>
			)}
		</>
	);

	return { build, modals };
}

/* ────────────────────────── 空白区右键菜单：添加占位 ────────────────────────── */

interface BlankMenuState {
	x: number;
	y: number;
	trackId: string;
	atUs: number;
	kinds: ("video" | "image" | "audio")[];
}

const BLANK_LABEL: Record<"video" | "image" | "audio", string> = {
	video: "添加视频占位",
	image: "添加图片占位",
	audio: "添加音频占位",
};

/** 菜单宽度（与 RtcSegContextMenu 同值） */
const MENU_W = 180;

/** 空白区右键菜单（样式/交互对齐 RtcSegContextMenu：fixed 定位 + 边界钳制 + Esc/外点关闭） */
function RtcBlankContextMenu({ state, onClose }: { state: BlankMenuState; onClose: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	// Esc / 外点关闭（与 RtcSegContextMenu 同款）
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeRef.current();
		};
		const onPointer = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("pointerdown", onPointer);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("pointerdown", onPointer);
		};
	}, []);
	const clampX = Math.min(state.x, window.innerWidth - MENU_W - 8);
	const clampY = Math.min(state.y, window.innerHeight - 160);
	const btn =
		"flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/10 cursor-pointer transition-colors text-[12px] text-secondary-foreground";
	const add = (media: "video" | "image" | "audio") => {
		const id = genId("seg");
		// 图片占位时长走设置「图片默认时长」（默认 3s，行为不变）；视频/音频仍用档位表
		const durUs = media === "image" ? imageDefaultUsFromSettings() : undefined;
		useRtcStore.getState().commit((doc) => addSegment(doc, state.trackId, buildBlankPlaceholder(media, state.atUs, id, durUs)));
		useRtcStore.getState().setSelection([id]);
		onClose();
	};
	return (
		<>
			<div
				className="fixed inset-0 z-[10400]"
				onClick={onClose}
				onContextMenu={(e) => {
					e.preventDefault();
					onClose();
				}}
			/>
			<div
				ref={ref}
				className="fixed z-[10401] rounded-lg border border-white/10 bg-[#181a22] p-1 shadow-2xl"
				style={{ left: clampX, top: clampY, width: MENU_W }}
			>
				{state.kinds.map((k) => (
					<button key={k} type="button" className={btn} onClick={() => add(k)}>
						<span
							className="inline-block h-2.5 w-2.5 rounded-[3px] border border-dashed"
							style={{ borderColor: k === "audio" ? "var(--node-audio)" : "var(--node-video)" }}
						/>
						{BLANK_LABEL[k]}
					</button>
				))}
			</div>
		</>
	);
}

/**
 * 空白区右键「添加占位」。
 * `open(x, y, trackId, atUs)`：坐标换算（eventUs / trackIndexFromY）由 RtcTimeline 负责，本 hook 只吃结果；
 * 返回 false = 该轨道类型没有可添加项（文本轨），调用方可据此不弹菜单。
 * `menu` → 要渲染的菜单节点。
 */
export function useBlankActions(): {
	open: (x: number, y: number, trackId: string, atUs: number) => boolean;
	menu: React.ReactNode;
} {
	const [state, setState] = useState<BlankMenuState | null>(null);
	const open = useCallback((x: number, y: number, trackId: string, atUs: number) => {
		const track = useRtcStore.getState().doc?.tracks.find((t) => t.id === trackId);
		if (!track || track.locked) return false; // 锁轨不接受新片段
		const kinds = blankPlaceholderKinds(track.type);
		if (kinds.length === 0) return false;
		setState({ x, y, trackId, atUs: Math.max(0, atUs), kinds });
		return true;
	}, []);
	const menu = state ? <RtcBlankContextMenu state={state} onClose={() => setState(null)} /> : null;
	return { open, menu };
}

/* ────────────────────────── 接线说明（给 RtcTimeline.tsx 的确切代码） ──────────────────────────
 *
 * import { useSegActions, useBlankActions } from "./timeline/segActions";
 *
 * 1) 片段右键菜单（RtcTimeline 组件体内，与其它 hook 并列）：
 *      const segActions = useSegActions();
 *    在既有 onSegContextMenu 的 setSegMenu({...}) 里，把 build 的结果展开进去（放在最后一行）：
 *      setSegMenu({
 *        x: e.clientX, y: e.clientY, seg, track,
 *        onClose: () => setSegMenu(null),
 *        onSplit: () => {…},
 *        onDelete: () => {…},
 *        ...segActions.build(seg, track),        // ← 新增这一行
 *      });
 *    渲染处（{segMenu && <RtcSegContextMenu {...segMenu} />} 旁边）加：
 *      {segActions.modals}
 *
 * 2) 空白区右键「添加占位」：
 *      const blankActions = useBlankActions();
 *    在轨道区的 onContextMenu 里（未命中片段时；eventUs / trackIndexFromY 已在 RtcTimeline 里）：
 *      const t = renderDoc?.tracks[trackIndexFromY(e.clientY)];
 *      if (t && blankActions.open(e.clientX, e.clientY, t.id, eventUs(e.clientX))) e.preventDefault();
 *    渲染处加：
 *      {blankActions.menu}
 *
 * 3) [RtcSegContextMenu.tsx](./RtcSegContextMenu) 里「重新生成」的显示条件已由
 *    `isPlaceholder && onRegenerate` 放宽为 `onRegenerate`——是否显示由本模块 build() 决定
 *    （成片 media 片段也要能重新生成：新结果落上方新占位，原结果保留）。
 *
 * 4) types/rtc.ts 补上 status/progress/taskRef/originSegId/genKind/error 后，
 *    [segActionsCore.ts](./segActionsCore) 里的 RtcResultMeta / RtcSegmentX 可整体删除，
 *    把用到 RtcSegmentX 的地方换回 RtcSegment 即可（本模块无其它耦合）。
 */
