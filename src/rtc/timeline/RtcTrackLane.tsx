/**
 * 轨道行 + 片段渲染：绝对定位 div（left/width = us × pxPerSec ÷ 1e6）。
 *
 * 【架构语义（用户定稿，渲染侧的依据）】
 *   轨道 = AI 生成结果的存放位置，**不无缘无故增删**：一切「准备生成 / 正在生成」的内容都以
 *   **结果占位片段**（kind="placeholder"）躺在轨道上；重新生成不覆盖原结果，而是在**上方轨道**
 *   新增一个占位（上下层即版本堆叠）。导出导出时间轴全部，播放只看得见最上层的视频/图片——
 *   因此下层被完全遮挡的片段要有「不生效但保留着」的视觉提示（covered）。
 *
 * 片段内部为**纵向 flex 三段**（剪映观感，随 ROW_H 自适应，不写死像素分配）：
 *   ① 标题条：产物类型/「镜」章/「新版」角标 + 文件名 + 右侧时长（窄片段自动省略）；
 *   ② 预览区（flex:1）：视频=按时间点**平铺的小缩略图**、图片=同图平铺、音频=大波形；
 *      占位片段则按 status 显示 待生成 / 进度条 / 失败；
 *   ③ 波形条（视频专用，12~16px）：视频自带音轨的青色波形，解不出用淡色占位形态。
 *
 * 【性能保护】
 *   - **视口内才抽帧/解码/跑动效**（IntersectionObserver，rootMargin 240px）：滚出去零开销；
 *   - 抽帧张数按片段像素宽度算（约 80px 一张，上限 14），窄于 28px 不抽；
 *   - 时间点经 planFrameTimes **量化到固定网格**，缩放改变张数时多数点直接命中缓存；
 *   - 先用同步缓存铺满（零闪烁），缺帧的才走 requestIdleCallback 错峰抽取；
 *   - 波形按**固定桶数解码一次**，显示时 resamplePeaks 本地降采样，缩放不触发重解码；
 *   - ⚠ 生成中动效只作用在**该片段自己的一个元素**上，且只动 transform/opacity
 *     （CLAUDE.md §9 画布性能规则：不做常驻逐帧重绘的东西）。
 * ⚠ 红线：缩略图 dataURL / 峰值数组只存在运行时模块缓存里，绝不写回 RtcSegment 或项目文件。
 *
 * 交互不在此处理——data-seg / data-edge / data-track-id 供 RtcTimeline 集中派发。
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Clock, Film, GitBranch, Image as ImageIcon, Layers, Music } from "lucide-react";
import type { RtcSegment, RtcTrack, RtcTrackType } from "@/types/rtc";
import { useRtcStore } from "@/store/rtcStore";
import { ensureVideoDuration } from "@/store/videoDurationStore";
import {
	getCachedPeaks,
	getAudioPeaks,
	pseudoPeaks,
	resamplePeaks,
	barsForWidth,
	WAVE_BUCKETS,
} from "@/lib/audioPeaks";
import { getCachedFrame, getVideoFrames, planFrameTimes } from "@/lib/videoThumb";
import { allKeyframeTimes } from "@/lib/rtcKeyframes"; // ── 第二批：片段上的关键帧小菱形
import { ROW_H, TRACK_COLORS } from "./timelineUtil";

const US_PER_SEC = 1_000_000;
/** 波形色（青，对齐剪映观感）；解不出音轨时用淡灰占位，避免假波形误导 */
const WAVE_COLOR = "rgba(94,234,212,0.78)";
const WAVE_COLOR_FADED = "rgba(148,163,184,0.26)";
/** 失败态描边 */
const DANGER_COLOR = "#f87171";
/** 标题条高度（px，固定；预览区吃 flex:1 自适应 ROW_H 56~72） */
const TITLE_H = 13;
/** 窄片段阈值：低于此宽度只留图标/进度条，不显示状态文案 */
const COMPACT_PX = 56;
/** 视频片段底部波形条高度：随片段高度在 12~16 间取 */
function waveBarH(segH: number) {
	return Math.round(Math.max(12, Math.min(16, segH * 0.28)));
}

