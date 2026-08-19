/**
 * RtcToolbar —— 实时剪辑工具条：撤销/重做（灰态跟随栈）、复制/粘贴、播放头处分割、
 * 删除选中 / 波纹删除、吸附开关、缩放（滑杆+加减）、画幅（比例+分辨率）、加视频/音频轨、
 * 播放头时间码；右端「快捷键」速查表与「导出剪映草稿」。
 *
 * ⚠ 剪辑动作全部复用 [timeline/rtcEditActions]（与快捷键、右键菜单同一份实现，一次动作一条 undo）。
 */
import { useEffect, useRef, useState } from "react";
import {
	ClipboardPaste,
	Copy,
	FileOutput,
	Keyboard,
	Magnet,
	Plus,
	Proportions,
	Redo2,
	Scissors,
	ScissorsLineDashed,
	ScrollText,
	Trash2,
	Undo2,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { addTrack, formatTimecode } from "@/lib/rtcOps";
import { useRtcStore } from "@/store/rtcStore";
import { useRtcClipboard } from "./rtcClipboard";
import { RtcSettingsModal } from "./settings/RtcSettingsModal";
import { useRtcSettingsModal } from "./settings/rtcSettingsModalStore";
import {
	copySelection,
	deleteSelection,
	pasteClipboard,
	rippleDeleteSelection,
	splitSelectionAtPlayhead,
} from "./timeline/rtcEditActions";
import { docCanvas, type RtcTrackType } from "@/types/rtc";
import {
	RTC_ASPECTS,
	RTC_RESOLUTIONS,
	canvasSizeOf,
	findAspect,
	formatCanvasLabel,
	resolveCanvasPreset,
	sameCanvas,
} from "./rtcCanvasSpec";

const MIN_Z = 10;
const MAX_Z = 400;
const sliderFromZoom = (z: number) =>
	Math.round((100 * Math.log(Math.min(MAX_Z, Math.max(MIN_Z, z)) / MIN_Z)) / Math.log(MAX_Z / MIN_Z));
const zoomFromSlider = (v: number) => MIN_Z * Math.pow(MAX_Z / MIN_Z, v / 100);

const BTN =
	"h-7 w-7 flex items-center justify-center rounded text-muted-foreground hover:bg-white/10 hover:text-secondary-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground";

function Divider() {
	return <div className="w-px h-4 bg-white/10 mx-1.5 shrink-0" />;
}

/** 播放头时间码（独立订阅：拖播放头只重渲它） */
function Timecode() {
	const playheadUs = useRtcStore((s) => s.playheadUs);
	const fps = useRtcStore((s) => s.doc?.fps ?? 30);
	return (
		<span className="font-mono text-xs text-secondary-foreground tabular-nums select-none">
			{formatTimecode(playheadUs, fps)}
		</span>
	);
}

/**
 * 画幅选择器：比例（16:9/9:16/…）+ 分辨率（720P/1080P/2K/4K）两组档位，实时显示当前像素。
 * 切换即 commit 一次（可 Ctrl+Z 回退）；画幅只影响预览框比例与导出尺寸，不动任何片段。
 * ⚠ 读画幅一律走 docCanvas()（唯一入口，含缺省回退）；选择器只订阅宽高两个数字，
 *   不返回对象（zustand 选择器返回新对象会破坏快照缓存）。
 */
function CanvasPicker() {
	const hasDoc = useRtcStore((s) => !!s.doc);
	const width = useRtcStore((s) => (s.doc ? docCanvas(s.doc).width : 0));
	const height = useRtcStore((s) => (s.doc ? docCanvas(s.doc).height : 0));
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	// 点击下拉外 / Esc 关闭（与画布分集下拉同款）
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	if (!hasDoc) return null;

	const canvas = { width, height };
	const preset = resolveCanvasPreset(canvas);
	const label = formatCanvasLabel(canvas);

	/** 切换档位：算出新像素 → 与当前相同则不 commit（不污染撤销栈） */
	const apply = (aspectId: string, resolutionId: string) => {
		const next = canvasSizeOf(aspectId, resolutionId);
		if (sameCanvas(next, canvas)) return;
		useRtcStore.getState().commit((d) => ({ ...d, canvas: next }));
	};

	const chip = (active: boolean) =>
		`h-6 px-2 rounded text-[11px] border transition-colors ${
			active
				? "border-[var(--primary)] text-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_15%,transparent)]"
				: "border-white/10 text-muted-foreground hover:text-secondary-foreground hover:bg-white/10"
		}`;

	return (
		<div ref={wrapRef} className="relative">
			<button
				type="button"
				title={`画幅：${label}（点击切换比例与分辨率）`}
				className="h-7 px-2 flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:bg-white/10 hover:text-secondary-foreground"
				onClick={() => setOpen((v) => !v)}
			>
				<Proportions size={13} />
				<span className="font-mono tabular-nums">{preset.exact ? `${findAspect(preset.aspectId)?.ratioText} · ${preset.resolutionId}` : `${width}×${height}`}</span>
			</button>
			{open && (
				<div className="absolute left-0 bottom-full mb-1 z-50 w-[268px] rounded-md border border-white/10 bg-[var(--popover,#1c1c1e)] shadow-xl p-2.5 space-y-2.5">
					<div>
						<div className="text-[10px] text-muted-foreground mb-1.5">比例</div>
						<div className="flex flex-wrap gap-1">
							{RTC_ASPECTS.map((a) => (
								<button
									key={a.id}
									type="button"
									title={a.label}
									className={chip(preset.aspectId === a.id)}
									onClick={() => apply(a.id, preset.resolutionId)}
								>
									{a.label}
								</button>
							))}
						</div>
					</div>
					<div>
						<div className="text-[10px] text-muted-foreground mb-1.5">分辨率（短边）</div>
						<div className="flex flex-wrap gap-1">
							{RTC_RESOLUTIONS.map((r) => (
								<button
									key={r.id}
									type="button"
									title={`短边 ${r.shortSide}px`}
									className={chip(preset.resolutionId === r.id)}
									onClick={() => apply(preset.aspectId, r.id)}
								>
									{r.label}
								</button>
							))}
						</div>
					</div>
					<div className="pt-1.5 border-t border-white/5 space-y-1">
						<div className="text-[11px] text-secondary-foreground font-mono tabular-nums">{label}</div>
						{/* 用户定心丸：切画幅不会裁画面/动片段 */}
						<div className="text-[10px] text-muted-foreground leading-relaxed">
							画幅只决定预览框比例与导出成片尺寸，不会裁剪或改动任何片段。
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** 快捷键入口：打开「实时剪辑 · 设置」弹窗的快捷键页（速查/改键都在那里，键位单一来源） */
function ShortcutEntry() {
	return (
		<button
			type="button"
			title="快捷键（查看与自定义键位）"
			className={BTN}
			onClick={() => useRtcSettingsModal.getState().openModal("keys")}
		>
			<Keyboard size={15} />
		</button>
	);
}

export function RtcToolbar() {
	const canUndo = useRtcStore((s) => s.past.length > 0);
	const canRedo = useRtcStore((s) => s.future.length > 0);
	const hasSelection = useRtcStore((s) => s.selection.length > 0);
	const canPaste = useRtcClipboard((s) => s.entries.length > 0);
	const snapOn = useRtcStore((s) => s.snapOn);
	const scriptVisible = useRtcStore((s) => s.scriptTrackVisible);
	const pxPerSec = useRtcStore((s) => s.pxPerSec);
	const [exportBusy, setExportBusy] = useState(false);
	const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);

	const onAddTrack = (type: RtcTrackType) => {
		useRtcStore.getState().commitActive((d) => addTrack(d, type)); // 集成轮：编辑层感知（子层=加进子文档）
	};
	const onExport = async () => {
		if (exportBusy) return;
		setExportBusy(true);
		setExportMsg(null);
		try {
			const { exportRtcDocToJianying } = await import("@/services/jianyingExport");
			const r = await exportRtcDocToJianying();
			if (r.ok) {
				const warn = r.warnings?.length ? `（${r.warnings.length} 条提醒）` : "";
				setExportMsg({ ok: true, text: `已导出草稿「${r.draftName}」${warn}，打开剪映即可看到` });
			} else {
				setExportMsg({ ok: false, text: r.error || "导出失败" });
			}
		} catch (e) {
			setExportMsg({ ok: false, text: String((e as Error)?.message || e) });
		} finally {
			setExportBusy(false);
		}
	};

	const st = useRtcStore.getState();
	return (
		<div className="h-10 shrink-0 flex items-center px-3 gap-0.5 bg-secondary/30 border-y border-white/5">
			<button type="button" title="撤销（Ctrl+Z）" className={BTN} disabled={!canUndo} onClick={() => st.undo()}>
				<Undo2 size={15} />
			</button>
			<button type="button" title="重做（Ctrl+Shift+Z / Ctrl+Y）" className={BTN} disabled={!canRedo} onClick={() => st.redo()}>
				<Redo2 size={15} />
			</button>
			<Divider />
			<button
				type="button"
				title="复制选中片段（Ctrl+C）"
				className={BTN}
				disabled={!hasSelection}
				onClick={() => copySelection()}
			>
				<Copy size={15} />
			</button>
			<button
				type="button"
				title="粘贴到播放头处（Ctrl+V，落回原轨道；该处被占则夹到最近空隙）"
				className={BTN}
				disabled={!canPaste}
				onClick={() => pasteClipboard()}
			>
				<ClipboardPaste size={15} />
			</button>
			<Divider />
			<button
				type="button"
				title="在播放头处分割选中片段（B / Ctrl+K；Ctrl+B=全部轨道批量分割）"
				className={BTN}
				disabled={!hasSelection}
				onClick={() => splitSelectionAtPlayhead()}
			>
				<Scissors size={15} />
			</button>
			<button
				type="button"
				title="删除选中片段，原位留下空隙（Delete）"
				className={BTN}
				disabled={!hasSelection}
				onClick={() => deleteSelection()}
			>
				<Trash2 size={15} />
			</button>
			<button
				type="button"
				title="波纹删除：删除后同一轨道右侧的片段整体左移补位，其它轨道不动（Shift+Delete）"
				className={BTN}
				disabled={!hasSelection}
				onClick={() => rippleDeleteSelection()}
			>
				<ScissorsLineDashed size={15} />
			</button>
			<Divider />
			<button
				type="button"
				title={snapOn ? "关闭磁吸" : "开启磁吸"}
				className={`${BTN} ${snapOn ? "!text-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_15%,transparent)]" : ""}`}
				onClick={() => st.toggleSnap()}
			>
				<Magnet size={15} />
			</button>
			<Divider />
			<button type="button" title="缩小时间轴" className={BTN} onClick={() => st.setZoom(pxPerSec / 1.25)}>
				<ZoomOut size={15} />
			</button>
			<input
				type="range"
				min={0}
				max={100}
				value={sliderFromZoom(pxPerSec)}
				onChange={(e) => st.setZoom(zoomFromSlider(Number(e.target.value)))}
				title="时间轴缩放"
				className="w-24 h-1 accent-[var(--primary)] cursor-pointer"
			/>
			<button type="button" title="放大时间轴" className={BTN} onClick={() => st.setZoom(pxPerSec * 1.25)}>
				<ZoomIn size={15} />
			</button>
			<Divider />
			<CanvasPicker />
			<Divider />
			<button
				type="button"
				title="新增视频轨"
				className="h-7 px-2 flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:bg-white/10 hover:text-secondary-foreground"
				onClick={() => onAddTrack("video")}
			>
				<Plus size={13} style={{ color: "var(--node-video)" }} />
				视频轨
			</button>
			<button
				type="button"
				title="新增音频轨"
				className="h-7 px-2 flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:bg-white/10 hover:text-secondary-foreground"
				onClick={() => onAddTrack("audio")}
			>
				<Plus size={13} style={{ color: "var(--node-audio)" }} />
				音频轨
			</button>
			<button
				type="button"
				title={`${scriptVisible ? "隐藏" : "显示"}预览窗的原文参考条（O）——原文实时提取自主轨各分镜，跟随片段挪动/分割/伸缩；恒不导出剪映`}
				className={`h-7 px-2 flex items-center gap-1 rounded text-[11px] ${scriptVisible ? "text-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_15%,transparent)]" : "text-muted-foreground hover:bg-white/10 hover:text-secondary-foreground"}`}
				onClick={() => st.toggleScriptTrackVisible()}
			>
				<ScrollText size={13} />
				原文
			</button>
			<Divider />
			<Timecode />
			<div className="ml-auto flex items-center gap-2">
				<ShortcutEntry />
				{exportMsg && (
					<span
						className={`text-[11px] select-none max-w-[360px] truncate ${exportMsg.ok ? "text-muted-foreground" : "text-red-400"}`}
						title={exportMsg.text}
					>
						{exportMsg.text}
					</span>
				)}
				<button
					type="button"
					title="把当前时间轴导出为剪映草稿（写入剪映草稿目录）"
					className="h-7 px-2.5 flex items-center gap-1.5 rounded text-[11px] text-secondary-foreground bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-40"
					disabled={exportBusy}
					onClick={onExport}
				>
					<FileOutput size={13} />
					{exportBusy ? "正在导出…" : "导出剪映草稿"}
				</button>
			</div>
			{/* 设置弹窗常驻挂载点（工具条与播放器两处入口共用 rtcSettingsModalStore 开关） */}
			<RtcSettingsModal />
		</div>
	);
}
