/**
 * RtcSequencePlayer —— 实时剪辑中央区的预览播放器（对标剪映播放器：可编辑画面 + 下方功能条）。
 *
 * ⚠ 第235→236轮语义（勿当回归改回去）：**多视频轨图层合成预览**，不是「只放主轨」。
 * 第235轮刻意简化为「只放主轨、其余视频轨不参与预览」，用户实测报障：主轨在某时刻是空隙、
 * 上方视频轨明明有片段却黑屏——「需要图层概念，透过上面的看下面」。故：
 *
 *   - **每条 video 轨渲染一个常驻图层元素**，绝对定位铺满同一个 letterbox 框，z-index 按图层高低排
 *     （口径走 rtcPlayback.videoLayerTracksBottomUp → rtcOps.orderTracksForDisplay，与时间轴上下分层
 *     完全一致）；上层不透明处遮住下层、上层透明处（PNG / 带 alpha 的 WebM）由**浏览器逐层 alpha
 *     合成**透出下层——这正是用户要的图层语义，不需要我们自己画 canvas；
 *   - **占位片段不成层**（rtcPlayback 已过滤）：正在重新生成时预览继续放下层旧版本，不黑屏；
 *   - 声音：**所有未静音的视频层都出声**（与剪映一致，且我们导出是全导，两边行为对齐）
 *     + 音频轨元素池混音；
 *   - **定画幅（对标剪映）**：预览区按 `docCanvas(doc)` 的宽高比画一个 letterbox **画幅框**（框外纯黑
 *     留白），**所有图层都在这个框内合成**——画幅是成片边界，不是各层各自贴合容器。
 *     ⚠ 读画幅一律走 `docCanvas()`，勿自写 1920×1080 回退。
 *
 * ── 本轮新增（预览窗口做成真剪辑软件的样子）────────────────────────────────
 *   ① **图层按 `RtcSegment.transform` 渲染**：contain 铺满是**基准**，其上再叠加
 *      位移/旋转/缩放/镜像/不透明度（`rtcTransform.transformCss`）。⚠ 位移用百分比
 *      （基准=图层元素自身边框盒=画幅框）→ **渲染完全不依赖 JS 实测**；缺省变换恒返回 null，
 *      此时连 transform 属性都不写，与改造前逐字节一致（回归零风险）。
 *   ② **预览内直接编辑素材**：时间轴选中的片段若此刻在画面上，叠一层选中框（白色细边 + 四角/四边
 *      控制点 + 底部旋转手柄）——拖框内=移动、拖角=等比缩放、拖边=单向缩放、拖手柄=旋转。
 *      ⚠ 拖动全程只改**本地 draft 预览**，`pointerup` 才 `commit()` 一次（undo 粒度=一次手势，§9A）；
 *      ⚠ 只改 `transform` 一个字段，绝不动 targetStartUs/targetDurationUs/assetId/source 窗口；
 *      ⚠ 锁定轨道上的片段只描边不给手柄；图层元素本身仍 `pointerEvents:none`，
 *        交互全在独立的覆盖层上（控制框绝不吃掉播放器/进度条的事件）。
 *   ③ **控制条右侧功能组**（进度条右边，对标剪映那一行）：预览画质 / 画幅（只读，改在工具栏）/
 *      预览缩放 / 全屏 / 本模式设置。这些**全是显示态偏好，一律不进 rtcDoc**（见 rtcPreviewStore）。
 *
 * 播放调度（要点，勿回退）：
 *   - 自绘 播放/暂停 + 时间码 + 进度条（点击/拖动 seek）——**不用原生 controls**
 *     （进度条吞指针事件，节点内视频渲染惯例，与 AudioWave 同哲学）；
 *   - rAF 驱动：**单一循环**（绝不每层各起一个）——以 performance.now 差值换微秒推进
 *     rtcStore.playheadUs（时间轴播放头竖线自动跟随）；rAF 只在播放中运行；tick 内经 getState 现读
 *     （进度条 seek / 循环开关 / 解码上限 改了即时生效，不必重启循环）；
 *     循环内顺带对全部活跃视频层做漂移校正（>150ms seek 回来）；
 *   - ⚠ **图层元素按 trackId 作 key 常驻，绝不按片段 id / uri 作 key**：换段时复用同一个元素只换 src，
 *     否则每次切片段都重建 DOM、播放断流（第236轮「勿条件卸载播放器」的同一精神）；
 *     该层这一刻没有片段时**隐藏而不是卸载**；同一层这一刻是 video、下一刻是 image → 每层内
 *     `<video>` 与 `<img>` 都常驻，按当前片段类型显隐其一（src 一律由同步 effect imperative 赋值，
 *     React 不参与——重进同一素材不重载）；
 *   - 性能护栏：同时**活跃解码**的视频层上限走 `activeDecodeTrackIds`（档位见预览设置）；
 *   - 音频：<audio> 元素池按片段 id 挂载（不进 DOM），播放头进入区间即播、离开即停；
 *     volume/muted/速度尊重字段；音轨 track.muted 整轨跳过（纯函数已过滤）；
 *   - 只读 doc、写 playheadUs + 选中片段的 transform（红线：不发起生成、不存 base64）；
 *     订阅 selection 只为画选中框——它只触发重渲染、不重建图层元素，**播放不中断**；
 *   - 暂停时播放头被时间轴拖动 → 各层被动 seek 跟随。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
	Maximize2,
	Minimize2,
	Pause,
	Play,
	Proportions,
	RotateCcw,
	Settings2,
	Sparkles,
	ZoomIn,
} from "lucide-react";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { docDurationUs, formatTimecode } from "@/lib/rtcOps";
import {
	activeDecodeTrackIds,
	audiblePoolIds,
	collectAudibleAt,
	videoLayerSlotsBottomUp,
	videoStageAt,
} from "./rtcPlayback";
import type { RtcVideoLayer } from "./rtcPlayback";
import {
	RTC_HANDLES,
	applyMove,
	applyRotate,
	applyScale,
	containFrac,
	containSize,
	handleCursor,
	isCornerHandle,
	isIdentityTransform,
	resetTransform,
	pointInSegBox,
	screenToFrame,
	segBoxGeom,
	transformCss,
	type RtcHandleId,
	type RtcPoint,
	type RtcSize,
} from "./rtcTransform";
import {
	RTC_QUALITY_SPECS,
	RTC_ZOOM_STEPS,
	qualityScale,
	useRtcPreviewStore,
	type RtcZoomMode,
} from "./rtcPreviewStore";
import { useRtcSettingsModal } from "./settings/rtcSettingsModalStore";
import { docCanvas } from "@/types/rtc";
import type { RtcSegment, RtcTransform } from "@/types/rtc";
/* ── 第二批：关键帧——画面/音量的生效值一律经 rtcKeyframes 解算（无关键帧片段返回
 *    segTransform/基础音量的同一结果 = 原路径零变化）；落笔走 applyTransformAt（关键帧感知：
 *    某属性已有帧 → 在播放头时刻写帧；无帧属性照旧写基础 transform）。 */
