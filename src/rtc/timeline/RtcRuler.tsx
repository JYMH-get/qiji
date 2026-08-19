/** 时间标尺：主刻度随缩放取 1s/5s/10s/30s/1m 档 + 1/5 次刻度；播放头三角标记独立订阅（拖播放头不重渲刻度）。
 *  ── 第二批：标记（doc 级小旗）——渲染在刻度之上：点击=跳转、右键=小菜单（换色/备注/删除）、
 *  **双击标尺空白=添加标记**（本批唯一自带的交互入口；快捷键 M 系待接线，见 rtcMarkerActions）。 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { rulerStepUs, formatTimecode } from "@/lib/rtcOps";
import { RTC_MARKER_COLORS, sanitizeMarkers } from "@/lib/rtcMarkers";
import type { RtcMarker } from "@/types/rtc";
import { useRtcStore } from "@/store/rtcStore";
import {
	addMarkerAt,
	jumpToMarker,
	removeMarkerById,
	setMarkerColorById,
	setMarkerNoteById,
} from "./rtcMarkerActions";
import { RULER_H } from "./timelineUtil";

const US_PER_SEC = 1_000_000;

function tickLabel(us: number): string {
	const total = Math.round(us / US_PER_SEC);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const p = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

/** 播放头在标尺上的三角标记（只有它订阅 playheadUs，拖动时其余刻度零重渲） */
function PlayheadMarker() {
	const playheadUs = useRtcStore((s) => s.playheadUs);
	const pxPerSec = useRtcStore((s) => s.pxPerSec);
	const x = (playheadUs / US_PER_SEC) * pxPerSec;
	return (
		<div
			className="absolute pointer-events-none"
			style={{
				left: x - 5,
				bottom: -1,
				width: 0,
				height: 0,
				borderLeft: "5px solid transparent",
				borderRight: "5px solid transparent",
				borderTop: "7px solid var(--primary)",
			}}
		/>
	);
}

/* ── 第二批：标记小旗 + 右键小菜单 ─────────────────────────────────────── */

interface MarkerMenuState {
	x: number;
	y: number;
	marker: RtcMarker;
}

/**
 * 标记小旗层（独立订阅 doc.markers：拖播放头/缩放不重渲它；读取先过 sanitizeMarkers 防御清洗）。
 * 点击=跳转（stopPropagation 防触发标尺 seek 拖动）、右键=打开小菜单、双击=拦下（防误加新标记）。
 */
function MarkersLayer({ pxPerSec, onMenu }: { pxPerSec: number; onMenu: (m: MarkerMenuState) => void }) {
	const raw = useRtcStore((s) => s.doc?.markers);
	const fps = useRtcStore((s) => s.doc?.fps ?? 30);
	const markers = useMemo(() => sanitizeMarkers(raw), [raw]);
	if (markers.length === 0) return null;
	return (
		<>
			{markers.map((m) => (
				<div
					key={m.id}
					data-marker={m.id}
					title={(m.note ? `${m.note} · ` : "") + formatTimecode(m.timeUs, fps) + "（点击跳转 · 右键编辑）"}
					onPointerDown={(e) => {
						// 拦下标尺的 seek 拖动手势——点小旗=精确跳到标记，不是就近 seek
						e.stopPropagation();
						jumpToMarker(m.timeUs);
					}}
					onDoubleClick={(e) => e.stopPropagation()}
					onContextMenu={(e) => {
						e.preventDefault();
						e.stopPropagation();
						onMenu({ x: e.clientX, y: e.clientY, marker: m });
					}}
					className="absolute cursor-pointer"
					style={{
						left: (m.timeUs / US_PER_SEC) * pxPerSec - 4,
						top: 1,
						width: 9,
						height: 11,
						background: m.color,
						// 小旗形态：上方矩形 + 底部尖角（指向精确时刻）
						clipPath: "polygon(0 0, 100% 0, 100% 62%, 50% 100%, 0 62%)",
						boxShadow: "0 0 0 1px rgba(0,0,0,0.45)",
						zIndex: 2,
					}}
				/>
			))}
		</>
	);
}

