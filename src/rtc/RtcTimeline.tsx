/**
 * RtcTimeline —— 实时剪辑时间轴（纯 DOM + CSS transform，无第三方 timeline 库）。
 *
 * 布局：单滚动容器里 sticky 组合——轨道头列 sticky left、标尺行 sticky top、角块双 sticky；
 * 播放头竖线绝对定位贯穿轨道区（z 低于 sticky 头，标尺上的三角标记补齐视觉）。
 *
 * 交互（全部 pointer 事件，集中在内容层按 data-seg / data-edge / data-ruler / data-track-id 派发）：
 *   - 拖动/裁剪过程只改本地 previewDoc（moveSegment/trimSegment 纯函数试算），**pointerup 才
 *     commit 一次**——一次手势 = 一条 undo；期间绝不逐帧 commit；
 *   - 吸附按 snapCandidates 就近（阈值 SNAP_PX 像素换算微秒）；落点重叠由 rtcOps 夹到最近空隙；
 *   - 拖放入轨接 application/x-qiji-asset：视频/音频先探测真实时长（图片默认 3 秒），
 *     媒体类型与轨道类型不匹配时落到首条匹配轨、没有则新建（同一 commit，一条 undo）。
 *
 * 轨道分层（剪映式）：显示序恒走 rtcOps.orderTracksForDisplay（文本组 → 非主视频轨（越晚建越靠上）
 *   → **主轨** → 音频组），⚠ 只排显示、绝不重排 doc.tracks（数组序是数据层真相）。
 *
 * 拖到缝隙新建轨道：拖动中指针悬在两行边界的命中带（GAP_HIT_PX）上，**持续 GAP_DWELL_MS**
 *   才判定为「要在此新建轨道」（防跨轨路过误建）→ 高亮该缝隙 → 松手时同一 commit 里
 *   insertTrackAt + moveSegment（一条 undo）。只有能容纳该类型的缝隙才高亮（gapLegalForType）；
 *   指针在轨道区之外（标尺上方/底部空白）时收敛到最近的合法缝隙（nearestLegalGap）——
 *   「拖到底部空白新建轨道」的老能力即此情形，视频片段会落到主轨上方（新 video 轨绝不越到主轨之下）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RtcDoc, RtcSegment, RtcTrackType } from "@/types/rtc";
import { createEmptyRtcDoc, createRtcTrack } from "@/types/rtc";
import {
	MIN_SEGMENT_US,
	addSegment,
	docDurationUs,
	expandSelectionWithGroups,
	gapInsertIndex,
	gapLegalForType,
	insertTrackAt,
	mainVideoTrackId,
	moveSegment,
	nearestLegalGap,
	nearestSnap,
	orderTracksForDisplay,
	pruneEmptyTracks,
	removeSegments,
	removeTrack,
	replaceSegmentMedia,
	setTrackProps,
	snapCandidates,
	snapSegmentStart,
	splitSegment,
	trackTypeForMedia,
	trimSegment,
} from "@/lib/rtcOps";
import { genId } from "@/lib/id";
import { activeRtcDoc, useRtcStore, type RtcState } from "@/store/rtcStore";
import { subDocDurationUs } from "@/lib/rtcCompound";
import { RtcCompoundBreadcrumb } from "./timeline/RtcCompoundBreadcrumb";
import { useRtcAssetSelStore } from "./rtcAssetSelStore";
import { useProjectStore, activeRtcProjectDoc, resolveEpisodeKey } from "@/store/projectStore";
import { useVideoDurationStore } from "@/store/videoDurationStore";
import { RtcRuler } from "./timeline/RtcRuler";
import { RtcTrackHeader } from "./timeline/RtcTrackHeader";
import { RtcTrackLane } from "./timeline/RtcTrackLane";
/* 第三批：字幕片段入口（角块「＋字幕」按钮 / text 轨空白双击） */
import { addSubtitleAtPlayhead, addSubtitleSegmentAt } from "./textActions";
/* 集成轮：标记 / 定格 / 复合片段 的键盘入口 */
import { addMarkerCycleColor, jumpNextMarker, jumpPrevMarker, toggleMarkerAtPlayhead } from "./timeline/rtcMarkerActions";
import { freezeAtPlayhead } from "./timeline/rtcFreezeActions";
import { createCompoundFromSelection, dissolveSelectedCompound } from "./timeline/compoundActions";
import { useSegActions, useBlankActions, separateAudioForSelection } from "./timeline/segActions";
import { resolveRtcShortcut, shouldIgnoreKeyTarget } from "./timeline/rtcKeymap";
import {
	toggleSelectionKeyframes,
	reverseSelection,
	cropSelection,
	selectAllSegments,
	bigStepPlayhead,
	copySelection,
	copySelectionAttrs,
	cutSelection,
	deleteSelection,
	duplicateSelection,
	groupSelection,
	jumpToCutPoint,
	mirrorSelection,
	nudgePlayhead,
	pasteClipboard,
	pasteSelectionAttrs,
	rippleDeleteSelection,
	rotateSelection,
	seekPlayheadEdge,
	selectSideOfPlayhead,
	splitAllTracksAtPlayhead,
	splitSelectionAtPlayhead,
	stepPlayheadFrames,
	togglePreviewPlayback,
	trimSelectionToPlayhead,
	ungroupSelection,
} from "./timeline/rtcEditActions";
import { useRtcClipboard } from "./rtcClipboard";
import { copiedSegTemplate } from "./timeline/rtcClipboardCore";
/* 外部文件拖入：懒上传登记素材库（与左栏「本地导入」同链）后入轨 */
import { uploadKindFromFile, uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { useLibraryStore } from "@/store/libraryStore";
import { useRtcAttrClipboard } from "./rtcAttrClipboard";
import { coveredSegmentIds } from "./rtcPlayback";
/* 原文参考车道（补充10）：实时从主轨分镜派生的只读参考行——非轨道数据、不参与任何剪辑交互 */
import { scriptLaneItems } from "@/lib/rtcScriptLane";
import { RtcSegContextMenu } from "./timeline/RtcSegContextMenu";
import type { RtcSegMenuProps } from "./timeline/RtcSegContextMenu";
import {
	ASSET_MIME,
	GAP_DWELL_MS,
	GAP_HIT_PX,
	HEADER_W,
	MEDIA_FALLBACK_US,
	ROW_H_TEXT,
	RULER_H,
	rowHeightOf,
	marqueeSelectIds,
	SNAP_PX,
	TRACK_LABELS,
	imageDefaultUs,
	parseAssetPayload,
	probeMediaDurationSec,
	type DroppedAsset,
} from "./timeline/timelineUtil";

const US_PER_SEC = 1_000_000;

type DragState =
	| { kind: "seek" }
	| { kind: "blank"; startX: number; startY: number; moved: boolean; sx: number; sy: number }
	| {
			kind: "move";
			segId: string;
			trackType: RtcTrackType;
			grabOffsetUs: number;
			durUs: number;
			candidates: number[];
			thresholdUs: number;
			startX: number;
			startY: number;
			moved: boolean;
			toTrackId: string;
			desiredStartUs: number;
			/** 被拖片段所在轨的行高（幽灵条高度；文本轨半高） */
			rowH: number;
			/** 拖动跟手幽灵条的标签（片段名） */
			label: string;
			/** Alt+拖动=复制：原片段不动，松手在落点放一个副本（手势开始时按 altKey 定，中途不变） */
			copy: boolean;
			/** 预览是否已「抬起」原片段（首次真移动时置位，避免逐帧重建预览文档） */
			lifted?: boolean;
			/** 已判定「松手要在此缝隙新建轨道」的显示序缝隙号（悬停满 GAP_DWELL_MS 才置位） */
			newTrackGap?: number;
	  }
	| {
			kind: "trim";
			segId: string;
			edge: "start" | "end";
			origEdgeUs: number;
			sourceTotalUs?: number;
			candidates: number[];
			thresholdUs: number;
			startX: number;
			moved: boolean;
			deltaUs: number;
	  };

/** 落点预览试算用的临时片段 id（Alt+复制拖动期间的幽灵，绝不入真 doc） */
const COPY_TRIAL_ID = "__rtc_copy_trial__";

/**
 * Alt+拖动复制的副本模板：按原片段现做（copiedSegTemplate 剥 id/在途状态，assetId 原样共享
 * ——⚠ 副本仍是同一素材的纯时间窗口引用，绝不产生新素材实体；复合片段共享同一 subDocId 同理）。
 * groupId 刻意剥掉：Alt+拖动只复制单段，副本不并入原片段所在的组。原片段不存在返回 null。
 */
function dragCopyClone(d: RtcDoc, segId: string, atUs: number, id: string): RtcSegment | null {
	for (const t of d.tracks) {
		const s = t.segments.find((sg) => sg.id === segId);
		if (s) {
			const { groupId: _g, ...tpl } = copiedSegTemplate(s);
			void _g;
			return { ...tpl, id, targetStartUs: Math.max(0, Math.round(atUs)) } as RtcSegment;
		}
	}
	return null;
}

/** 播放头贯穿线（独立订阅：拖播放头/缩放不重渲轨道区） */
function PlayheadLine() {
	const playheadUs = useRtcStore((s) => s.playheadUs);
	const pxPerSec = useRtcStore((s) => s.pxPerSec);
	return (
		<div
			className="absolute top-0 bottom-0 w-px z-10 pointer-events-none"
			style={{ left: HEADER_W + (playheadUs / US_PER_SEC) * pxPerSec, background: "var(--primary)" }}
		/>
	);
}

/* 第四批：编辑层口径——回调里现读「当前编辑层」文档（主层=doc、复合子层=子文档视图）；
 * 配套的数据变更一律走 commitActive（子层改动写回 doc.subDocs，undo/落盘复用同一条链）。 */
function activeDocNow(): ReturnType<typeof activeRtcDoc> {
	return activeRtcDoc(useRtcStore.getState());
}
function commitActiveNow(mutator: Parameters<RtcState["commitActive"]>[0]): void {
	useRtcStore.getState().commitActive(mutator);
}

export function RtcTimeline() {
	// 第四批：时间轴渲染「当前编辑层」（进入复合片段时 = 子时间轴视图，引用稳定可作 selector）
	const doc = useRtcStore(activeRtcDoc);
	const pxPerSec = useRtcStore((s) => s.pxPerSec);
	const selection = useRtcStore((s) => s.selection);
	const projectRtcDoc = useProjectStore(activeRtcProjectDoc); // 当前激活分集的档位（分集化）
	/* 原文参考车道数据源：当前激活分集的 shots（属性面板改原文 → episodes 变 → 车道即时跟变） */
	const laneEpKey = useProjectStore((s) => resolveEpisodeKey(s.rtcEpisodeId, s.episodes));
	const laneEpisode = useProjectStore((s) => s.episodes.find((ep) => ep.id === laneEpKey));

	const [previewDoc, setPreviewDoc] = useState<RtcDoc | null>(null);
	/** 拖动跟手幽灵 + 白色半透明落点预览（ghost=吸附后的指针位置自由跟随；slot=松手将落下的合法位置） */
	const [moveGhost, setMoveGhost] = useState<{
		ghost: { left: number; top: number; width: number; height: number; label: string };
		slot: { left: number; top: number; width: number; height: number } | null;
	} | null>(null);
	const [dropHint, setDropHint] = useState<string | null>(null);
	/** 素材拖放命中的「将被原位替换」片段 id（dragover 期间的视觉反馈） */
	const [replaceHint, setReplaceHint] = useState<string | null>(null);
	const [viewportW, setViewportW] = useState(1200);
	const [segMenu, setSegMenu] = useState<RtcSegMenuProps | null>(null);
	/* 右键菜单的实际动作（超分/去字幕/音频分离/重新生成）与空白区「添加占位」菜单，
	 * 逻辑与弹窗都在 segActions 自包含模块里，这里只负责坐标换算与挂载。 */
	const segActions = useSegActions();
	const blankActions = useBlankActions();
	const [newTrackHint, setNewTrackHint] = useState<{ type: RtcTrackType; topPx: number } | null>(null);
	/** 框选矩形（内容坐标；null=非框选中） */
	const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	/** 时间轴「注意力」（用户定稿：点过时间轴后 Ctrl+A 才归时间轴全选；点别处即交还浏览器原生） */
	const attentionRef = useRef(false);
	const dragRef = useRef<DragState | null>(null);
	const zoomAnchorRef = useRef<{ timeSec: number; offsetPx: number } | null>(null);
	/** 缝隙悬停计时器：同一缝隙连续悬停满 GAP_DWELL_MS 才判定为「要在此新建轨道」 */
	const gapTimerRef = useRef<{ gap: number; timer: ReturnType<typeof setTimeout> } | null>(null);

	const clearGapTimer = useCallback(() => {
		if (gapTimerRef.current) clearTimeout(gapTimerRef.current.timer);
		gapTimerRef.current = null;
	}, []);
	useEffect(() => clearGapTimer, [clearGapTimer]);

	// 引导装载：进入页面时 rtcStore 还没有 doc → 用项目里的 rtcDoc（没有则建空文档，首次 commit 才落盘）
	useEffect(() => {
		if (!useRtcStore.getState().doc) {
			useRtcStore.getState().loadDoc(projectRtcDoc ?? createEmptyRtcDoc());
		}
	}, [projectRtcDoc]);

	// 滚动容器宽度（内容最小宽 = 视口宽，缩到最小也铺满）
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setViewportW(el.clientWidth));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// 注意力跟踪（window 捕获阶段）：最近一次按下是否落在时间轴里——Ctrl+A 的分派依据
	useEffect(() => {
		const onDown = (e: PointerEvent) => {
			attentionRef.current = !!scrollRef.current?.parentElement?.contains(e.target as Node);
		};
		window.addEventListener("pointerdown", onDown, true);
		return () => window.removeEventListener("pointerdown", onDown, true);
	}, []);

	/* 全局快捷键：键位规则在 rtcKeymap（纯函数+单测），动作在 rtcEditActions（唯一入口、每次一条 undo）。
	 * 守卫：输入框/文本域/可编辑区聚焦时一律不劫持（时间码输入、提示词框、轨道重命名都在同一页面）；
	 * 按钮聚焦时放行空格（它自己的激活键）；用户正选着文本时把 Ctrl+C/X 让回浏览器原生复制。 */
	useEffect(() => {
		/** 没有选区时直接放行的动作（不 preventDefault，别白吞按键） */
		const NEEDS_SELECTION = new Set([
			"delete", "rippleDelete", "copy", "cut", "duplicate", "split",
			"trimLeft", "trimRight", "mirror", "rotate", "separateAudio",
			"group", "ungroup", "copyAttrs", "pasteAttrs",
			"freeze", "keyframe", "reverse", "crop", "compound", "uncompound",
		]);
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			if (shouldIgnoreKeyTarget(t, e.key)) return;
			const action = resolveRtcShortcut(e);
			if (!action) return;
			const st = useRtcStore.getState();
			if (!st.doc) return;
			if (st.selection.length === 0 && NEEDS_SELECTION.has(action)) return;
			if ((action === "copy" || action === "cut") && (window.getSelection()?.toString() ?? "")) return;
			if (action === "paste" && useRtcClipboard.getState().entries.length === 0) return;
			if (action === "pasteAttrs" && !useRtcAttrClipboard.getState().attrs) return;
			// Ctrl+A：注意力不在时间轴（没点过它）→ 不劫持，让浏览器对聚焦处做原生全选
			if (action === "selectAll" && !attentionRef.current) return;

			e.preventDefault();
			switch (action) {
				case "undo": return st.undo();
				case "redo": return st.redo();
				case "delete": return void deleteSelection();
				case "rippleDelete": return void rippleDeleteSelection();
				case "copy": return void copySelection();
				case "cut": return void cutSelection();
				case "paste": return void pasteClipboard();
				case "duplicate": return void duplicateSelection();
				case "split": return splitSelectionAtPlayhead();
				case "splitAll": return splitAllTracksAtPlayhead();
				case "trimLeft": return trimSelectionToPlayhead("start");
				case "trimRight": return trimSelectionToPlayhead("end");
				case "selectLeft": return void selectSideOfPlayhead("left");
				case "selectRight": return void selectSideOfPlayhead("right");
				case "prevCut": return jumpToCutPoint(-1);
				case "nextCut": return jumpToCutPoint(1);
				case "bigStepBack": return bigStepPlayhead(-1);
				case "bigStepForward": return bigStepPlayhead(1);
				case "mirror": return mirrorSelection();
				case "rotate": return rotateSelection();
				case "separateAudio": return separateAudioForSelection();
				case "group": return groupSelection();
				case "ungroup": return ungroupSelection();
				case "copyAttrs": return void copySelectionAttrs();
				case "pasteAttrs": return void pasteSelectionAttrs();
				case "playPause": return void togglePreviewPlayback();
				case "stepBack": return stepPlayheadFrames(-1);
				case "stepForward": return stepPlayheadFrames(1);
				case "jumpBack": return nudgePlayhead(-US_PER_SEC);
				case "jumpForward": return nudgePlayhead(US_PER_SEC);
				case "gotoStart": return seekPlayheadEdge("start");
				case "gotoEnd": return seekPlayheadEdge("end");
				// ── 集成轮：标记 / 定格 / 关键帧 / 倒放 / 裁剪 / 复合片段 ──
				case "marker": return toggleMarkerAtPlayhead();
				case "markerAlt": return addMarkerCycleColor();
				case "prevMarker": return jumpPrevMarker();
				case "nextMarker": return jumpNextMarker();
				case "freeze": return void freezeAtPlayhead();
				case "keyframe": return toggleSelectionKeyframes();
				case "reverse": return reverseSelection();
				case "crop": return cropSelection();
				case "compound": { const r = createCompoundFromSelection(); if (!r.ok && r.reason) alert(r.reason); return; }
				case "uncompound": { const r = dissolveSelectedCompound(); if (!r.ok && r.reason) alert(r.reason); return; }
				case "toggleScriptTrack": useRtcStore.getState().toggleScriptTrackVisible(); return;
				case "selectAll": return void selectAllSegments();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// 滚轮三态（用户定稿）：裸滚轮=轨道区上下滚动（原生，主轨 sticky 常驻不动）；Ctrl+滚轮=以指针
	// 为锚缩放时间轴；Alt+滚轮=时间线前后（水平）滚动。native 非 passive 才能 preventDefault。
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			if (e.altKey && !e.ctrlKey) {
				// Alt+滚轮=水平滚动（竖轮当横轮用；触控板本就横滚的 deltaX 一并吃进）
				e.preventDefault();
				el.scrollLeft += e.deltaY + e.deltaX;
				return;
			}
			if (!e.ctrlKey) {
				// 裸滚轮=**只做纵向滚动**（显式接管，勿回退成放行原生）：Chromium 对「只有横向溢出」的
				// 容器会把竖轮自动映射成横滚——轨道少（无纵向溢出）时裸滚轮就横着跑，正是用户点名
				// 禁掉的行为。deltaX（触控板横向手势 / Shift+滚轮）仍横滚。
				e.preventDefault();
				el.scrollTop += e.deltaY;
				if (e.deltaX) el.scrollLeft += e.deltaX;
				return;
			}
			e.preventDefault();
			const st = useRtcStore.getState();
			const rect = el.getBoundingClientRect();
			const offsetPx = e.clientX - rect.left - HEADER_W;
			const timeSec = (el.scrollLeft + offsetPx) / st.pxPerSec;
			const next = Math.min(1000, Math.max(1, st.pxPerSec * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
			if (next === st.pxPerSec) return;
			zoomAnchorRef.current = { timeSec, offsetPx };
			st.setZoom(next);
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	useLayoutEffect(() => {
		const a = zoomAnchorRef.current;
		if (!a) return;
		zoomAnchorRef.current = null;
		const el = scrollRef.current;
		if (el) el.scrollLeft = Math.max(0, a.timeSec * pxPerSec - a.offsetPx);
	}, [pxPerSec]);

	/* ── 几何换算 ── */
	const renderDoc = previewDoc ?? doc;
	// 显示序（剪映式分层）：文本组 → 非主视频轨（越晚建越靠上）→ 主轨 → 音频组；⚠ 只排显示不动 doc.tracks
	const displayTracks = renderDoc ? orderTracksForDisplay(renderDoc.tracks) : [];
	/* 原文参考车道（补充10）：从**真 doc**（非拖动预览）派生——拖动中车道保持原位不闪跳，
	 * 松手 commit 后即时对齐新位置；主轨没素材/分镜没原文 = 车道整行不出现（laneH=0）。 */
	const scriptLane = useMemo(() => scriptLaneItems(doc, laneEpisode), [doc, laneEpisode]);
	const laneH = scriptLane.length > 0 ? ROW_H_TEXT : 0;
	const laneHRef = useRef(0);
	laneHRef.current = laneH;
	/* 行几何（文本轨半高）：rowTops[i]=第 i 行顶部（含 标尺+原文车道 偏移）、rowTops[rows]=轨道区底部。
	 * 指针换算/缝隙命中/幽灵落点/框选全部以它为唯一口径（行高不再恒等 ROW_H）。 */
	const rowTops: number[] = [RULER_H + laneH];
	for (const t of displayTracks) rowTops.push(rowTops[rowTops.length - 1] + rowHeightOf(t));
	/* 被上层画面完全遮挡的片段：轨道上做「保留但不生效」的弱化提示（与播放取最上层同一口径）。
	 * 拖动预览期间用 renderDoc，观感随手势实时跟随。 */
	const coveredIds = useMemo(() => (renderDoc ? coveredSegmentIds(renderDoc) : []), [renderDoc]);
	const mainTrackId = renderDoc ? mainVideoTrackId(renderDoc.tracks) : null;

	const eventUs = useCallback(
		(clientX: number) => {
			const rect = contentRef.current?.getBoundingClientRect();
			if (!rect) return 0;
			return Math.max(0, Math.round(((clientX - rect.left - HEADER_W) / pxPerSec) * US_PER_SEC));
		},
		[pxPerSec],
	);
	/** 指针 Y → 命中的轨道 id（按**显示行**换算，rowTops 已含原文车道偏移；返回 id 而非下标，
	 *  消费方拿 id 去各自的 doc（activeDocNow 真 doc / renderDoc）查，杜绝「显示序下标 × 真数组」错位） */
	const trackIdFromY = useCallback(
		(clientY: number): string | null => {
			const rect = contentRef.current?.getBoundingClientRect();
			if (!rect) return null;
			const y = clientY - rect.top;
			for (let i = 0; i < displayTracks.length; i++) {
				if (y >= rowTops[i] && y < rowTops[i + 1]) return displayTracks[i].id;
			}
			return null;
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[displayTracks, rowTops.join(",")],
	);

	/**
	 * 指针 → 「两轨缝隙」命中（拖动中新建轨道用）：
	 *   - 轨道区内：距最近的行边界 ≤ GAP_HIT_PX 才算命中，且该缝隙须能容纳 type（否则返回 null 走常规落轨）；
	 *   - 轨道区外（标尺上方 / 底部空白）：收敛到最近的**合法**缝隙——「拖到底部空白新建轨道」的老能力
	 *     即此情形（视频片段会落到主轨上方，新 video 轨绝不越到主轨之下）。
	 */
	const gapFromY = useCallback(
		(clientY: number, type: RtcTrackType): { gap: number; topPx: number } | null => {
			const rect = contentRef.current?.getBoundingClientRect();
			if (!rect || !renderDoc) return null;
			const y = clientY - rect.top;
			const rows = displayTracks.length;
			const bottom = rowTops[rows];
			let gap: number | null;
			// rowTops[0]=首行顶部（含原文车道偏移）——车道区域视同「轨道区上方」收敛到缝隙 0
			if (y < rowTops[0] || y > bottom) {
				gap = nearestLegalGap(renderDoc.tracks, y < rowTops[0] ? 0 : rows, type);
			} else {
				// 行高不一（文本轨半高）：逐边界找最近的一条（rows+1 条边界，量级个位数）
				let nearest = 0;
				let best = Infinity;
				for (let i = 0; i < rowTops.length; i++) {
					const dd = Math.abs(y - rowTops[i]);
					if (dd < best) { best = dd; nearest = i; }
				}
				if (best > GAP_HIT_PX) return null;
				gap = gapLegalForType(renderDoc.tracks, nearest, type) ? nearest : null;
			}
			return gap == null ? null : { gap, topPx: rowTops[Math.min(gap, rowTops.length - 1)] };
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[displayTracks.length, renderDoc, rowTops.join(",")],
	);

	/* ── pointer 手势（选择/拖动/裁剪/播放头） ── */
	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			if (e.button !== 0) return;
			const target = e.target as HTMLElement;
			const st = useRtcStore.getState();
			const d = activeDocNow(); // 第四批：手势作用于当前编辑层
			if (!d) return;

			if (target.closest("[data-ruler]")) {
				dragRef.current = { kind: "seek" };
				st.setPlayhead(eventUs(e.clientX));
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
				return;
			}
			if (target.closest("button") || target.closest("[data-hdr]")) return; // 轨道头按钮自理

			const segEl = target.closest<HTMLElement>("[data-seg]");
			const laneEl = target.closest<HTMLElement>("[data-track-id]");
			if (segEl && laneEl) {
				const trackId = laneEl.dataset.trackId!;
				const track = d.tracks.find((t) => t.id === trackId);
				const segId = segEl.dataset.seg!;
				const seg = track?.segments.find((s) => s.id === segId);
				if (!track || !seg || track.locked) return;

				if (e.ctrlKey || e.metaKey) {
					// Ctrl 多选切换（带 groupId 的片段按**整组**加入/移出），不进入拖动
					const cur = st.selection;
					const groupIds = expandSelectionWithGroups(d, [segId]);
					st.setSelection(
						cur.includes(segId)
							? cur.filter((x) => !groupIds.includes(x))
							: [...new Set([...cur, ...groupIds])],
					);
					return;
				}
				// 点击选中：带 groupId 的片段选中整组（删除/复制/剪切经 selection 天然作用于整组）
				if (!st.selection.includes(segId)) st.setSelection(expandSelectionWithGroups(d, [segId]));

				const thresholdUs = (SNAP_PX / st.pxPerSec) * US_PER_SEC;
				const candidates = snapCandidates(d, [segId]);
				const edgeEl = target.closest<HTMLElement>("[data-edge]");
				if (edgeEl) {
					const edge = edgeEl.dataset.edge as "start" | "end";
					let sourceTotalUs: number | undefined;
					if (seg.kind === "media" && (seg.media === "video" || seg.media === "audio") && seg.uri) {
						const sec = useVideoDurationStore.getState().seconds[seg.uri];
						if (sec && sec > 0) sourceTotalUs = Math.round(sec * US_PER_SEC);
					} else if (seg.kind === "compound" && seg.subDocId) {
						// 第四批：复合片段的「源总长」= 子时间轴总时长（右缘外扩不越过子内容尾部）
						const sub = useRtcStore.getState().doc?.subDocs?.[seg.subDocId];
						if (sub) sourceTotalUs = subDocDurationUs(sub);
					}
					dragRef.current = {
						kind: "trim",
						segId,
						edge,
						origEdgeUs: edge === "start" ? seg.targetStartUs : seg.targetStartUs + seg.targetDurationUs,
						sourceTotalUs,
						candidates,
						thresholdUs,
						startX: e.clientX,
						moved: false,
						deltaUs: 0,
					};
				} else {
					dragRef.current = {
						kind: "move",
						segId,
						trackType: track.type,
						grabOffsetUs: eventUs(e.clientX) - seg.targetStartUs,
						durUs: seg.targetDurationUs,
						candidates,
						thresholdUs,
						startX: e.clientX,
						startY: e.clientY,
						moved: false,
						toTrackId: trackId,
						desiredStartUs: seg.targetStartUs,
						rowH: rowHeightOf(track),
						label: seg.name || (seg.kind === "compound" ? "复合片段" : seg.kind === "placeholder" ? "占位" : "片段"),
						copy: e.altKey, // Alt+拖动=复制（剪映/涂鸦编辑器同款；手势开始时定，中途按放 Alt 不变）
					};
				}
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
				e.preventDefault();
				return;
			}
			// 空白区：按下=可能是清选点击，拖开 3px=框选多选（用户定稿「鼠标点按拖动多选」）
			{
				const rect = contentRef.current?.getBoundingClientRect();
				dragRef.current = {
					kind: "blank",
					startX: e.clientX,
					startY: e.clientY,
					moved: false,
					sx: rect ? e.clientX - rect.left : 0,
					sy: rect ? e.clientY - rect.top : 0,
				};
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); // 框选拖出容器仍跟踪
			}
		},
		[eventUs],
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent) => {
			const drag = dragRef.current;
			if (!drag) return;
			const st = useRtcStore.getState();
			if (drag.kind === "seek") {
				st.setPlayhead(eventUs(e.clientX));
				return;
			}
			if (drag.kind === "blank") {
				if (Math.abs(e.clientX - drag.startX) > 3 || Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
				if (!drag.moved) return;
				// 框选：矩形（内容坐标）实时显示 + 实时选中相交片段（整组扩散；锁定轨不参与）
				const rect = contentRef.current?.getBoundingClientRect();
				if (!rect) return;
				const cx = e.clientX - rect.left;
				const cy = e.clientY - rect.top;
				const left = Math.min(drag.sx, cx);
				const top = Math.min(drag.sy, cy);
				const w = Math.abs(cx - drag.sx);
				const h = Math.abs(cy - drag.sy);
				setMarquee({ left, top, width: w, height: h });
				const t1 = Math.max(0, ((left - HEADER_W) / st.pxPerSec) * US_PER_SEC);
				const t2 = Math.max(0, ((left + w - HEADER_W) / st.pxPerSec) * US_PER_SEC);
				const ids = marqueeSelectIds(displayTracks, rowTops, top, top + h, t1, t2);
				const dNow = activeDocNow();
				st.setSelection(dNow ? expandSelectionWithGroups(dNow, ids) : ids);
				return;
			}
			const d = activeDocNow(); // 第四批：手势作用于当前编辑层
			if (!d) return;
			if (drag.kind === "move") {
				if (!drag.moved && Math.abs(e.clientX - drag.startX) < 3 && Math.abs(e.clientY - drag.startY) < 3) return;
				drag.moved = true;
				let desired = eventUs(e.clientX) - drag.grabOffsetUs;
				if (st.snapOn) desired = snapSegmentStart(drag.candidates, desired, drag.durUs, drag.thresholdUs);
				desired = Math.max(0, desired);

				// 缝隙悬停：同一缝隙连续悬停满 GAP_DWELL_MS 才判定「松手要在此新建轨道」
				// （指针不动时也要能触发 → 用计时器而不是靠 pointermove）
				const g = gapFromY(e.clientY, drag.trackType);
				if (!g) {
					clearGapTimer();
					if (drag.newTrackGap != null) {
						drag.newTrackGap = undefined;
						setNewTrackHint(null);
					}
				} else if (gapTimerRef.current?.gap !== g.gap && drag.newTrackGap !== g.gap) {
					clearGapTimer();
					setNewTrackHint(null);
					drag.newTrackGap = undefined;
					const timer = setTimeout(() => {
						drag.newTrackGap = g.gap;
						setNewTrackHint({ type: drag.trackType, topPx: g.topPx });
					}, GAP_DWELL_MS);
					gapTimerRef.current = { gap: g.gap, timer };
				}

				// 目标轨道：只认「同类型且未锁定」的轨道，否则停留在上一个合法目标
				const tid = trackIdFromY(e.clientY);
				const cand = tid ? d.tracks.find((t) => t.id === tid) : undefined;
				if (cand && cand.type === drag.trackType && !cand.locked) drag.toTrackId = cand.id;
				drag.desiredStartUs = desired;
				/* 拖动观感（用户定稿）：素材**跟手**，不在合法空隙间跳（闪来闪去的病根=把 moveSegment 的
				 * 夹隙结果直接当预览）。三件套：①原片段从预览里「抬起」（removeSegments 只作预览，落笔仍从
				 * 真 doc 算）；②幽灵条按吸附后的指针时间+指针所在行自由跟随（跨轨也跟）；③**白色半透明
				 * 落点预览**画在 moveSegment 试算的合法位置=松手真正落下的地方（悬停缝隙建新轨时不画）。 */
				if (!drag.copy && !drag.lifted) {
					// 复制拖动不「抬起」原片段——原片段留在原地，只有幽灵与落点预览在动
					drag.lifted = true;
					setPreviewDoc(removeSegments(d, [drag.segId]));
				}
				const rows = orderTracksForDisplay(d.tracks);
				const rectTop = contentRef.current?.getBoundingClientRect().top;
				// 幽灵条**逐像素跟随指针**（指针=条的纵向中心；不按行量化、不钳进轨道区——真跟手，勿回退成 ROW_H 取整）
				const ghostTop = rectTop != null ? e.clientY - rectTop - (drag.rowH - 8) / 2 : RULER_H;
				const widthPxOf = Math.max(2, (drag.durUs / US_PER_SEC) * st.pxPerSec);
				let slot: { left: number; top: number; width: number; height: number } | null = null;
				if (drag.newTrackGap == null) {
					// 落点试算与松手 commit 同一把尺：移动=moveSegment、复制=addSegment（原片段在场参与夹隙）
					let landed: RtcSegment | undefined;
					if (drag.copy) {
						const clone = dragCopyClone(d, drag.segId, desired, COPY_TRIAL_ID);
						if (clone) {
							const trial = addSegment(d, drag.toTrackId, clone);
							landed = trial.tracks.find((t) => t.id === drag.toTrackId)?.segments.find((sg) => sg.id === COPY_TRIAL_ID);
						}
					} else {
						const trial = moveSegment(d, drag.segId, drag.toTrackId, desired);
						landed = trial.tracks.find((t) => t.id === drag.toTrackId)?.segments.find((sg) => sg.id === drag.segId);
					}
					const slotIdx = rows.findIndex((t) => t.id === drag.toTrackId);
					if (landed && slotIdx >= 0) {
						// 目标行顶部按行高累加（文本轨半高——ROW_H 定步长会错位）；基线含原文车道偏移
						let slotTop = RULER_H + laneHRef.current;
						for (let i = 0; i < slotIdx; i++) slotTop += rowHeightOf(rows[i]);
						slot = {
							left: HEADER_W + (landed.targetStartUs / US_PER_SEC) * st.pxPerSec,
							top: slotTop,
							width: widthPxOf,
							height: rowHeightOf(rows[slotIdx]) - 8,
						};
					}
				}
				setMoveGhost({
					ghost: {
						left: HEADER_W + (desired / US_PER_SEC) * st.pxPerSec,
						top: ghostTop,
						width: widthPxOf,
						height: drag.rowH - 8,
						label: drag.copy ? `${drag.label} · 副本` : drag.label,
					},
					slot,
				});
				return;
			}
			// trim
			if (!drag.moved && Math.abs(e.clientX - drag.startX) < 3) return;
			drag.moved = true;
			const rawDelta = Math.round(((e.clientX - drag.startX) / st.pxPerSec) * US_PER_SEC);
			let edgePos = drag.origEdgeUs + rawDelta;
			if (st.snapOn) {
				const snapped = nearestSnap(drag.candidates, edgePos, drag.thresholdUs);
				if (snapped != null) edgePos = snapped;
			}
			drag.deltaUs = edgePos - drag.origEdgeUs;
			setPreviewDoc(
				trimSegment(d, drag.segId, drag.edge, drag.deltaUs, { sourceTotalUs: drag.sourceTotalUs }),
			);
		},
		[eventUs, trackIdFromY, gapFromY, clearGapTimer],
	);

	const onPointerUp = useCallback((e: React.PointerEvent) => {
		const drag = dragRef.current;
		dragRef.current = null;
		clearGapTimer();
		setNewTrackHint(null);
		if (!drag) return;
		const st = useRtcStore.getState();
		if (drag.kind === "blank") {
			setMarquee(null);
			if (!drag.moved && st.selection.length) st.setSelection([]); // 原地点击=清空选区（框选结果保留）
			return;
		}
		if (drag.kind === "seek") return;
		setPreviewDoc(null);
		setMoveGhost(null);
		if (!drag.moved) {
			// 原地点击：收敛为单选（带 groupId 的片段仍收敛为整组——组即选中单元）
			if (drag.kind === "move" && st.selection.length > 1) {
				st.setSelection(st.doc ? expandSelectionWithGroups(st.doc, [drag.segId]) : [drag.segId]);
			}
			return;
		}
		// 手势结束才 commit 一次（undo 粒度 = 一次拖动/裁剪）
		if (drag.kind === "move") {
			const gap = drag.newTrackGap;
			if (drag.copy) {
				// Alt+拖动=复制：原片段分毫不动，副本按落点放置（addSegment 夹隙，与粘贴同语义）
				const newId = genId("seg");
				commitActiveNow((d) => {
					const clone = dragCopyClone(d, drag.segId, drag.desiredStartUs, newId);
					if (!clone) return d;
					if (gap != null) {
						const newTrackId = genId("track");
						const at = gapInsertIndex(d.tracks, gap, drag.trackType);
						return addSegment(insertTrackAt(d, drag.trackType, at, { id: newTrackId }), newTrackId, clone);
					}
					return addSegment(d, drag.toTrackId, clone);
				});
				// 副本落地即成为当前选中（可立刻继续拖/删）；commit 被身份守卫丢弃时副本不存在则不动选区
				const after = activeDocNow();
				if (after?.tracks.some((t) => t.segments.some((s) => s.id === newId))) st.setSelection([newId]);
			} else if (gap != null) {
				// 悬停缝隙满时长 → 在该缝隙新建同类型轨道 + 放置（同一 commit = 一条 undo）
				const newTrackId = genId("track");
				commitActiveNow((d) => {
					const at = gapInsertIndex(d.tracks, gap, drag.trackType); // 现算，不用拖动期间的快照
					const withTrack = insertTrackAt(d, drag.trackType, at, { id: newTrackId });
					return pruneEmptyTracks(moveSegment(withTrack, drag.segId, newTrackId, drag.desiredStartUs)); // 源轨空了就回收
				});
			} else {
				commitActiveNow((d) => pruneEmptyTracks(moveSegment(d, drag.segId, drag.toTrackId, drag.desiredStartUs))); // 源轨空了就回收
			}
		} else {
			commitActiveNow((d) => trimSegment(d, drag.segId, drag.edge, drag.deltaUs, { sourceTotalUs: drag.sourceTotalUs }));
		}
		void e;
	}, [clearGapTimer]);

	/* ── 拖放入轨（application/x-qiji-asset） ── */
	/** 拖放落点命中的已有片段（→ 原位替换）：轨道未锁、且轨道类型能接素材（text 轨不接） */
	const replaceTargetFromEvent = useCallback(
		(e: React.DragEvent): { segId: string; trackType: RtcTrackType } | null => {
			const segEl = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-seg]");
			const segId = segEl?.dataset.seg;
			if (!segId) return null;
			const d = activeDocNow();
			const track = d?.tracks.find((t) => t.segments.some((s) => s.id === segId));
			if (!track || track.locked || track.type === "text") return null;
			return { segId, trackType: track.type };
		},
		[],
	);

	const onDragOver = useCallback(
		(e: React.DragEvent) => {
			const types = Array.from(e.dataTransfer.types);
			// 外部文件（OS 拖入）：只亮落点轨道提示，不做「原位替换」预判（dragover 拿不到文件类型）
			if (!types.includes(ASSET_MIME)) {
				if (!types.includes("Files")) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "copy";
				const d = activeDocNow();
				const tidF = trackIdFromY(e.clientY);
				const t = tidF ? d?.tracks.find((x) => x.id === tidF) : undefined;
				const id = t && !t.locked ? t.id : null;
				setDropHint((cur) => (cur === id ? cur : id));
				return;
			}
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			// ⚠ dragover 期间 dataTransfer.getData 恒为空（浏览器保护模式）→ 此刻只能按轨道类型预判「可替换」，
			//   素材与轨道类型是否真的相容留到 drop 时校验（不相容则回落到「新增片段」路径）。
			const hit = replaceTargetFromEvent(e);
			setReplaceHint((cur) => (cur === (hit?.segId ?? null) ? cur : hit?.segId ?? null));
			const d = activeDocNow();
			const tidA = hit ? null : trackIdFromY(e.clientY);
			const t = tidA ? d?.tracks.find((x) => x.id === tidA) : undefined;
			const id = t && !t.locked ? t.id : null;
			setDropHint((cur) => (cur === id ? cur : id));
		},
		[trackIdFromY, replaceTargetFromEvent],
	);
	const onDragLeave = useCallback((e: React.DragEvent) => {
		if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
			setDropHint(null);
			setReplaceHint(null);
		}
	}, []);
	const onDrop = useCallback(
		(e: React.DragEvent) => {
			setDropHint(null);
			setReplaceHint(null);
			const raw = e.dataTransfer.getData(ASSET_MIME) || e.dataTransfer.getData("text/plain");
			if (!raw) {
				// 外部文件拖入：先登记素材库（与左栏「本地导入」同链），再按落点入轨——素材库与时间轨同时出现
				const files = Array.from(e.dataTransfer.files ?? []).filter((f) => uploadKindFromFile(f) !== "script");
				if (!files.length) return;
				e.preventDefault();
				const dropUs = eventUs(e.clientX);
				const preferId = trackIdFromY(e.clientY) ?? undefined;
				void importDroppedFiles(files, dropUs, preferId);
				return;
			}
			const asset = parseAssetPayload(raw);
			if (!asset) return;
			e.preventDefault();
			// ① 落在已有片段上 + 类型相容 → **原位替换**（不新增不删除片段，符合「不无缘无故增删」）
			const hit = replaceTargetFromEvent(e);
			if (hit && trackTypeForMedia(asset.media) === hit.trackType) {
				void replaceSegmentWithAsset(hit.segId, asset);
				return;
			}
			// ② 否则走原有「落到合适轨道新增片段」
			const dropUs = eventUs(e.clientX);
			const preferId = trackIdFromY(e.clientY) ?? undefined;
			void placeDroppedAsset(asset, dropUs, preferId);
		},
		[eventUs, trackIdFromY, replaceTargetFromEvent],
	);

	/* ── 轨道头操作（第四批：走 commitActive——子层编辑时操作的是子文档轨道） ── */
	const toggleMute = useCallback((id: string) => {
		commitActiveNow((d) => setTrackProps(d, id, { muted: !d.tracks.find((t) => t.id === id)?.muted }));
	}, []);
	const toggleLock = useCallback((id: string) => {
		commitActiveNow((d) => setTrackProps(d, id, { locked: !d.tracks.find((t) => t.id === id)?.locked }));
	}, []);
	const removeTrackById = useCallback((id: string) => {
		commitActiveNow((d) => removeTrack(d, id));
	}, []);
	/** 轨道重命名（空串=清除自定义名回落默认；值没变则不 commit，不污染撤销栈） */
	const renameTrack = useCallback((id: string, name: string) => {
		commitActiveNow((d) => {
			const cur = d.tracks.find((t) => t.id === id);
			if (!cur || (cur.name ?? "") === name) return d;
			return setTrackProps(d, id, { name: name || undefined });
		});
	}, []);

	const onSegContextMenu = useCallback(
		(e: React.MouseEvent, seg: RtcSegment) => {
			const track = renderDoc?.tracks.find((t) => t.segments.some((s) => s.id === seg.id));
			if (!track) return;
			/* 右键不经 pointerdown（那里只认左键），故基础剪辑项执行前先确保本片段在选区里：
			 * 已在多选中 → 对整批生效；不在 → 收敛为单选它自己。之后一律复用 rtcEditActions。 */
			const ensureSelected = () => {
				const st = useRtcStore.getState();
				// 带 groupId 的片段按整组选中（右键删除/复制对整组生效，与点击选中同语义）
				if (!st.selection.includes(seg.id)) {
					st.setSelection(st.doc ? expandSelectionWithGroups(st.doc, [seg.id]) : [seg.id]);
				}
			};
			setSegMenu({
				x: e.clientX,
				y: e.clientY,
				seg,
				track,
				onClose: () => setSegMenu(null),
				onSplit: () => {
					commitActiveNow((d) => splitSegment(d, seg.id, seg.targetStartUs + seg.targetDurationUs / 2));
				},
				onDelete: () => {
					commitActiveNow((d) => pruneEmptyTracks(removeSegments(d, [seg.id]))); // 空轨自动回收
				},
				onRippleDelete: () => { ensureSelected(); rippleDeleteSelection(); },
				onCopy: () => { ensureSelected(); copySelection(); },
				onCut: () => { ensureSelected(); cutSelection(); },
				onDuplicate: () => { ensureSelected(); duplicateSelection(); },
				// 超分 / 去字幕 / 音频分离 / 重新生成——不适用的动作 build 不返回，菜单里自然不显示
				...segActions.build(seg, track),
			});
		},
		[renderDoc, segActions],
	);

	/* 第三批：text 轨空白**双击** → 在双击处添加字幕片段（默认 3 秒「双击编辑字幕」，自动选中）。
	 * 片段/按钮/标尺上的双击不劫持；非 text 轨双击不响应（保持既有行为零变化）。 */
	const onBlankDoubleClick = useCallback(
		(e: React.MouseEvent) => {
			const target = e.target as HTMLElement;
			if (target.closest("[data-seg]") || target.closest("button") || target.closest("[data-hdr]") || target.closest("[data-ruler]")) return;
			const tid = trackIdFromY(e.clientY);
			const t = tid ? activeDocNow()?.tracks.find((x) => x.id === tid) : undefined;
			if (!t || t.type !== "text" || t.locked) return;
			addSubtitleSegmentAt(t.id, eventUs(e.clientX));
		},
		[trackIdFromY, eventUs],
	);

	/* 轨道空白处右键 → 「添加占位」菜单。片段上的右键已被 SegmentView 内 stopPropagation 截走，
	 * 所以到这里的一定是空白落点。轨道行外（标尺/底部空白）或该轨无可添加项时不弹，交回浏览器默认。 */
	const onBlankContextMenu = useCallback(
		(e: React.MouseEvent) => {
			const tid = trackIdFromY(e.clientY);
			const track = tid ? activeDocNow()?.tracks.find((x) => x.id === tid) : undefined;
			if (!track) return;
			if (blankActions.open(e.clientX, e.clientY, track.id, eventUs(e.clientX))) e.preventDefault();
		},
		[blankActions, eventUs, trackIdFromY],
	);

	/* ── 渲染 ── */
	if (!renderDoc) {
		return (
			// 高度跟随父容器（FrameEditor 按 rtcLayout.timelineHeight 控制，splitter 可拖 20vh–60vh）
			<div className="h-full flex items-center justify-center bg-secondary/20">
				<span className="text-xs text-muted-foreground select-none">正在载入剪辑文档…</span>
			</div>
		);
	}
	const durationUs = docDurationUs(renderDoc);
	// 内容宽度下限 90 秒（初始空轴即有 90s 可视刻度，对标剪映）；有内容时再留 30s 尾部余量
	const contentSec = Math.max(90, Math.ceil(durationUs / US_PER_SEC) + 30);
	const widthPx = Math.max(contentSec * pxPerSec, viewportW - HEADER_W);
	const isEmpty = renderDoc.tracks.every((t) => t.segments.length === 0);

	return (
		// 点击时间轨任意处（轨道/标尺/片段/轨道头）即清除左栏素材选中——中栏预览让回时间指针（capture 级，先于内部手势）
		<div
			className="h-full flex flex-col bg-secondary/20 select-none"
			onPointerDownCapture={() => useRtcAssetSelStore.getState().clear()}
		>
			{/* 第四批：复合片段编辑上下文面包屑（仅子层编辑时出现） */}
			<RtcCompoundBreadcrumb />
			<div ref={scrollRef} className="flex-1 overflow-auto overscroll-contain">
				<div
					ref={contentRef}
					className="relative"
					style={{ width: HEADER_W + widthPx, minHeight: "100%" }}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
					onDragOver={onDragOver}
					onDragLeave={onDragLeave}
					onDrop={onDrop}
					onContextMenu={onBlankContextMenu}
					onDoubleClick={onBlankDoubleClick}
				>
					<div className="sticky top-0 z-30 flex" style={{ height: RULER_H }}>
						{/* 角块：第三批起放「＋字幕」入口（工具栏加轨按钮归并行任务独占，字幕入口收在这里） */}
						<div
							data-hdr
							className="sticky left-0 z-40 shrink-0 bg-[#12141a] border-r border-b border-white/10 flex items-center justify-center"
							style={{ width: HEADER_W, height: RULER_H }}
						>
							<button
								type="button"
								title="在播放头处添加字幕片段（没有字幕轨时自动新建一条）"
								onClick={() => addSubtitleAtPlayhead()}
								className="h-5 px-2 rounded text-[10px] text-muted-foreground hover:bg-white/10 hover:text-secondary-foreground border border-white/10"
							>
								＋字幕
							</button>
						</div>
						<RtcRuler widthPx={widthPx} pxPerSec={pxPerSec} />
					</div>
					{/* 原文参考车道（补充10 定稿）：**实时派生自主轨分镜原文**的只读参考行——非轨道数据、
					 * 不落盘不导出；整行 pointer-events-none：点击/框选/拖放穿透到空白语义，绝不参与剪辑。
					 * sticky 钉在标尺下（z-21 < 主轨 22 < 标尺 30），主轨 sticky top 让位 laneH。 */}
					{laneH > 0 && (
						<div className="flex sticky z-[21] pointer-events-none" style={{ height: laneH, top: RULER_H }}>
							<div
								className="sticky left-0 z-20 shrink-0 flex items-center gap-1.5 px-2 bg-[#12141a] border-r border-b border-white/10"
								style={{ width: HEADER_W, height: laneH }}
							>
								<span className="text-[11px] text-muted-foreground truncate">原文</span>
								<span className="text-[9px] text-muted-foreground/60 shrink-0">参考 · 跟随主轨</span>
							</div>
							<div className="relative border-b border-white/5 bg-[#0f1116]" style={{ width: widthPx, height: laneH }}>
								{scriptLane.map((it) => (
									<div
										key={it.key}
										className="absolute inset-y-1 rounded-sm border border-white/10 bg-white/[0.06] overflow-hidden flex items-center px-1.5"
										style={{
											left: (it.startUs / US_PER_SEC) * pxPerSec,
											width: Math.max(2, (it.durUs / US_PER_SEC) * pxPerSec),
										}}
										title={it.text}
									>
										<span className="text-[10px] leading-tight text-white/70 truncate">{it.text}</span>
									</div>
								))}
							</div>
						</div>
					)}
					{displayTracks.map((t) => {
						/* 主轨常驻（剪映式）：sticky 钉在滚动视口内——上不越 标尺+原文车道（top=RULER_H+laneH）、下不出底边
						 * （bottom:0），普通滚轮上下翻其它轨道时主轨始终可见。z=22 介于 轨道头(20) 与 标尺(30)
						 * 之间=钉住时盖过被滚走的行；不透明底防下层行透出；行内再画一段自己的播放头线
						 * （全局线 z-10 在钉住的主轨之下，行内线在本行叠层里补齐、且仍在本行 sticky 轨道头之下）。 */
						const isMain = t.id === mainTrackId;
						const rowH = rowHeightOf(t); // 文本轨半高（rowTops 同一口径）
						return (
							<div
								key={t.id}
								className={isMain ? "flex sticky z-[22] bg-[#0f1116]" : "flex"}
								style={isMain ? { height: rowH, top: RULER_H + laneH, bottom: 0 } : { height: rowH }}
							>
								<RtcTrackHeader
									track={t}
									heightPx={rowH}
									isMain={isMain}
									onToggleMute={toggleMute}
									onToggleLock={toggleLock}
									onRemove={removeTrackById}
									onRename={renameTrack}
								/>
								<RtcTrackLane
									track={t}
									heightPx={rowH}
									pxPerSec={pxPerSec}
									widthPx={widthPx}
									selection={selection}
									dropActive={dropHint === t.id}
									coveredSegIds={coveredIds}
									replaceTargetSegId={replaceHint ?? undefined}
									onSegContextMenu={onSegContextMenu}
								/>
								{isMain && <PlayheadLine />}
							</div>
						);
					})}
					{/* 缝隙高亮：拖动中悬停满 GAP_DWELL_MS 的合法缝隙 → 松手在此新建轨道 */}
					{/* 拖动落点预览（白色半透明=松手将落下的合法位置）+ 跟手幽灵条——z 23/24 盖过 sticky 主轨(22) */}
					{moveGhost?.slot && (
						<div
							className="absolute z-[23] rounded-md bg-white/20 border border-white/50 pointer-events-none"
							style={{ left: moveGhost.slot.left, top: moveGhost.slot.top + 4, width: moveGhost.slot.width, height: moveGhost.slot.height }}
						/>
					)}
					{moveGhost && (
						<div
							className="absolute z-[24] rounded-md bg-teal-400/40 border border-white/80 shadow-lg pointer-events-none overflow-hidden"
							style={{ left: moveGhost.ghost.left, top: moveGhost.ghost.top, width: moveGhost.ghost.width, height: moveGhost.ghost.height }}
						>
							<div className="px-1.5 pt-0.5 text-[11px] text-white/90 truncate">{moveGhost.ghost.label}</div>
						</div>
					)}
					{/* 框选矩形（空白拖动多选，用户定稿） */}
					{marquee && marquee.width + marquee.height > 4 && (
						<div
							className="absolute z-[25] pointer-events-none rounded-sm"
							style={{
								left: marquee.left,
								top: marquee.top,
								width: marquee.width,
								height: marquee.height,
								border: "1px dashed var(--primary)",
								background: "color-mix(in srgb, var(--primary) 10%, transparent)",
							}}
						/>
					)}
					{newTrackHint && (
						<div
							className="absolute z-20 pointer-events-none"
							style={{ left: HEADER_W, top: newTrackHint.topPx - 2, width: widthPx, height: 4 }}
						>
							<div
								className="h-full w-full rounded-full"
								style={{ background: "var(--primary)", boxShadow: "0 0 8px var(--primary)" }}
							/>
							<span
								className="absolute left-2 -top-2 px-1.5 rounded-sm text-[10px] leading-[16px] text-white whitespace-nowrap"
								style={{ background: "var(--primary)" }}
							>
								松手新建{TRACK_LABELS[newTrackHint.type]}轨道
							</span>
						</div>
					)}
					<PlayheadLine />
					{isEmpty && (
						<div
							className="absolute pointer-events-none"
							style={{ left: HEADER_W + 24, top: RULER_H + 18 }}
						>
							<span className="text-xs text-muted-foreground">
								从素材面板拖入素材到轨道开始剪辑（视频/音频取真实时长，图片默认时长可在设置中调整）
							</span>
						</div>
					)}
				</div>
			</div>
			{segMenu && <RtcSegContextMenu {...segMenu} />}
			{segActions.modals}
			{blankActions.menu}
		</div>
	);
}

/**
 * 素材拖到已有片段上 → **原位替换**（剪映「替换」语义，见 rtcOps.replaceSegmentMedia）：
 * 位置不动、时长保持（新素材撑不满才收短）、不新增不删除片段；一次 commit = 一条 undo。
 */
async function replaceSegmentWithAsset(segId: string, asset: DroppedAsset) {
	let sourceTotalUs = 0;
	if (asset.media !== "image" && asset.probeUri) {
		const sec = await probeMediaDurationSec(asset.probeUri, asset.media);
		if (sec > 0) sourceTotalUs = Math.round(sec * US_PER_SEC);
	}
	commitActiveNow((d) =>
		replaceSegmentMedia(d, segId, {
			media: asset.media,
			...(asset.assetId ? { assetId: asset.assetId } : {}),
			...(asset.displayUri ? { uri: asset.displayUri } : {}),
			...(asset.name ? { name: asset.name } : {}),
			sourceTotalUs,
		}),
	);
	useRtcStore.getState().setSelection([segId]);
}

/** 拖放落轨：视频/音频先探测真实时长再入轨（source 窗口 = [0, 素材全长]）；图片 3 秒无源窗口。
 *  轨道匹配：落点轨道类型匹配且未锁 → 用它；否则首条匹配轨；再没有 → 同一 commit 里新建匹配轨。 */
async function placeDroppedAsset(asset: DroppedAsset, dropUs: number, preferTrackId?: string) {
	let durUs = imageDefaultUs(); // 图片默认时长走设置（rtcEditorSettingsStore，缺省 3s）
	let source: { sourceStartUs: number; sourceDurationUs: number } | null = null;
	if (asset.media !== "image") {
		const sec = asset.probeUri ? await probeMediaDurationSec(asset.probeUri, asset.media) : 0;
		if (sec > 0) {
			durUs = Math.max(MIN_SEGMENT_US, Math.round(sec * US_PER_SEC));
			source = { sourceStartUs: 0, sourceDurationUs: durUs };
		} else {
			durUs = MEDIA_FALLBACK_US; // 探测失败：回退时长且不建 source 窗口（trim 不受虚假源长约束）
		}
	}
	const st = useRtcStore.getState();
	const wanted = trackTypeForMedia(asset.media);
	const segId = genId("seg");
	commitActiveNow((d) => {
		let next = d;
		let track = preferTrackId ? next.tracks.find((t) => t.id === preferTrackId) : undefined;
		if (!track || track.type !== wanted || track.locked) {
			track = next.tracks.find((t) => t.type === wanted && !t.locked);
		}
		let trackId = track?.id;
		if (!trackId) {
			const created = createRtcTrack(wanted);
			next = { ...next, tracks: [...next.tracks, created] };
			trackId = created.id;
		}
		let startUs = dropUs;
		if (st.snapOn) {
			startUs = Math.max(
				0,
				snapSegmentStart(snapCandidates(next), dropUs, durUs, (SNAP_PX / st.pxPerSec) * US_PER_SEC),
			);
		}
		const seg: RtcSegment = {
			id: segId,
			kind: "media",
			media: asset.media,
			...(asset.name ? { name: asset.name } : {}),
			...(asset.assetId ? { assetId: asset.assetId } : {}),
			...(asset.displayUri ? { uri: asset.displayUri } : {}),
			targetStartUs: startUs,
			targetDurationUs: durUs,
			...(source ?? {}),
		};
		return addSegment(next, trackId, seg);
	});
	useRtcStore.getState().setSelection([segId]);
}

/**
 * 外部文件拖入时间轨（用户定稿）：**素材库与时间轨同时出现**——逐文件先走懒上传登记素材库
 * （uploadMediaToCanvasAsset：LC- 本地资产零网络 + libraryStore.addAsset，与左栏「本地导入」
 * 完全同链），再按落点走 placeDroppedAsset 入轨（时长探测/轨道匹配/夹隙与内部拖放同一条路）。
 * 多文件落同一位置时由 addSegment 逐条夹到最近空隙（顺序排开）；单个失败不阻断其余。
 */
async function importDroppedFiles(files: File[], dropUs: number, preferTrackId?: string) {
	for (const f of files) {
		const kind = uploadKindFromFile(f);
		if (kind === "script") continue;
		const name = f.name.replace(/\.[^.]+$/, "");
		try {
			const up = await uploadMediaToCanvasAsset(f);
			const ps = useProjectStore.getState();
			useLibraryStore.getState().addAsset({
				id: up.assetId, kind, name, uri: up.displayUri,
				serverAssetId: up.assetId, thumbnailUri: kind === "image" ? up.displayUri : null,
				createdAt: new Date().toISOString(), deletedByUser: false, localPath: up.localPath,
				origin: "upload",
				episodeId: resolveEpisodeKey(ps.rtcEpisodeId, ps.episodes) || null, // 分集化：导入归当前分集
			});
			// doc 里的 uri 不收 data:/blob:（与 parseAssetPayload 同规——blob 重载即死，不入落盘数据）
			const displayUri = /^(data|blob):/i.test(up.displayUri) ? undefined : up.displayUri;
			await placeDroppedAsset(
				{ media: kind, name, assetId: up.assetId, displayUri, probeUri: up.displayUri },
				dropUs,
				preferTrackId,
			);
		} catch (err) {
			console.warn("[rtc] 外部文件入轨失败", f.name, err);
		}
	}
}