import { applyTransformAt, effectiveTransformAt } from "@/lib/rtcKeyframes";
/* ── 第三批：画面裁剪（clip-path 换算）+ 字幕层 ── */
import { cropClipPathCss, cropOf } from "@/lib/rtcCropCore";
import { RtcTextLayer } from "./RtcTextLayer";

/** 漂移校正阈值（秒）：视频 >150ms seek 回来；音频池粗校正 300ms；暂停跟随 1 帧（33ms） */
const VIDEO_DRIFT_SEC = 0.15;
const AUDIO_DRIFT_SEC = 0.3;
const SCRUB_FOLLOW_SEC = 0.033;

/** 元素就绪即 seek，未就绪挂 loadedmetadata 一次性补 seek */
function setMediaTime(el: HTMLMediaElement, sec: number) {
	const apply = () => {
		try { el.currentTime = sec; } catch { /* 元数据异常时忽略，漂移校正兜底 */ }
	};
	if (el.readyState >= 1) apply();
	else el.addEventListener("loadedmetadata", apply, { once: true });
}

function PlaceholderCard({ seg }: { seg: RtcSegment }) {
	return (
		<div style={{ padding: "16px 28px", borderRadius: 10, border: "1px dashed rgba(255,255,255,0.28)", background: "rgba(255,255,255,0.04)", textAlign: "center", maxWidth: "80%" }}>
			<div style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
				{seg.name?.trim() || "分镜占位"}
			</div>
			<div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.4)", letterSpacing: 2 }}>
				{seg.status === "running" ? "生成中" : seg.status === "failed" ? "生成失败" : "未生成"}
			</div>
		</div>
	);
}

/* ════════════════ 控制条通用件 ════════════════ */

const barBtn: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 4,
	height: 24,
	padding: "0 7px",
	flexShrink: 0,
	borderRadius: 5,
	border: "1px solid transparent",
	background: "transparent",
	color: "rgba(255,255,255,0.62)",
	fontSize: 11,
	cursor: "pointer",
	whiteSpace: "nowrap",
};

const popPanel: React.CSSProperties = {
	position: "absolute",
	right: 0,
	bottom: "100%",
	marginBottom: 6,
	zIndex: 60,
	borderRadius: 8,
	border: "1px solid rgba(255,255,255,0.12)",
	background: "#1c1c1e",
	boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
	padding: 8,
};

/** 下拉外壳：点击外部 / Esc 关闭（与工具栏画幅选择器同款交互） */
function BarMenu({ label, icon, title, width, children }: {
	label: React.ReactNode;
	icon?: React.ReactNode;
	title: string;
	width: number;
	children: (close: () => void) => React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);
	return (
		<div ref={wrapRef} style={{ position: "relative", flexShrink: 0 }}>
			<button
				type="button"
				title={title}
				onClick={() => setOpen((v) => !v)}
				style={{ ...barBtn, ...(open ? { background: "rgba(255,255,255,0.10)", color: "rgba(255,255,255,0.92)" } : {}) }}
			>
				{icon}
				<span style={{ fontVariantNumeric: "tabular-nums" }}>{label}</span>
			</button>
			{open ? <div style={{ ...popPanel, width }}>{children(() => setOpen(false))}</div> : null}
		</div>
	);
}

/** 下拉里的档位行 */
function MenuRow({ active, title, onClick, children }: { active?: boolean; title?: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			title={title}
			onClick={onClick}
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 8,
				width: "100%",
				padding: "5px 7px",
				borderRadius: 5,
				border: "none",
				background: active ? "rgba(139,92,246,0.18)" : "transparent",
				color: active ? "#d6c8ff" : "rgba(255,255,255,0.75)",
				fontSize: 11,
				textAlign: "left",
				cursor: "pointer",
			}}
		>
			{children}
		</button>
	);
}

/* ════════════════ 画面选中框（预览内编辑素材） ════════════════ */

/** 一次拖动手势的上下文（按下瞬间快照——整个手势以它为基准，避免逐帧累积漂移） */
interface DragCtx {
	kind: "move" | "scale" | "rotate";
	handle?: RtcHandleId;
	segId: string;
	/** 按下那一刻的变换 */
	t0: RtcTransform;
	base: RtcSize;
	frame: RtcSize;
	/** 画幅框的 client 矩形（拖动期间视作不动） */
	rect: { left: number; top: number };
	/** 起点（画幅坐标） */
	start: RtcPoint;
	/** 元素中心（画幅坐标，t0 时刻） */
	center: RtcPoint;
	moved: boolean;
}

const HANDLE_PX = 9;

/**
 * 选中框覆盖层：白色细边 + 四角/四边控制点 + 底部旋转手柄（对标剪映）。
 *
 * ⚠ **几何全用百分比，零 JS 测量**（勿回退成 frameRect 像素版）：图层画面是纯 CSS 排版
 *   （容器查询画幅框 + object-fit:contain + 百分比 transform），选中框若按 ResizeObserver
 *   实测的像素矩形来画，WebView2 下测量滞后/取整会让框比画面大一圈（实机报障：右/下边缘
 *   与画面不贴合）。改成百分比后，框与画面走同一套 CSS 排版 → 逐像素恒等，不依赖任何测量。
 *   所需输入只有 画幅宽高比（doc.canvas 纯数据）与素材自然宽高比（containFrac）。
 * ⚠ 手柄画在**只带位移/旋转、不带缩放**的容器里 → 手柄在屏幕上恒定大小（不随素材放大而变胖）。
 * ⚠ 覆盖层根节点 `pointerEvents:none`，只有框体与手柄自己 auto——框外的点击照常落到播放器上。
 */