/** 标记右键小菜单：色板一排 + 备注输入 + 删除（点外部/Esc 关闭；fixed 定位，标尺无 transform 祖先） */
function MarkerMenu({ menu, onClose }: { menu: MarkerMenuState; onClose: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	const [note, setNote] = useState(menu.marker.note ?? "");
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		const onPointer = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) onClose();
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("pointerdown", onPointer, true);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("pointerdown", onPointer, true);
		};
	}, [onClose]);
	const commitNote = () => {
		if ((menu.marker.note ?? "") !== note) setMarkerNoteById(menu.marker.id, note);
	};
	return (
		<div
			ref={ref}
			className="fixed z-[100] rounded-lg border border-white/12 bg-[#1c1c1e] shadow-xl p-2"
			style={{ left: menu.x, top: menu.y + 4, width: 184 }}
			onPointerDown={(e) => e.stopPropagation()}
			onContextMenu={(e) => e.preventDefault()}
		>
			<div className="flex items-center gap-1.5 pb-1.5">
				{RTC_MARKER_COLORS.map((c) => (
					<button
						key={c}
						type="button"
						title="换成此色"
						onClick={() => { setMarkerColorById(menu.marker.id, c); onClose(); }}
						className="rounded-full cursor-pointer"
						style={{
							width: 14,
							height: 14,
							background: c,
							border: menu.marker.color === c ? "2px solid #fff" : "1px solid rgba(0,0,0,0.4)",
						}}
					/>
				))}
			</div>
			<input
				type="text"
				value={note}
				placeholder="备注（回车保存）"
				onChange={(e) => setNote(e.target.value)}
				onBlur={commitNote}
				onKeyDown={(e) => {
					if (e.key === "Enter") { commitNote(); onClose(); }
					if (e.key !== "Escape") e.stopPropagation(); // 别把按键漏给时间轴快捷键；Esc 放行给关闭监听
				}}
				className="w-full rounded-md border border-white/12 bg-white/5 px-2 py-1 text-[11px] text-white outline-none"
			/>
			<button
				type="button"
				onClick={() => { removeMarkerById(menu.marker.id); onClose(); }}
				className="mt-1.5 w-full rounded-md border border-red-400/40 bg-red-400/10 px-2 py-1 text-[11px] text-red-300 cursor-pointer"
			>
				删除标记
			</button>
		</div>
	);
}

export const RtcRuler = memo(function RtcRuler({ widthPx, pxPerSec }: { widthPx: number; pxPerSec: number }) {
	const [markerMenu, setMarkerMenu] = useState<MarkerMenuState | null>(null);
	const ticks = useMemo(() => {
		const stepUs = rulerStepUs(pxPerSec);
		const stepPx = (stepUs / US_PER_SEC) * pxPerSec;
		const minorPx = stepPx / 5;
		const out: Array<{ x: number; label?: string }> = [];
		const count = Math.ceil(widthPx / stepPx);
		for (let i = 0; i <= count; i++) {
			out.push({ x: i * stepPx, label: tickLabel(i * stepUs) });
			if (minorPx >= 10) {
				for (let j = 1; j < 5; j++) out.push({ x: i * stepPx + j * minorPx });
			}
		}
		return out;
	}, [pxPerSec, widthPx]);

	return (
		<div
			data-ruler
			className="relative cursor-pointer bg-[#0e1016] border-b border-white/10"
			style={{ width: widthPx, height: RULER_H }}
			// 双击标尺空白 = 在该时刻添加标记（第二批唯一自带的交互入口；小旗上的双击已被拦下）
			onDoubleClick={(e) => {
				const rect = e.currentTarget.getBoundingClientRect();
				const us = Math.max(0, Math.round(((e.clientX - rect.left) / pxPerSec) * US_PER_SEC));
				addMarkerAt(us);
			}}
		>
			{ticks.map((t, i) =>
				t.label != null ? (
					<div key={i} className="absolute bottom-0 pointer-events-none" style={{ left: t.x }}>
						<div className="w-px h-[10px] bg-white/25" />
						<span className="absolute left-[3px] bottom-[8px] text-[10px] leading-none text-muted-foreground whitespace-nowrap">
							{t.label}
						</span>
					</div>
				) : (
					<div key={i} className="absolute bottom-0 w-px h-[5px] bg-white/12 pointer-events-none" style={{ left: t.x }} />
				),
			)}
			<MarkersLayer pxPerSec={pxPerSec} onMenu={setMarkerMenu} />
			<PlayheadMarker />
			{markerMenu && <MarkerMenu menu={markerMenu} onClose={() => setMarkerMenu(null)} />}
		</div>
	);
});