/* ══════════════════ 状态 → 展示形态（纯函数，可单测） ══════════════════ */

export type SegVisualKind = "media" | "pending" | "running" | "failed";

export interface SegVisual {
	/** 展示形态：真实素材 / 待生成 / 生成中 / 失败 */
	kind: SegVisualKind;
	/** 状态文案（media 为空串） */
	statusText: string;
	/** 占位要生成的产物类型（取不到时回退片段自身 media，再取不到为 null）。
	 *  ⚠ 类型从 RtcSegment 派生——types 侧扩枚举（如新增 "shot"）时这里零改动，
	 *  GenIcon 对认不出的类型回退通用图标。 */
	genKind: NonNullable<RtcSegment["genKind"]> | NonNullable<RtcSegment["media"]> | null;
	/** 归一化进度 0–100；null=不确定态（画流动条纹） */
	progress: number | null;
	/** 是否画进度条 */
	showProgressBar: boolean;
	/** 是否显示百分比数字（窄片段省略） */
	showPercent: boolean;
	/** 虚线边框（待生成/生成中） */
	dashed: boolean;
	/** 失败态（红色描边） */
	danger: boolean;
	/** 分镜占位（有 shotRef，显示「镜」章） */
	isShot: boolean;
	/** 版本堆叠：本占位是某条结果的「重新生成」 */
	isVersion: boolean;
	/** 窄片段：省略文案 */
	compact: boolean;
	/** 悬浮提示（含失败原因/版本说明） */
	title: string;
}

/**
 * 片段 → 展示形态。status 只在占位片段上有意义（生成成功=落成 media 并清空该组字段），
 * 但 media 片段若带着 status 也照常呈现（防御式，不静默吞掉状态）。
 */
export function describeSegment(seg: RtcSegment, widthPx: number): SegVisual {
	const isPh = seg.kind === "placeholder";
	const status: SegVisualKind = seg.status ?? (isPh ? "pending" : "media");
	const raw = seg.progress;
	const progress =
		status === "running" && typeof raw === "number" && Number.isFinite(raw)
			? Math.max(0, Math.min(100, Math.round(raw)))
			: null;
	const compact = !Number.isFinite(widthPx) || widthPx < COMPACT_PX;
	// 第四批：复合片段的名字回退与提示（视觉上按 media 形态走，预览区另有专属标识）
	const isCompound = seg.kind === "compound";
	const name = seg.name || (isPh ? "结果占位" : isCompound ? "复合片段" : "素材");
	const statusText =
		status === "pending" ? "待生成" : status === "running" ? "生成中" : status === "failed" ? "生成失败" : "";
	const isVersion = !!seg.originSegId;
	const parts = [name];
	if (statusText) parts.push(progress !== null ? `${statusText} ${progress}%` : statusText);
	if (status === "failed" && seg.error) parts.push(seg.error);
	if (isVersion) parts.push("重新生成的新版本");
	if (isCompound) parts.push("复合片段 · 双击进入编辑");
	return {
		kind: status,
		statusText,
		genKind: seg.genKind ?? seg.media ?? null,
		progress,
		showProgressBar: status === "running",
		showPercent: status === "running" && progress !== null && !compact,
		dashed: status === "pending" || status === "running",
		danger: status === "failed",
		isShot: !!seg.shotRef,
		isVersion,
		compact,
		title: parts.join(" · "),
	};
}

/* ══════════════════ 动效样式（模块级注入一次，只动 transform/opacity） ══════════════════ */