function SelectionOverlay({ frameRatio, natural, t, locked, onDown, onReset }: {
	/** 画幅宽高比（= docCanvas 宽/高，纯数据非测量） */
	frameRatio: number;
	/** 素材自然尺寸（未知 → contain 基准回退整幅画幅，与图层元素行为一致） */
	natural: RtcSize | null;
	t: RtcTransform;
	locked: boolean;
	onDown: (kind: DragCtx["kind"], handle: RtcHandleId | undefined, e: React.PointerEvent) => void;
	onReset: () => void;
}) {
	const frac = containFrac(frameRatio, natural);
	// 框的中心/宽高全是「占画幅的百分比」：宽% 基准=容器宽、高% 基准=容器高，与图层 CSS 同一坐标系
	const wPct = Math.abs(frac.w * t.scaleX) * 100;
	const hPct = Math.abs(frac.h * t.scaleY) * 100;
	const cxPct = (0.5 + t.x) * 100;
	const cyPct = (0.5 + t.y) * 100;
	if (!(wPct > 0) || !(hPct > 0)) return null;
	const boxStyle: React.CSSProperties = {
		position: "absolute",
		left: `${cxPct}%`,
		top: `${cyPct}%`,
		width: `${wPct}%`,
		height: `${hPct}%`,
		transform: `translate(-50%, -50%) rotate(${t.rotation}deg)`,
		border: locked ? "1px dashed rgba(255,255,255,0.55)" : "1px solid rgba(255,255,255,0.92)",
		boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
		pointerEvents: locked ? "none" : "auto",
		cursor: locked ? "default" : "move",
		boxSizing: "border-box",
	};
	const handlePos: Record<RtcHandleId, { left: string; top: string }> = {
		nw: { left: "0%", top: "0%" },
		n: { left: "50%", top: "0%" },
		ne: { left: "100%", top: "0%" },
		e: { left: "100%", top: "50%" },
		se: { left: "100%", top: "100%" },
		s: { left: "50%", top: "100%" },
		sw: { left: "0%", top: "100%" },
		w: { left: "0%", top: "50%" },
	};
	return (
		<div style={{ position: "absolute", inset: 0, zIndex: 60, pointerEvents: "none" }}>
			<div style={boxStyle} onPointerDown={locked ? undefined : (e) => onDown("move", undefined, e)}>
				{!locked
					? RTC_HANDLES.map((h) => {
							const corner = isCornerHandle(h);
							const p = handlePos[h];
							return (
								<div
									key={h}
									onPointerDown={(e) => onDown("scale", h, e)}
									title={corner ? "拖动缩放（按住 Shift 切换等比/自由）" : "拖动单向缩放"}
									style={{
										position: "absolute",
										left: p.left,
										top: p.top,
										width: HANDLE_PX,
										height: HANDLE_PX,
										marginLeft: -HANDLE_PX / 2,
										marginTop: -HANDLE_PX / 2,
										borderRadius: corner ? 2 : 5,
										background: "#fff",
										border: "1px solid rgba(0,0,0,0.45)",
										cursor: handleCursor(h, t.rotation),
										pointerEvents: "auto",
									}}
								/>
							);
						})
					: null}
				{/* 旋转手柄：底边中点下方（与框相连的短线 + 圆点） */}
				{!locked ? (
					<div style={{ position: "absolute", left: "50%", top: "100%", pointerEvents: "none" }}>
						<div style={{ position: "absolute", left: -0.5, top: 0, width: 1, height: 20, background: "rgba(255,255,255,0.75)" }} />
						<div
							onPointerDown={(e) => onDown("rotate", undefined, e)}
							title="拖动旋转（按住 Shift 吸附 15°）"
							style={{
								position: "absolute",
								left: -6,
								top: 18,
								width: 12,
								height: 12,
								borderRadius: "50%",
								background: "#fff",
								border: "1px solid rgba(0,0,0,0.45)",
								cursor: "grab",
								pointerEvents: "auto",
							}}
						/>
					</div>
				) : null}
			</div>
			{/* 「重置画面」——素材被拖出画幅外时的救生索（仅变换非缺省时出现，屏幕对齐不随框旋转） */}
			{!locked && !isIdentityTransform(t) ? (
				<button
					type="button"
					onClick={onReset}
					title="把该片段的画面变换恢复为默认（画幅内居中铺满）"
					style={{
						position: "absolute",
						// 位置同样零测量：clamp/max 交给 CSS 算（百分比基准=画幅框容器）
						left: `clamp(44px, ${cxPct}%, calc(100% - 44px))`,
						top: `max(14px, calc(${cyPct - hPct / 2}% - 14px))`,
						transform: "translate(-50%, -100%)",
						display: "flex",
						alignItems: "center",
						gap: 4,
						padding: "3px 7px",
						borderRadius: 5,
						border: "1px solid rgba(255,255,255,0.25)",
						background: "rgba(20,20,22,0.86)",
						color: "rgba(255,255,255,0.85)",
						fontSize: 10,
						cursor: "pointer",
						pointerEvents: "auto",
						whiteSpace: "nowrap",
					}}
				>
					<RotateCcw size={10} /> 重置画面
				</button>
			) : null}
		</div>
	);
}

/* ════════════════ 播放器本体 ════════════════ */

