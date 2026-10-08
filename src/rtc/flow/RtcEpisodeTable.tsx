import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { useSettingsStore } from "@/store/settingsStore";

const COLUMNS = [
	["分镜", "col-shot"], ["分镜原文", "col-script"], ["素材区", "col-material"],
	["提示词区", "col-prompt"], ["分镜图", "col-image"],
] as const;
const MIN_WIDTH = 80;

/** 与资产视频页一样拖表头右边界；仅松手保存，布局不进入项目与撤销历史。 */
export function RtcEpisodeTable({ children }: { children: ReactNode }) {
	const saved = useSettingsStore(s => s.rtcOverviewColWidths);
	const [preview, setPreview] = useState<number[] | null>(null);
	const tableRef = useRef<HTMLTableElement>(null);
	const drag = useRef<{ index: number; x: number; widths: number[]; moved: boolean; pointerId: number } | null>(null);
	const widths = preview ?? saved;
	const total = widths?.reduce((sum, width) => sum + width, 0);
	// 第一次拖动按实际自适应后的列宽冻结，避免点击边界时整表跳动。
	const measure = () => Array.from(tableRef.current!.tHead!.rows[0].cells, cell => Math.round(cell.getBoundingClientRect().width));
	const resize = (base: number[], index: number, delta: number) => base.map((width, i) => i === index ? Math.max(MIN_WIDTH, Math.round(width + delta)) : width);
	const finish = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
		const current = drag.current;
		if (!current || current.pointerId !== event.pointerId) return;
		drag.current = null;
		if (commit && current.moved) useSettingsStore.getState().setRtcOverviewColWidths(resize(current.widths, current.index, event.clientX - current.x));
		setPreview(null);
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
	};
	return <table ref={tableRef} className="rtc-episode-table" aria-label="本集分镜表格" style={total == null ? undefined : { width: total, minWidth: total }}>
		<colgroup>{COLUMNS.map(([label, cls], index) => <col key={label} className={cls} style={widths ? { width: widths[index] } : undefined} />)}</colgroup>
		<thead><tr>{COLUMNS.map(([label], index) => <th scope="col" key={label}>
			{label}
			<div role="separator" tabIndex={0} aria-label={`调整${label}列宽`} aria-orientation="vertical" aria-valuemin={MIN_WIDTH} aria-valuenow={widths?.[index]}
				title="拖动调整列宽" className="rtc-episode-col-resize"
				onPointerDown={event => {
					if (event.button !== 0) return;
					event.preventDefault(); event.stopPropagation();
					drag.current = { index, x: event.clientX, widths: measure(), moved: false, pointerId: event.pointerId };
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={event => {
					const current = drag.current;
					if (!current || current.pointerId !== event.pointerId) return;
					const delta = event.clientX - current.x;
					if (!current.moved && Math.abs(delta) < 2) return;
					current.moved = true;
					setPreview(resize(current.widths, current.index, delta));
				}}
				onPointerUp={event => finish(event, true)} onPointerCancel={event => finish(event, false)}
				onLostPointerCapture={event => finish(event, false)}
				onKeyDown={event => {
					if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
					event.preventDefault(); event.stopPropagation();
					useSettingsStore.getState().setRtcOverviewColWidths(resize(measure(), index, (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 50 : 10)));
				}} />
		</th>)}</tr></thead>
		{children}
	</table>;
}