let animStyleInjected = false;
function ensureAnimStyle() {
	if (animStyleInjected || typeof document === "undefined") return;
	animStyleInjected = true;
	const el = document.createElement("style");
	el.dataset.qiji = "rtc-seg-anim";
	el.textContent =
		"@keyframes qijiRtcStripe{from{transform:translateX(-50%)}to{transform:translateX(0)}}" +
		"@keyframes qijiRtcBreath{0%,100%{opacity:.62}50%{opacity:1}}";
	document.head.appendChild(el);
}

/** 空闲错峰调度：避免几十段同时抽帧/解码卡死 UI */
function scheduleIdle(cb: () => void): () => void {
	const w = window as unknown as {
		requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
		cancelIdleCallback?: (h: number) => void;
	};
	if (typeof w.requestIdleCallback === "function") {
		const id = w.requestIdleCallback(cb, { timeout: 1500 });
		return () => w.cancelIdleCallback?.(id);
	}
	const id = window.setTimeout(cb, 80);
	return () => window.clearTimeout(id);
}

/** 片段是否在视口内（含 240px 预取边距）——不在视口一律不抽帧、不解码、不跑动效 */
function useInView(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
	const [inView, setInView] = useState(false);
	useEffect(() => {
		if (!enabled) return;
		const el = ref.current;
		if (!el) return;
		if (typeof IntersectionObserver === "undefined") { setInView(true); return; }
		const io = new IntersectionObserver(
			(entries) => { for (const e of entries) setInView(e.isIntersecting); },
			{ rootMargin: "240px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [ref, enabled]);
	return inView;
}

/** 时长文本（标题条右侧，窄片段不显示） */
function fmtDur(us: number) {
	const s = Math.max(0, us) / US_PER_SEC;
	if (s < 60) return `${s.toFixed(1)}s`;
	return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

/** 产物类型图标 */
function GenIcon({ kind, size = 9, color }: { kind: SegVisual["genKind"]; size?: number; color?: string }) {
	const P = { size, color, strokeWidth: 2 } as const;
	if (kind === "image") return <ImageIcon {...P} />;
	if (kind === "audio") return <Music {...P} />;
	if (kind === "video") return <Film {...P} />;
	return <Clock {...P} />;
}

/**
 * 片段预览数据：视频缩略图序列 + 波形峰值。
 * frames 长度恒等于要平铺的格子数（未抽到的格子为 null，显示占位底色）。
 */
function useSegmentPreview(seg: RtcSegment, widthPx: number, inView: boolean) {
	const uri = seg.uri || "";
	const isMedia = seg.kind === "media" && !!uri;
	const isVideo = isMedia && seg.media === "video";
	const isAudio = isMedia && seg.media === "audio";
	// source 窗口（裁剪过的片段要显示窗口内的帧）；缺省按 [0, target 时长)
	const srcStart = (seg.sourceStartUs ?? 0) / US_PER_SEC;
	const srcDur = (seg.sourceDurationUs ?? seg.targetDurationUs) / US_PER_SEC;

	const times = useMemo(
		() => (isVideo ? planFrameTimes(widthPx, srcStart, srcDur) : []),
		[isVideo, widthPx, srcStart, srcDur],
	);
	const timesKey = times.join(",");

	const [frames, setFrames] = useState<(string | null)[]>([]);
	const [peaks, setPeaks] = useState<number[] | null>(null);
	const [peaksFaded, setPeaksFaded] = useState(false);

	/* 缩略图：先同步铺缓存（缩放时零闪烁），缺帧的才排队抽 */
	useEffect(() => {
		if (!isVideo || !times.length) { setFrames([]); return; }
		const cachedNow = times.map((t) => getCachedFrame(uri, t) ?? null);
		setFrames(cachedNow);
		if (!inView) return;
		if (times.every((t) => getCachedFrame(uri, t) !== undefined)) return;
		let alive = true;
		const cancel = scheduleIdle(() => {
			void getVideoFrames(uri, times).then((r) => { if (alive) setFrames(r); });
		});
		return () => { alive = false; cancel(); };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isVideo, uri, timesKey, inView]);

	/* 波形：视频与音频都取（视频片段底部显示自带音轨）；固定桶数解码一次 */
	useEffect(() => {
		if (!isVideo && !isAudio) { setPeaks(null); return; }
		const cached = getCachedPeaks(uri, WAVE_BUCKETS);
		if (cached !== undefined) {
			setPeaks(cached ?? pseudoPeaks(uri, WAVE_BUCKETS));
			setPeaksFaded(cached === null);
			return;
		}
		if (!inView) return;
		let alive = true;
		const cancel = scheduleIdle(() => {
			void getAudioPeaks(uri, WAVE_BUCKETS).then((r) => {
				if (!alive) return;
				setPeaks(r ?? pseudoPeaks(uri, WAVE_BUCKETS));
				setPeaksFaded(r === null); // 解码明确失败=淡色占位，不冒充真波形
			});
		});
		return () => { alive = false; cancel(); };
	}, [isVideo, isAudio, uri, inView]);

	/* 显示用桶数按宽度本地降采样（不重新解码） */
	const shownPeaks = useMemo(
		() => (peaks ? resamplePeaks(peaks, barsForWidth(widthPx)) : null),
		[peaks, widthPx],
	);

	return { frames, peaks: shownPeaks, peaksFaded };
}

const SegmentView = memo(function SegmentView({
	seg,
	trackType,
	rowH = ROW_H,
	pxPerSec,
	selected,
	muted,
	covered = false,
	replaceTarget = false,
	onContextMenu,
}: {
	seg: RtcSegment;
	trackType: RtcTrackType;
	/** 所在轨行高（文本轨半高→片段高随行高；缺省=ROW_H 旧观感零变化） */
	rowH?: number;
	pxPerSec: number;
	selected: boolean;
	muted: boolean;
	/** 被上层轨道的视频/图片完全遮挡：播放时不生效但保留在时间轴上（覆盖关系由 RtcTimeline 算好传入） */
	covered?: boolean;
	/** 素材正拖到本片段上、松手将「原位替换」它：dragover 期间的落点提示（由 RtcTimeline 判定） */
	replaceTarget?: boolean;
	onContextMenu?: (e: React.MouseEvent, seg: RtcSegment) => void;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (seg.kind === "media" && (seg.media === "video" || seg.media === "audio") && seg.uri) {
			ensureVideoDuration(seg.uri);
		}
	}, [seg.kind, seg.media, seg.uri]);

	const left = (seg.targetStartUs / US_PER_SEC) * pxPerSec;
	const width = Math.max(2, (seg.targetDurationUs / US_PER_SEC) * pxPerSec);
	/** 半高文本轨：上下留白收窄（12→8），内容区尽量留给文字 */
	const slim = rowH < 48;
	const segH = rowH - (slim ? 8 : 12);
	const color = TRACK_COLORS[trackType];
	const v = describeSegment(seg, width);
	const isPh = v.kind !== "media";
	const isCompound = seg.kind === "compound"; // 第四批：复合片段（双击进入子时间轴编辑）
	const isVideo = seg.kind === "media" && seg.media === "video" && !!seg.uri;
	const isAudio = seg.kind === "media" && seg.media === "audio" && !!seg.uri;
	const isImage = seg.kind === "media" && seg.media === "image" && !!seg.uri;

	// 视口内才抽帧/解码/跑动效
	const needInView = isVideo || isAudio || v.kind === "running";
	const inView = useInView(rootRef, needInView);
	const { frames, peaks, peaksFaded } = useSegmentPreview(seg, width, inView);

	useEffect(() => { if (v.kind === "running") ensureAnimStyle(); }, [v.kind]);

	const label = seg.name || (isPh ? "结果占位" : "素材");
	const edgeColor = v.danger ? DANGER_COLOR : selected ? "var(--primary)" : color;
	const handleCls =
		"absolute top-0 bottom-0 w-[7px] cursor-ew-resize bg-white/25 transition-opacity z-10 " +
		(selected ? "opacity-100" : "opacity-0 group-hover/seg:opacity-100");

	const baseBg = isPh
		? v.danger
			? "color-mix(in srgb, #f87171 12%, transparent)"
			: `color-mix(in srgb, ${color} 10%, transparent)`
		: `color-mix(in srgb, ${color} 24%, #12141a)`;

	// 图片片段：同一张图平铺（宽片段也不留空白）
	const imageTiles = isImage ? Math.max(1, Math.min(8, Math.round(width / 80))) : 0;
	const showThumbStrip = isVideo && frames.length > 0;
	const showWaveBar = isVideo && !!peaks;
	const waveH = waveBarH(segH);
	const animate = inView; // 视口外不跑动效

	return (
		<div
			ref={rootRef}
			data-seg={seg.id}
			className="group/seg absolute rounded-[5px] overflow-hidden cursor-grab active:cursor-grabbing flex flex-col"
			style={{
				left,
				width,
				top: slim ? 4 : 6,
				height: segH,
				background: baseBg,
				border: v.dashed ? `1px dashed ${edgeColor}` : `1px solid ${
					v.danger || selected ? edgeColor : `color-mix(in srgb, ${color} 45%, transparent)`
				}`,
				// 替换目标优先级最高——它在指示「松手会发生什么」，压过选中/失败态的描边
				boxShadow: replaceTarget
					? "0 0 0 2px var(--primary), 0 0 12px rgba(139,92,246,0.55)"
					: selected
						? "0 0 0 1px var(--primary)"
						: v.danger
							? `0 0 0 1px ${DANGER_COLOR}`
							: undefined,
				// 被覆盖 / 轨道静音都做视觉弱化，两者叠加更淡；替换目标反而要提亮压过弱化
				opacity: replaceTarget ? 1 : covered ? (muted ? 0.4 : 0.55) : muted ? 0.55 : 1,
			}}
			onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(e, seg); }}
			// 第四批：双击复合片段 = 进入子时间轴编辑（enterCompound 自带存在性守卫）
			onDoubleClick={
				isCompound && seg.subDocId
					? (e) => { e.stopPropagation(); useRtcStore.getState().enterCompound(seg.subDocId!); }
					: undefined
			}
			title={
				replaceTarget
					? `${v.title} · 松手将用拖入的素材原位替换（位置与时长不变）`
					: covered
						? `${v.title} · 被上层覆盖（播放不生效，导出保留）`
						: v.title
			}
		>
			{/* ① 标题条（半高文本轨省略——内容文字直接铺片段，见 ② 预览区） */}
			{!slim && (
			<div
				className="relative shrink-0 flex items-center gap-1 px-1 text-[9px] leading-none pointer-events-none"
				style={{
					height: TITLE_H,
					background: isPh ? "rgba(8,10,14,0.30)" : "rgba(8,10,14,0.55)",
					color: selected ? "var(--foreground)" : "var(--secondary-foreground)",
				}}
			>
				{v.isShot && (
					<span
						className="shrink-0 px-1 rounded-sm border text-[9px] leading-[11px]"
						style={{ borderColor: edgeColor, color: edgeColor }}
					>
						镜
					</span>
				)}
				{isPh && !v.isShot && (
					<span className="shrink-0 flex items-center" style={{ color: edgeColor }}>
						<GenIcon kind={v.genKind} />
					</span>
				)}
				{isCompound && (
					<span className="shrink-0 flex items-center" style={{ color: edgeColor }} title="复合片段">
						<Layers size={9} />
					</span>
				)}
				{v.isVersion && (
					<span className="shrink-0 flex items-center opacity-70" title="重新生成的新版本">
						<GitBranch size={9} />
					</span>
				)}
				<span className="truncate">{label}</span>
				<span className="ml-auto shrink-0 flex items-center gap-1">
					{covered && width >= 48 && <Layers size={9} style={{ opacity: 0.75 }} />}
					{width >= 110 && <span className="opacity-60 tabular-nums">{fmtDur(seg.targetDurationUs)}</span>}
				</span>
			</div>
			)}

			{/* ② 预览 / 状态区 */}
			<div className="relative flex-1 min-h-0">
				{/* 文本片段：内容文字直接显示在片段块上（放不下截断；半高轨居中单行） */}
				{trackType === "text" && seg.text?.content && (
					<div className="absolute inset-0 flex items-center px-1.5 pointer-events-none">
						<span className="text-[10px] leading-tight text-white/85 truncate">{seg.text.content}</span>
					</div>
				)}
				{showThumbStrip && (
					<div className="absolute inset-0 flex">
						{frames.map((f, i) => (
							<div
								key={i}
								className="h-full min-w-0"
								style={{
									flex: "1 1 0",
									background: f ? `url(${f}) center/cover no-repeat` : "rgba(255,255,255,0.04)",
									borderRight: i < frames.length - 1 ? "1px solid rgba(0,0,0,0.28)" : undefined,
								}}
							/>
						))}
					</div>
				)}
				{isImage && (
					<div className="absolute inset-0 flex">
						{Array.from({ length: imageTiles }, (_, i) => (
							<div
								key={i}
								className="h-full min-w-0"
								style={{
									flex: "1 1 0",
									background: `url(${seg.uri}) center/cover no-repeat`,
									borderRight: i < imageTiles - 1 ? "1px solid rgba(0,0,0,0.28)" : undefined,
								}}
							/>
						))}
					</div>
				)}
				{/* 纯音频片段：波形铺满预览区 */}
				{isAudio && peaks && peaks.length > 0 && (
					<WaveformCanvas peaks={peaks} widthPx={width} faded={peaksFaded} />
				)}
				{/* 占位片段三态 */}
				{isPh && <PlaceholderBody v={v} color={color} animate={animate} />}
				{/* 第四批：复合片段——斜纹底 + 标识（双击进入子时间轴编辑） */}
				{isCompound && (
					<div
						className="absolute inset-0 pointer-events-none flex items-center justify-center"
						style={{
							background:
								"repeating-linear-gradient(135deg, rgba(139,92,246,0.12) 0 8px, rgba(139,92,246,0.03) 8px 16px)",
						}}
					>
						{!v.compact && (
							<span className="flex items-center gap-1 text-[9px]" style={{ color: edgeColor }}>
								<Layers size={9} /> 复合片段 · 双击进入
							</span>
						)}
					</div>
				)}
			</div>

			{/* ③ 视频自带音轨波形条 */}
			{showWaveBar && (
				<div
					className="relative shrink-0"
					style={{ height: waveH, background: "rgba(6,10,14,0.55)", borderTop: "1px solid rgba(0,0,0,0.3)" }}
				>
					<WaveformCanvas peaks={peaks!} widthPx={width} faded={peaksFaded} />
				</div>
			)}

			{/* 素材拖到本片段上：松手将原位替换——提亮遮罩 + 文案（不吃指针事件，别挡 drop 落点判定） */}
			{replaceTarget && (
				<div
					className="absolute inset-0 pointer-events-none flex items-center justify-center"
					style={{ background: "color-mix(in srgb, var(--primary) 22%, transparent)" }}
				>
					{width >= 72 && (
						<span
							className="px-1.5 py-0.5 rounded text-[9px] leading-none font-medium"
							style={{ background: "rgba(12,10,24,0.72)", color: "#fff" }}
						>
							替换
						</span>
					)}
				</div>
			)}

			{/* 被上层覆盖：斜纹底提示（叠在最上，不吃指针事件） */}
			{covered && (
				<div
					className="absolute inset-0 pointer-events-none"
					style={{
						background:
							"repeating-linear-gradient(45deg, rgba(0,0,0,0.30) 0 5px, rgba(0,0,0,0) 5px 11px)",
					}}
				/>
			)}

			{/* ── 第二批：关键帧小菱形（全部属性的时刻并集；仅视觉+点击跳转播放头，不做拖动） ── */}
			{seg.kind === "media" && <SegKeyframeDiamonds seg={seg} width={width} />}

			<div data-edge="start" className={handleCls} style={{ left: 0 }} />
			<div data-edge="end" className={handleCls} style={{ right: 0 }} />
		</div>
	);
});

/**
 * 片段上的关键帧小菱形：按 t / targetDurationUs 比例定位在片段下缘；
 * 点击 = 播放头跳到该关键帧时刻（stopPropagation 拦下时间轴的片段拖动手势）。
 * ⚠ 仅视觉与跳转——关键帧的增删改走属性面板菱形按钮 / lib/rtcKeyframes（本批不做拖帧）。
 */
const SegKeyframeDiamonds = memo(function SegKeyframeDiamonds({
	seg,
	width,
}: {
	seg: RtcSegment;
	width: number;
}) {
	const times = useMemo(() => allKeyframeTimes(seg), [seg]);
	if (times.length === 0 || !(seg.targetDurationUs > 0) || width < 24) return null;
	return (
		<div className="absolute inset-x-0 pointer-events-none" style={{ bottom: 2, height: 10, zIndex: 5 }}>
			{times.map((t) => {
				const leftPct = Math.min(100, Math.max(0, (t / seg.targetDurationUs) * 100));
				return (
					<div
						key={t}
						title="关键帧（点击跳转到此刻）"
						onPointerDown={(e) => {
							e.stopPropagation(); // 别触发片段拖动
							useRtcStore.getState().setPlayhead(seg.targetStartUs + t);
						}}
						className="absolute cursor-pointer"
						style={{
							left: `${leftPct}%`,
							top: 1,
							width: 7,
							height: 7,
							marginLeft: -3.5,
							transform: "rotate(45deg)",
							background: "#fff",
							border: "1px solid rgba(0,0,0,0.55)",
							borderRadius: 1,
							pointerEvents: "auto",
						}}
					/>
				);
			})}
		</div>
	);
});

/**
 * 结果占位片段的状态主体：待生成 / 生成中（进度条）/ 失败。
 * ⚠ 动效只挂在进度条这一个元素上，且只用 transform（流动条纹）与 opacity（呼吸）。
 */
const PlaceholderBody = memo(function PlaceholderBody({
	v,
	color,
	animate,
}: {
	v: SegVisual;
	color: string;
	animate: boolean;
}) {
	if (v.kind === "media") return null;
	const tint = v.danger ? DANGER_COLOR : color;
	return (
		<div className="absolute inset-0 flex flex-col items-center justify-center gap-[3px] px-1 pointer-events-none">
			{!v.compact && (
				<span className="flex items-center gap-1 text-[9px] leading-none truncate" style={{ color: tint }}>
					{v.kind === "failed" ? <AlertTriangle size={9} /> : <GenIcon kind={v.genKind} color={tint} />}
					<span className="truncate">
						{v.statusText}
						{v.showPercent ? ` ${v.progress}%` : ""}
					</span>
				</span>
			)}
			{v.showProgressBar && (
				<div
					className="w-full max-w-[160px] rounded-full overflow-hidden shrink-0"
					style={{ height: 4, background: "rgba(255,255,255,0.14)" }}
				>
					{v.progress !== null ? (
						<div
							className="h-full rounded-full"
							style={{
								width: `${v.progress}%`,
								background: color,
								animation: animate ? "qijiRtcBreath 1.8s ease-in-out infinite" : undefined,
							}}
						/>
					) : (
						// 不确定态：条纹整体平移（只动 transform，GPU 合成）
						<div
							className="h-full"
							style={{
								width: "200%",
								background: `repeating-linear-gradient(115deg, ${color} 0 7px, rgba(255,255,255,0.10) 7px 14px)`,
								opacity: 0.8,
								animation: animate ? "qijiRtcStripe 1.1s linear infinite" : undefined,
							}}
						/>
					)}
				</div>
			)}
		</div>
	);
});

/**
 * 波形画布：填满父容器；按父容器实测尺寸 × devicePixelRatio 重绘。
 * widthPx 作为依赖传入——片段宽度随缩放变化时必须重绘（父容器尺寸变化无事件可听）。
 */
const WaveformCanvas = memo(function WaveformCanvas({
	peaks,
	widthPx,
	faded,
}: {
	peaks: number[];
	widthPx: number;
	faded: boolean;
}) {
	const cvRef = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const cv = cvRef.current;
		if (!cv) return;
		const rect = cv.parentElement?.getBoundingClientRect();
		const W = Math.max(1, Math.round(rect?.width || widthPx));
		const H = Math.max(1, Math.round(rect?.height || 12));
		const dpr = window.devicePixelRatio || 1;
		cv.width = Math.round(W * dpr);
		cv.height = Math.round(H * dpr);
		cv.style.width = `${W}px`;
		cv.style.height = `${H}px`;
		const ctx = cv.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, W, H);
		ctx.fillStyle = faded ? WAVE_COLOR_FADED : WAVE_COLOR;
		const slot = W / peaks.length;
		const gap = slot > 2.5 ? 1 : 0;
		const bw = Math.max(0.6, slot - gap);
		for (let i = 0; i < peaks.length; i++) {
			const h = Math.max(1, peaks[i] * (H - 2));
			ctx.fillRect(i * slot, (H - h) / 2, bw, h);
		}
	}, [peaks, widthPx, faded]);
	return <canvas ref={cvRef} className="absolute inset-0 pointer-events-none" />;
});