export function RtcSequencePlayer() {
	/* 第四批：取数口径 = 当前编辑层（主层=doc、复合子层=子文档视图，引用稳定可直接作 selector）。
	 * 编辑子层时播放器就播子层（子层视图不含复合片段，下方全部逻辑天然退化为普通 doc）。 */
	const doc = useRtcStore(activeRtcDoc);
	const playheadUs = useRtcStore((s) => s.playheadUs);
	const selection = useRtcStore((s) => s.selection);
	const [playing, setPlaying] = useState(false);
	const playingRef = useRef(false);
	playingRef.current = playing;

	/* 预览显示偏好（全在 rtcPreviewStore，绝不进 rtcDoc） */
	const quality = useRtcPreviewStore((s) => s.quality);
	const zoom = useRtcPreviewStore((s) => s.zoom);
	const maxDecodeLayers = useRtcPreviewStore((s) => s.maxDecodeLayers);
	const hideBoxWhilePlaying = useRtcPreviewStore((s) => s.hideBoxWhilePlaying);
	const uniformScale = useRtcPreviewStore((s) => s.uniformScale);

	/** 图层元素表：trackId → 元素（常驻复用，换段只换 src） */
	const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
	const imgElsRef = useRef<Map<string, HTMLImageElement>>(new Map());
	/** 稳定的 ref 回调缓存（内联箭头会每帧 detach/attach，必须按 trackId 复用同一个函数） */
	const videoRefCbsRef = useRef<Map<string, (el: HTMLVideoElement | null) => void>>(new Map());
	const imgRefCbsRef = useRef<Map<string, (el: HTMLImageElement | null) => void>>(new Map());
	/** 各层已完成入段对时的片段 id——漂移校正/暂停跟随只作用于对过时的层（防换段瞬间乱 seek） */
	const syncedSegRef = useRef<Map<string, string>>(new Map());
	/** 音频元素池：segId → <audio>（不进 DOM；离开区间只停不销毁，重进复用） */
	const audioPoolRef = useRef<Map<string, HTMLAudioElement>>(new Map());
	const barRef = useRef<HTMLDivElement | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const frameElRef = useRef<HTMLDivElement | null>(null);
	/**
	 * 画幅框的实测像素矩形——**不用于排版**（排版见下方 CSS 容器查询/固定像素），只喂给
	 * 「屏幕坐标 ↔ 画幅坐标」换算：选中框几何、拖动解算、以及「适应」档的缩放百分比读数。
	 * ResizeObserver 跟随面板拖动/窗口缩放。
	 */
	const [frameRect, setFrameRect] = useState<RtcSize>({ w: 0, h: 0 });
	const frameRoRef = useRef<ResizeObserver | null>(null);
	/** 素材自然尺寸（key=uri）——选中框的 contain 基准；元数据到位即记录，未知时框回退整幅画幅 */
	const [naturals, setNaturals] = useState<Record<string, RtcSize>>({});
	/** 拖动中的本地预览变换（⚠ 只预览不落库；pointerup 才 commit 一次） */
	const [draft, setDraft] = useState<{ segId: string; t: RtcTransform } | null>(null);
	const draftRef = useRef<typeof draft>(null);
	draftRef.current = draft;
	const dragRef = useRef<DragCtx | null>(null);
	const [isFullscreen, setIsFullscreen] = useState(false);

	const durationUs = doc ? docDurationUs(doc) : 0;
	// 显示帧时刻：播完停在末尾时钳到 duration-1（末帧右缘开区间，不钳会闪黑场）
	const frameUs = durationUs > 0 ? Math.min(playheadUs, durationUs - 1) : 0;
	// 图层槽位（第四批）：普通视频轨一槽 + 复合片段的每条子视频轨一槽——元素按 slotId 常驻复用
	const layerSlots = doc ? videoLayerSlotsBottomUp(doc) : [];
	const stage = doc ? videoStageAt(doc, frameUs) : { layers: [] as RtcVideoLayer[], placeholder: null };
	const layerByTrack = new Map(stage.layers.map((l) => [l.trackId, l]));
	const canvas = docCanvas(doc ?? {});
	const ratio = canvas.width / canvas.height;

	/*
	 * 画幅框尺寸 —— ⚠ **绝不依赖 JS 实测**（勿回退成测量驱动排版）：
	 * 曾用 ResizeObserver 实测容器 + fitCanvasBox 算像素，实机出现过「容器实测值卡在早期的小尺寸、
	 * 画幅框被算小并缩在左上角」的故障——测量与布局的时序在 WebView2 下不可靠。
	 *   - 「适应」档：**容器查询单位**——框宽=min(100cqw, 100cqh×比例)、框高=min(100cqh, 100cqw÷比例)，
	 *     配 inset:0 + margin:auto 居中。这是 contain 居中的精确等价式，零测量，比例随 doc.canvas 即时生效；
	 *   - 倍率档（50%/100%/…）：框= 画幅像素 × 倍率的**定值**（同样零测量，只用 doc 数据）。
	 *     ⚠ 放大到超出容器时**居中裁切**（外层 overflow:hidden；absolute + inset:0 + margin:auto 在负空间下
	 *     两侧均分溢出=居中）——刻意不做滚动条：预览区通常很扁，滚动条会再吃掉可视高度，
	 *     要看全景按「适应」一键回来即可。
	 */
	const frameStyle: React.CSSProperties =
		zoom === "fit"
			? { inset: 0, margin: "auto", width: `min(100cqw, calc(100cqh * ${ratio}))`, height: `min(100cqh, calc(100cqw / ${ratio}))` }
			: { inset: 0, margin: "auto", width: Math.max(1, Math.round(canvas.width * zoom)), height: Math.max(1, Math.round(canvas.height * zoom)) };

	/**
	 * 画质档 = 图层合成的**渲染像素档**：整叠图层先画在 scale 比例的渲染面上，再 CSS 放大填满画幅框。
	 * 几何完全等价（图层位移用百分比、随渲染面一起缩放），原画档直接不套这层（零回归）。
	 * ⚠ 选中框覆盖层**不放进渲染面**（否则控制点跟着糊），它按实测画幅像素独立绘制。
	 */
	const qScale = qualityScale(quality);
	const surfaceStyle: React.CSSProperties =
		qScale >= 1
			? { position: "absolute", inset: 0 }
			: { position: "absolute", left: 0, top: 0, width: `${qScale * 100}%`, height: `${qScale * 100}%`, transform: `scale(${1 / qScale})`, transformOrigin: "0 0" };

	/**
	 * 画幅框 callback ref：订阅它的实测尺寸（稳定身份，不随重渲染反复装卸）。
	 * ⚠ 这里的测量**不参与排版**，只作交互换算与缩放读数；测不到也只是拖动不可用，画面显示不受影响。
	 */
	const attachFrame = useCallback((el: HTMLDivElement | null) => {
		frameRoRef.current?.disconnect();
		frameRoRef.current = null;
		frameElRef.current = el;
		if (!el) return;
		const measure = () => setFrameRect({ w: el.clientWidth, h: el.clientHeight });
		measure();
		if (typeof ResizeObserver !== "undefined") {
			const ro = new ResizeObserver(measure);
			ro.observe(el);
			frameRoRef.current = ro;
		}
	}, []);

	/** 记录素材自然尺寸（同值不 setState，避免无谓重渲染） */
	const recordNatural = useCallback((uri: string | undefined, w: number, h: number) => {
		if (!uri || !(w > 0) || !(h > 0)) return;
		setNaturals((prev) => {
			const cur = prev[uri];
			if (cur && cur.w === w && cur.h === h) return prev;
			return { ...prev, [uri]: { w, h } };
		});
	}, []);

	const videoRefFor = (trackId: string) => {
		let cb = videoRefCbsRef.current.get(trackId);
		if (!cb) {
			cb = (el) => {
				const m = videoElsRef.current;
				if (el) { m.set(trackId, el); return; }
				m.get(trackId)?.pause(); // 卸载即停（脱离 DOM 的媒体元素可能继续发声）
				m.delete(trackId);
				syncedSegRef.current.delete(trackId);
			};
			videoRefCbsRef.current.set(trackId, cb);
		}
		return cb;
	};
	const imgRefFor = (trackId: string) => {
		let cb = imgRefCbsRef.current.get(trackId);
		if (!cb) {
			cb = (el) => {
				const m = imgElsRef.current;
				if (el) m.set(trackId, el);
				else m.delete(trackId);
			};
			imgRefCbsRef.current.set(trackId, cb);
		}
		return cb;
	};

	/* ── rAF 播放驱动（单一循环，只在播放中运行；顺带对全部活跃视频层做漂移校正） ── */
	useEffect(() => {
		if (!playing) return;
		let raf = 0;
		let lastWall = performance.now();
		const tick = () => {
			const wall = performance.now();
			const dtUs = (wall - lastWall) * 1000;
			lastWall = wall;
			const st = useRtcStore.getState();
			const view = activeRtcDoc(st); // 第四批：编辑子层时按子层时长/图层推进
			if (!view) { setPlaying(false); return; }
			const dur = docDurationUs(view);
			const next = st.playheadUs + dtUs;
			if (next >= dur) {
				// 循环开关经 getState 现读（改了即时生效，不必重启 rAF）
				if (useRtcPreviewStore.getState().loop && dur > 0) {
					st.setPlayhead(0); // 回到片头继续播；各层的巨大漂移由下面的校正当场 seek 回位
					raf = requestAnimationFrame(tick);
					return;
				}
				st.setPlayhead(dur);
				setPlaying(false); // 播完自动停
				return;
			}
			st.setPlayhead(next);
			// 逐层漂移校正：以 video.currentTime 对照期望源时间，差 >150ms seek 回来
			const st2 = videoStageAt(view, next);
			const active = activeDecodeTrackIds(st2.layers, useRtcPreviewStore.getState().maxDecodeLayers);
			for (const l of st2.layers) {
				if (l.media !== "video" || l.frozen || !active.has(l.trackId)) continue;
				const el = videoElsRef.current.get(l.trackId);
				if (!el || el.readyState < 1) continue;
				if (syncedSegRef.current.get(l.trackId) !== l.seg.id) continue;
				if (Math.abs(el.currentTime - l.sourceSec) > VIDEO_DRIFT_SEC) {
					try { el.currentTime = l.sourceSec; } catch { /* noop */ }
				}
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [playing]);

	/* ── 图层同步：src / 入段对时 / 声音属性 / 播放暂停 / 暂停时跟随拖动（全部 imperative，元素不重建） ── */
	useEffect(() => {
		const vids = videoElsRef.current;
		const imgs = imgElsRef.current;
		const synced = syncedSegRef.current;
		const st = videoStageAt(doc ?? { id: "", name: "", fps: 30, tracks: [] }, frameUs);
		const byTrack = new Map(st.layers.map((l) => [l.trackId, l]));
		const active = activeDecodeTrackIds(st.layers, maxDecodeLayers);

		for (const [trackId, el] of vids) {
			const layer = byTrack.get(trackId);
			if (!layer || layer.media !== "video" || !layer.uri) {
				// 该层这一刻没有视频：停掉（元素与 src 保留，重进不重载；显隐由 style 负责）
				if (!el.paused) el.pause();
				synced.delete(trackId);
				continue;
			}
			if (el.dataset.uri !== layer.uri) {
				el.dataset.uri = layer.uri;
				el.src = layer.uri;
				synced.delete(trackId);
			}
			// 音量关键帧：按当前帧时刻解算（无 volume 帧 = layer.volume 同值）；本 effect 依赖 frameUs，播放中逐帧跟随
			el.volume = layer.volume; // 音量（含关键帧与复合宿主乘积）已在 rtcPlayback 源头算好
			el.muted = layer.muted;
			el.playbackRate = layer.rate;
			if (synced.get(trackId) !== layer.seg.id) {
				setMediaTime(el, layer.sourceSec); // 入段对时（含 sourceStartUs/speed 换算）
				synced.set(trackId, layer.seg.id);
			} else if (!playing && el.readyState >= 1 && Math.abs(el.currentTime - layer.sourceSec) > SCRUB_FOLLOW_SEC) {
				try { el.currentTime = layer.sourceSec; } catch { /* noop */ } // 暂停时被时间轴拖动 → 画面跟随
			}
			// 冻结幽灵层（转场定格帧）永不 play：入段对时那一帧就是它的全部
			if (playing && active.has(trackId) && !layer.frozen) {
				if (el.paused) void el.play().catch(() => {});
			} else if (!el.paused) {
				el.pause();
			}
			// 元数据已就绪的层顺手补记自然尺寸（错过 loadedmetadata 事件时的兜底）
			if (el.videoWidth > 0) recordNatural(layer.uri, el.videoWidth, el.videoHeight);
		}

		for (const [trackId, el] of imgs) {
			const layer = byTrack.get(trackId);
			if (!layer || layer.media !== "image" || !layer.uri) continue; // 保留上次 src（fill 填充层无 uri 同跳过）
			if (el.dataset.uri !== layer.uri) {
				el.dataset.uri = layer.uri;
				el.src = layer.uri;
			}
			if (el.naturalWidth > 0) recordNatural(layer.uri, el.naturalWidth, el.naturalHeight);
		}
	}, [doc, frameUs, playing, maxDecodeLayers, recordNatural]);

	/* ── 音频池：进入区间即播、离开即停（元素留池复用） ── */
	useEffect(() => {
		const pool = audioPoolRef.current;
		const st = useRtcStore.getState();
		const view = activeRtcDoc(st); // 第四批：编辑层口径 + 复合片段子层音频经 collectAudibleAt 展开
		if (!view) {
			for (const el of pool.values()) el.pause();
			return;
		}
		const active = collectAudibleAt(view, st.playheadUs);
		const activeIds = new Set(active.map((c) => c.id));
		for (const [id, el] of pool) {
			if (!activeIds.has(id) && !el.paused) el.pause();
		}
		for (const clip of active) {
			let el = pool.get(clip.id);
			if (!el) {
				el = new Audio();
				el.preload = "auto";
				pool.set(clip.id, el);
			}
			if (el.dataset.uri !== clip.uri) {
				el.dataset.uri = clip.uri;
				el.src = clip.uri;
			}
			el.volume = clip.volume;
			el.playbackRate = clip.rate;
			if (playing) {
				// 条目自带已解算的源时间（复合偏移与 speed 已在纯函数里算好）
				const target = clip.sourceSec;
				if (el.paused) {
					setMediaTime(el, target);
					void el.play().catch(() => {});
				} else if (el.readyState >= 1 && Math.abs(el.currentTime - target) > AUDIO_DRIFT_SEC) {
					setMediaTime(el, target); // 粗漂移校正
				}
			} else if (!el.paused) {
				el.pause();
			}
		}
	}, [playheadUs, playing]);

	/* ── doc 变更：清掉池里已不存在的片段元素 + 已删槽位的 ref 回调缓存 ── */
	useEffect(() => {
		if (!doc) return;
		// 第四批：存活 id 含复合子层复合 id（`${segId}/${subSegId}`），勿只按主层片段清
		const alive = audiblePoolIds(doc);
		const pool = audioPoolRef.current;
		for (const [id, el] of pool) {
			if (!alive.has(id)) {
				el.pause();
				el.removeAttribute("src");
				pool.delete(id);
			}
		}
		const slotIds = new Set(videoLayerSlotsBottomUp(doc).map((s) => s.slotId));
		for (const m of [videoRefCbsRef.current, imgRefCbsRef.current] as Map<string, unknown>[]) {
			for (const id of [...m.keys()]) if (!slotIds.has(id)) m.delete(id);
		}
	}, [doc]);

	/* ── 全屏状态跟随（Esc 退出也能同步图标） ── */
	useEffect(() => {
		const onChange = () => setIsFullscreen(!!document.fullscreenElement && document.fullscreenElement === rootRef.current);
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, []);

	/* ── 卸载收尾：全停并清池 ── */
	useEffect(() => {
		const pool = audioPoolRef.current;
		const vids = videoElsRef.current;
		return () => {
			for (const el of pool.values()) {
				el.pause();
				el.removeAttribute("src");
			}
			pool.clear();
			for (const el of vids.values()) el.pause();
			frameRoRef.current?.disconnect();
			frameRoRef.current = null;
		};
	}, []);

	/* ── 预览内编辑：选中片段解算 + 三种手势 ── */

	/** 画面上正被选中的层（多选时取**最上面**那层；只有真在画面上的才画框） */
	let selLayer: RtcVideoLayer | null = null;
	if (selection.length) {
		const sel = new Set(selection);
		for (let i = stage.layers.length - 1; i >= 0; i--) {
			// 转场幽灵层不参与选中框（它承载的是「另一侧」片段的定格，不是可编辑画面）
			if (stage.layers[i].ghost) continue;
			if (sel.has(stage.layers[i].seg.id)) { selLayer = stage.layers[i]; break; }
		}
	}
	const selLocked = !!(selLayer && doc?.tracks.find((t) => t.id === selLayer!.trackId)?.locked);
	const selNatural = selLayer ? (naturals[selLayer.uri] ?? null) : null;
	// 选中框按**生效变换**画（关键帧片段随播放头动，框跟着画面走；无关键帧 = segTransform 同值）
	const selTransform = selLayer
		? draft && draft.segId === selLayer.seg.id
			? draft.t
			: effectiveTransformAt(selLayer.seg, selLayer.kfRelUs)
		: null;
	const showBox = !!selLayer && !(playing && hideBoxWhilePlaying);

	/** 落笔：把 draft 写进 doc（一次手势=一次 undo）。
	 *  ── 第二批：**关键帧感知**——某属性已有关键帧 → 在播放头时刻写帧（基础值不动），无关键帧属性
	 *  照旧写基础 transform（applyTransformAt 对无关键帧片段与 withSegmentTransform 同语义）。
	 *  ── 第四批：走 commitActive——编辑子层时选中的是子层片段，变更要写进子文档。 */
	const commitTransform = useCallback((segId: string, t: RtcTransform) => {
		const ph = useRtcStore.getState().playheadUs;
		useRtcStore.getState().commitActive((d) => applyTransformAt(d, segId, t, ph));
	}, []);

	/**
	 * 画面点选（用户定：应该能直接在预览框选中素材）：
	 *   - 命中检测自上而下（与遮挡视觉一致），几何=选中框同一套（pointInSegBox，忽略 crop 热区收缩）；
	 *   - 复合子层命中 → 选中**宿主复合段**（子层片段 id 在主层视图无意义）；
	 *   - 普通画面片段命中 → 选中并**当场进入移动拖拽**（同一手势选中即拖，对标剪映）；
	 *     复合段/锁定轨只选中不拖（复合段无画面变换，批4 边界）；
	 *   - 全部落空 → 清空选中。
	 * 挂在画幅框上（图层元素恒 pointerEvents:none，事件天然落到这里）；选中框/手柄的按下已
	 * stopPropagation 且是兄弟节点，不会串进来。
	 */
	const onStagePointerDown = useCallback(
		(e: React.PointerEvent) => {
			if (e.button !== 0) return;
			const el = frameElRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			if (!(rect.width > 0) || !(rect.height > 0)) return;
			const frame = { w: rect.width, h: rect.height };
			const point = screenToFrame(e.clientX, e.clientY, rect);
			const st = useRtcStore.getState();
			const layers = stage.layers;
			for (let i = layers.length - 1; i >= 0; i--) {
				const layer = layers[i];
				if (layer.ghost) continue; // 转场幽灵层不可点选（点它=点透到下面的真画面层）
				const t = draft && draft.segId === layer.seg.id ? draft.t : effectiveTransformAt(layer.seg, layer.kfRelUs);
				const base = containSize(frame, naturals[layer.uri]);
				if (!pointInSegBox(point, frame, base, t)) continue;
				// 复合子层：trackId = `${复合段id}/${子轨id}` → 选中宿主复合段（只选不拖）
				const slash = layer.trackId.indexOf("/");
				if (slash > 0) {
					const hostId = layer.trackId.slice(0, slash);
					if (!(st.selection.length === 1 && st.selection[0] === hostId)) st.setSelection([hostId]);
					return;
				}
				const segId = layer.seg.id;
				if (!(st.selection.length === 1 && st.selection[0] === segId)) st.setSelection([segId]);
				// 锁定轨：只选中不拖（选中框会以虚线态呈现）
				const hostTrack = (st.doc && !st.editingSubDocId ? st.doc : activeRtcDoc(st))?.tracks.find((tr) => tr.id === layer.trackId);
				if (hostTrack?.locked) return;
				// 同一手势直接进入移动拖拽（DragCtx 与选中框内拖动完全同构）
				e.preventDefault();
				const g = segBoxGeom(frame, base, t);
				dragRef.current = {
					kind: "move",
					handle: undefined,
					segId,
					t0: t,
					base,
					frame,
					rect: { left: rect.left, top: rect.top },
					start: point,
					center: g.center,
					moved: false,
				};
				try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* 捕获失败仅影响移出后跟踪 */ }
				return;
			}
			if (st.selection.length) st.setSelection([]); // 点空白=清空选中（对标剪映画布）
		},
		[stage.layers, draft, naturals],
	);

	const onDragStart = useCallback(
		(kind: DragCtx["kind"], handle: RtcHandleId | undefined, e: React.PointerEvent) => {
			if (!selLayer || !selTransform || selLocked) return;
			const el = frameElRef.current;
			if (!el) return;
			e.preventDefault();
			e.stopPropagation();
			// ⚠ 画幅矩形在手势开始时**现读**（含宽高），勿用 ResizeObserver 缓存态——WebView2 下
			//   缓存可能滞后于真实排版（选中框百分比化修的就是这个病，解算侧同一把尺）。
			const rect = el.getBoundingClientRect();
			if (!(rect.width > 0) || !(rect.height > 0)) return;
			const frame = { w: rect.width, h: rect.height };
			const base = containSize(frame, naturals[selLayer.uri]);
			const start = screenToFrame(e.clientX, e.clientY, rect);
			const g = segBoxGeom(frame, base, selTransform);
			dragRef.current = {
				kind,
				handle,
				segId: selLayer.seg.id,
				t0: selTransform,
				base,
				frame,
				rect: { left: rect.left, top: rect.top },
				start,
				center: g.center,
				moved: false,
			};
			try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* 捕获失败不影响后续 move（只是移出元素会断） */ }
		},
		[selLayer, selTransform, selLocked, naturals],
	);

	const onDragMove = useCallback((e: React.PointerEvent) => {
		const d = dragRef.current;
		if (!d) return;
		const p = screenToFrame(e.clientX, e.clientY, d.rect);
		if (!d.moved && Math.abs(p.x - d.start.x) < 1 && Math.abs(p.y - d.start.y) < 1) return; // 抖动阈值：1px 内不算拖
		d.moved = true;
		let next: RtcTransform;
		if (d.kind === "move") {
			next = applyMove(d.t0, { x: p.x - d.start.x, y: p.y - d.start.y }, d.frame);
		} else if (d.kind === "scale" && d.handle) {
			// 角手柄默认按设置里的「等比」，Shift 临时取反；边手柄恒单向（applyScale 内部忽略 uniform）
			const uniform = isCornerHandle(d.handle) ? uniformScale !== e.shiftKey : false;
			next = applyScale({ t0: d.t0, frame: d.frame, base: d.base, pointer: p, handle: d.handle, uniform });
		} else {
			next = applyRotate(d.t0, d.center, d.start, p, e.shiftKey);
		}
		setDraft({ segId: d.segId, t: next });
	}, [uniformScale]);

	const onDragEnd = useCallback(() => {
		const d = dragRef.current;
		dragRef.current = null;
		const cur = draftRef.current;
		setDraft(null);
		if (!d || !cur || cur.segId !== d.segId) return;
		commitTransform(d.segId, cur.t); // ⚠ 整段手势只在这里落一次库
	}, [commitTransform]);

	if (!doc) return null;

	const onToggle = () => {
		if (playing) { setPlaying(false); return; }
		const st = useRtcStore.getState();
		if (!st.doc) return;
		const dur = docDurationUs(st.doc);
		if (dur <= 0) return;
		if (st.playheadUs >= dur - 1) st.setPlayhead(0); // 播完再按=从头
		setPlaying(true);
	};

	const seekFromPointer = (clientX: number) => {
		const bar = barRef.current;
		if (!bar || durationUs <= 0) return;
		const rect = bar.getBoundingClientRect();
		if (rect.width <= 0) return;
		const r = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		useRtcStore.getState().setPlayhead(r * durationUs);
	};

	const toggleFullscreen = () => {
		const el = rootRef.current;
		if (!el) return;
		if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
		else void el.requestFullscreen?.().catch(() => {});
	};

	const pct = durationUs > 0 ? (Math.min(playheadUs, durationUs) / durationUs) * 100 : 0;
	const qualityLabel = RTC_QUALITY_SPECS.find((s) => s.id === quality)?.label ?? "原画";
	/** 缩放读数：「适应」档按实测框宽 ÷ 画幅宽算真实百分比（测量只用于显示文本，不参与排版） */
	const zoomPct = zoom === "fit" ? (frameRect.w > 0 ? Math.round((frameRect.w / canvas.width) * 100) : null) : Math.round(zoom * 100);
	const zoomLabel = zoom === "fit" ? `适应${zoomPct != null ? ` ${zoomPct}%` : ""}` : `${zoomPct}%`;
	const canvasLabel = `${canvas.width}×${canvas.height}`;
	const aspectText = aspectTextOf(canvas.width, canvas.height);

	return (
		<div ref={rootRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: isFullscreen ? "#000" : undefined }}>
			{/* 画面区：外层=可用空间（纯黑留白），内层=按 doc.canvas 比例居中的**画幅框**，图层全在框内合成 */}
			{/* 外层=画幅之外的留白：**刻意用灰**，与画幅内的纯黑区分开，让用户一眼看出画幅边界在哪 */}
			<div style={{ position: "relative", flex: 1, minHeight: 0, background: "#2b2d36", overflow: "hidden", containerType: "size" }}>
				{/* 内层=画幅框：成片边界，恒纯黑（素材没铺满时的留黑属于成片内容） */}
				<div
					ref={attachFrame}
					onPointerDown={onStagePointerDown}
					onPointerMove={onDragMove}
					onPointerUp={onDragEnd}
					onPointerCancel={onDragEnd}
					style={{ position: "absolute", ...frameStyle, overflow: "hidden", background: "#000" }}
				>
					{/* 渲染面：画质档 <100% 时按比例缩小像素再放大（几何等价，选中框不在其中） */}
					<div style={surfaceStyle}>
						{layerSlots.map((slot, i) => {
							const layer = layerByTrack.get(slot.slotId);
							const isVideo = layer?.media === "video" && !!layer.uri;
							const isImage = layer?.media === "image" && !!layer.uri;
							// 变换：拖动中的那一层用 draft 预览，其余按播放头时刻解算生效变换
							// （effectiveTransformAt：无关键帧 = segTransform 同一结果 → 原路径零变化；
							//   播放中 frameUs 逐帧变化本就触发重渲染，关键帧动画随之逐帧生效）
							const tf = layer && !layer.fill
								? draft && draft.segId === layer.seg.id
									? draft.t
									: effectiveTransformAt(layer.seg, layer.kfRelUs)
								: null;
							const css = tf ? transformCss(tf) : null;
							/* 转场附加效果：过渡位移（占画幅百分比）**前置**在片段自身变换之外；
							 * 透明度乘子与片段 opacity 相乘。无转场时两者恒缺省=原路径零变化。 */
							const fx = layer?.fx;
							const fxTranslate = fx && (fx.txPct || fx.tyPct) ? `translate(${fx.txPct ?? 0}%, ${fx.tyPct ?? 0}%)` : null;
							const combined = fxTranslate ? (css ? `${fxTranslate} ${css}` : fxTranslate) : css;
							const alpha = (tf && tf.opacity < 1 ? tf.opacity : 1) * (fx?.alphaMul ?? 1);
							/* 第三批·画面裁剪：clip-path 在**未变换**边框盒上生效、随 transform 一起搬走
							 * （crop 基准=素材画面，经 containFrac 折算到画幅比例——见 rtcCropCore 注释）；
							 * 不裁返回 null → 不写 clipPath 属性（零回归）。自然尺寸未知按整幅近似。 */
							const clipCss = layer && !layer.fill
								? cropClipPathCss(cropOf(layer.seg), containFrac(ratio, naturals[layer.uri] ?? null))
								: null;
							return (
								<div
									key={slot.slotId}
									style={{
										position: "absolute",
										inset: 0,
										zIndex: i + 1,
										display: layer ? "block" : "none",
										pointerEvents: "none",
										...(combined ? { transform: combined, transformOrigin: "center" } : null),
										...(alpha < 1 ? { opacity: alpha } : null),
										...(clipCss ? { clipPath: clipCss } : null),
										// 色闪填充层（闪黑/闪白）：整幅背景色，无媒体元素参与
										...(layer?.fill ? { background: layer.fill } : null),
									}}
								>
									<video
										ref={videoRefFor(slot.slotId)}
										preload="auto"
										playsInline
										disablePictureInPicture
										onLoadedMetadata={(e) => recordNatural(e.currentTarget.dataset.uri, e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
										style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", display: isVideo ? "block" : "none" }}
									/>
									<img
										ref={imgRefFor(slot.slotId)}
										alt=""
										draggable={false}
										onLoad={(e) => recordNatural(e.currentTarget.dataset.uri, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
										style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", display: isImage ? "block" : "none" }}
									/>
								</div>
							);
						})}
						{/* 第三批·字幕层：播放头处的活动字幕（压在全部画面层之上、占位提示卡之下；零测量排版） */}
						<RtcTextLayer doc={doc} tUs={frameUs} />
						{/* 占位提示卡：仅当**一层画面都没有**时显示（占位绝不遮挡下层旧版本） */}
						{stage.layers.length === 0 && stage.placeholder ? (
							<div style={{ position: "absolute", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
								<PlaceholderCard seg={stage.placeholder} />
							</div>
						) : null}
					</div>
				</div>
				{/*
				 * 选中框层：与画幅框**同一份 frameStyle**（纯 CSS 定尺 → 两者几何逐像素一致，同样零测量），
				 * 但 overflow 放开——素材被拖到画幅外时，选中框与控制点仍看得见、抓得到
				 * （画幅框本身 overflow:hidden 是成片边界语义，不能为了抓手柄去动它）。
				 */}
				{showBox && selTransform ? (
					<div
						onPointerMove={onDragMove}
						onPointerUp={onDragEnd}
						onPointerCancel={onDragEnd}
						style={{ position: "absolute", ...frameStyle, pointerEvents: "none", zIndex: 5 }}
					>
						<SelectionOverlay
							frameRatio={ratio}
							natural={selNatural}
							t={selTransform}
							locked={selLocked}
							onDown={onDragStart}
							onReset={() => selLayer && commitTransform(selLayer.seg.id, resetTransform())}
						/>
					</div>
				) : null}
			</div>
			{/* 控制条：左=播放/时间码/进度条；右=画质 · 画幅 · 缩放 · 全屏 · 设置（对标剪映播放器下方那一行） */}
			<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "rgba(255,255,255,0.03)" }}>
				<button
					type="button"
					title={playing ? "暂停" : "播放"}
					onClick={onToggle}
					style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, flexShrink: 0, borderRadius: "50%", border: "1px solid rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.18)", color: "#d6c8ff", cursor: "pointer" }}
				>
					{playing ? <Pause size={14} /> : <Play size={14} style={{ marginLeft: 1 }} />}
				</button>
				<span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "rgba(255,255,255,0.8)", flexShrink: 0 }}>
					{formatTimecode(Math.min(playheadUs, durationUs), doc.fps)}
				</span>
				<div
					ref={barRef}
					onPointerDown={(e) => {
						e.currentTarget.setPointerCapture(e.pointerId);
						seekFromPointer(e.clientX);
					}}
					onPointerMove={(e) => {
						if (e.buttons & 1) seekFromPointer(e.clientX);
					}}
					style={{ flex: 1, minWidth: 40, height: 16, display: "flex", alignItems: "center", cursor: "pointer" }}
				>
					<div style={{ position: "relative", width: "100%", height: 5, borderRadius: 3, background: "rgba(255,255,255,0.12)" }}>
						<div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, borderRadius: 3, background: "rgba(139,92,246,0.85)" }} />
					</div>
				</div>
				<span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "rgba(255,255,255,0.45)", flexShrink: 0 }}>
					{formatTimecode(durationUs, doc.fps)}
				</span>

				{/* 分隔 */}
				<div style={{ width: 1, height: 16, flexShrink: 0, background: "rgba(255,255,255,0.10)" }} />

				{/* 预览画质 */}
				<BarMenu title="预览画质（只影响预览合成的渲染像素，不改成片）" width={224} icon={<Sparkles size={12} />} label={qualityLabel}>
					{(close) => (
						<div>
							{RTC_QUALITY_SPECS.map((s) => (
								<MenuRow
									key={s.id}
									active={quality === s.id}
									title={s.hint}
									onClick={() => { useRtcPreviewStore.getState().setQuality(s.id); close(); }}
								>
									<span>{s.label}</span>
									<span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{Math.round(s.scale * 100)}%</span>
								</MenuRow>
							))}
							<div style={{ marginTop: 4, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.07)", fontSize: 10, lineHeight: 1.6, color: "rgba(255,255,255,0.42)" }}>
								降档只减少预览合成的像素量（多层叠加时最明显），不会改变素材本身的解码分辨率，也不影响导出。
							</div>
						</div>
					)}
				</BarMenu>

				{/* 画幅：只读展示——⚠ 真正的画幅设置入口只有工具栏「画幅」一处，这里绝不做第二个能改它的地方 */}
				<BarMenu title={`画幅 ${aspectText} · ${canvasLabel}（在工具栏「画幅」中修改）`} width={220} icon={<Proportions size={12} />} label={`${aspectText} · ${canvasLabel}`}>
					{() => (
						<div style={{ fontSize: 11, lineHeight: 1.7, color: "rgba(255,255,255,0.7)" }}>
							<div style={{ fontFamily: "ui-monospace, monospace" }}>{aspectText} · {canvasLabel}</div>
							<div style={{ marginTop: 6, fontSize: 10, color: "rgba(255,255,255,0.45)" }}>
								画幅是文档级设置（决定预览框比例与导出成片尺寸）。要修改请到工具栏的「画幅」——那里改一处即可，
								切画幅不会裁剪或改动任何片段。
							</div>
						</div>
					)}
				</BarMenu>

				{/* 预览缩放（纯显示，不写进任何数据） */}
				<BarMenu title="预览缩放（只改看起来多大，不改素材与成片）" width={200} icon={<ZoomIn size={12} />} label={zoomLabel}>
					{(close) => (
						<div>
							{RTC_ZOOM_STEPS.map((z) => (
								<MenuRow
									key={z.id}
									active={sameZoom(zoom, z.mode)}
									title={z.mode === "fit" ? "画幅框适应预览区（默认）" : `画幅原始像素的 ${Math.round((z.mode as number) * 100)}%`}
									onClick={() => { useRtcPreviewStore.getState().setZoom(z.mode); close(); }}
								>
									<span>{z.label}</span>
									{z.mode === "fit" && zoomPct != null ? <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{zoomPct}%</span> : null}
								</MenuRow>
							))}
							<div style={{ marginTop: 4, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.07)", fontSize: 10, lineHeight: 1.6, color: "rgba(255,255,255,0.42)" }}>
								缩放的是整个画幅（黑边外即画幅之外）。放大超出预览区时居中裁切，按「适应」一键看全。
							</div>
						</div>
					)}
				</BarMenu>

				<button type="button" title={isFullscreen ? "退出全屏（Esc）" : "全屏预览"} onClick={toggleFullscreen} style={{ ...barBtn, padding: "0 6px" }}>
					{isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
				</button>

				{/* 本模式设置：打开「实时剪辑 · 设置」弹窗的预览页（第238轮起收编进设置二级界面，
				    原上拉面板退役——快捷键/剪辑/预览三页签都在弹窗里） */}
				<button
					type="button"
					title="设置（快捷键 / 剪辑 / 预览）"
					onClick={() => useRtcSettingsModal.getState().openModal("preview")}
					style={{ ...barBtn, padding: "0 6px" }}
				>
					<Settings2 size={13} />
				</button>
			</div>
		</div>
	);
}

/** 画幅比例文本（约分，如 1920×1080 → 16:9） */
function aspectTextOf(w: number, h: number): string {
	const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
	const d = gcd(w, h) || 1;
	return `${w / d}:${h / d}`;
}

/** 缩放档比较（"fit" 与数字混合联合） */
function sameZoom(a: RtcZoomMode, b: RtcZoomMode): boolean {
	if (a === "fit" || b === "fit") return a === b;
	return Math.abs(a - b) < 1e-6;
}