export const RtcTrackLane = memo(function RtcTrackLane({
	track,
	heightPx = ROW_H,
	pxPerSec,
	widthPx,
	selection,
	dropActive,
	coveredSegIds,
	replaceTargetSegId,
	onSegContextMenu,
}: {
	track: RtcTrack;
	/** 行高（文本轨半高；缺省=ROW_H 旧观感零变化） */
	heightPx?: number;
	pxPerSec: number;
	widthPx: number;
	selection: string[];
	dropActive: boolean;
	/** 被上层视频/图片完全遮挡的片段 id（覆盖关系由 RtcTimeline 跨轨道算好；缺省=无覆盖） */
	coveredSegIds?: string[];
	/** 素材拖放中、松手会被「原位替换」的片段 id（由 RtcTimeline 按落点与类型相容性判定） */
	replaceTargetSegId?: string;
	onSegContextMenu?: (e: React.MouseEvent, seg: RtcSegment) => void;
}) {
	const coveredKey = coveredSegIds?.join(",") ?? "";
	const coveredSet = useMemo(
		() => (coveredKey ? new Set(coveredKey.split(",")) : null),
		[coveredKey],
	);
	return (
		<div
			data-track-id={track.id}
			className={`relative shrink-0 border-b border-white/5 ${track.locked ? "opacity-60" : ""}`}
			style={{
				width: widthPx,
				height: heightPx,
				background: dropActive ? "color-mix(in srgb, var(--primary) 9%, transparent)" : undefined,
			}}
		>
			{track.segments.map((s) => (
				<SegmentView
					key={s.id}
					seg={s}
					trackType={track.type}
					rowH={heightPx}
					pxPerSec={pxPerSec}
					selected={selection.includes(s.id)}
					muted={!!track.muted}
					covered={coveredSet?.has(s.id) ?? false}
					replaceTarget={replaceTargetSegId === s.id}
					onContextMenu={onSegContextMenu}
				/>
			))}
		</div>
	);
});
