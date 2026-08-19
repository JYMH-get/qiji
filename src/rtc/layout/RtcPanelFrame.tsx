/**
 * RtcPanelFrame —— 上排面板的统一标题栏包装（素材面板 / 结果展示 / 属性面板）。
 *
 * 职责：
 *   - 标题栏 = 面板名 + 拖动手柄区（HTML5 DnD，MIME `application/x-qiji-rtc-panel`）：
 *     按住标题栏拖到另一个面板上方 → 目标整框高亮 → 松手两面板**交换槽位**（swapPanels）；
 *   - 槽位顺序用 **CSS order** 落地（FrameEditor 恒按固定 JSX 顺序渲染三个 Frame）——
 *     ⚠ 换位零 DOM 重排零子树重建，播放中的 RtcSequencePlayer 不被打断，勿改成重排 children；
 *   - 定宽面板（asset/props）带边缘 RtcSplitter 拖宽（side 由 FrameEditor 按「面向 stage 的边」算出）；
 *   - 内部组件零改动：RtcAssetPanel/RtcPropertyPanel 自带的 w-[300px]/w-[360px] 由内容层
 *     `[&>*]:!w-full` 覆盖成跟随包装层宽度（不动面板源码）。
 */
import { useState, type ReactNode } from "react";
import { GripVertical, RotateCcw } from "lucide-react";
import type { RtcSlotId } from "./rtcLayoutCore";
import { RtcSplitter } from "./RtcSplitter";

export const PANEL_MIME = "application/x-qiji-rtc-panel";

/** 当前被拖动的面板槽位（dragover 里读不到 dataTransfer 数据，模块级变量补位；dragend 清空） */
let draggingSlot: RtcSlotId | null = null;

export interface RtcPanelResize {
	/** 手柄贴在面板哪条竖边（= 面向中央 stage 的那条边） */
	side: "left" | "right";
	value: number;
	min: number;
	max: number;
	onPreview: (v: number) => void;
	onCommit: (v: number) => void;
}

export interface RtcPanelFrameProps {
	slot: RtcSlotId;
	title: string;
	/** CSS order（= slotOrder.indexOf(slot)） */
	order: number;
	/** stage 用：flex-1 吃剩余宽；定宽面板传 width */
	flex?: boolean;
	width?: number;
	resize?: RtcPanelResize;
	onSwap: (a: RtcSlotId, b: RtcSlotId) => void;
	/** 「重置布局」小按钮（只放一个面板的标题栏，从简） */
	onResetLayout?: () => void;
	/** 标题栏左侧扩展区（紧跟面板名之后；中栏放分集下拉/分集命名）。
	 *  ⚠ 内含交互控件须自行 draggable={false} + onMouseDown stopPropagation（标题栏整条可拖起换位） */
	headerExtra?: ReactNode;
	children: ReactNode;
}

export function RtcPanelFrame({ slot, title, order, flex, width, resize, onSwap, onResetLayout, headerExtra, children }: RtcPanelFrameProps) {
	const [dropOver, setDropOver] = useState(false);

	return (
		<section
			className={`relative flex flex-col min-h-0 min-w-0 ${flex ? "flex-1" : "shrink-0"}`}
			style={{ order, ...(flex ? {} : { width }) }}
			onDragOver={(e) => {
				if (!draggingSlot || draggingSlot === slot) return;
				if (!Array.from(e.dataTransfer.types).includes(PANEL_MIME)) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				setDropOver(true);
			}}
			onDragLeave={(e) => {
				if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropOver(false);
			}}
			onDrop={(e) => {
				setDropOver(false);
				const src = (e.dataTransfer.getData(PANEL_MIME) || draggingSlot) as RtcSlotId | "";
				draggingSlot = null;
				if (!src || src === slot) return;
				e.preventDefault();
				onSwap(src, slot);
			}}
		>
			{/* 统一标题栏：面板名 + 手柄（整条可拖起换位） */}
			<div
				draggable
				onDragStart={(e) => {
					draggingSlot = slot;
					e.dataTransfer.setData(PANEL_MIME, slot);
					e.dataTransfer.effectAllowed = "move";
				}}
				onDragEnd={() => {
					draggingSlot = null;
				}}
				title="按住拖到另一个面板上可交换位置"
				className="h-7 shrink-0 flex items-center gap-1.5 px-2 bg-[#12141a] border-b border-white/10 cursor-grab active:cursor-grabbing select-none"
			>
				<GripVertical size={12} className="text-white/30 shrink-0" />
				<span className="text-[11px] text-white/70 truncate shrink-0">{title}</span>
				{headerExtra}
				{onResetLayout && (
					<button
						type="button"
						title="重置布局（面板位置与全部尺寸恢复默认）"
						draggable={false}
						onClick={onResetLayout}
						onMouseDown={(e) => e.stopPropagation()}
						className="ml-auto h-5 w-5 flex items-center justify-center rounded text-white/35 hover:text-white/80 hover:bg-white/10"
					>
						<RotateCcw size={11} />
					</button>
				)}
			</div>
			{/* 内容层：内部组件零改动，用 [&>*]:!w-full 覆盖其自带定宽（w-[300px]/w-[360px]）跟随包装层 */}
			<div className="flex-1 min-h-0 min-w-0 flex overflow-hidden [&>*]:!w-full [&>*]:!min-w-0">{children}</div>
			{/* 换位吸附提示：目标面板整框高亮 */}
			{dropOver && (
				<div className="absolute inset-0 z-30 pointer-events-none ring-2 ring-inset ring-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]" />
			)}
			{/* 定宽面板的拖宽手柄（贴面向 stage 的竖边；左缘手柄=负方向增大） */}
			{resize && (
				<RtcSplitter
					orientation="x"
					value={resize.value}
					min={resize.min}
					max={resize.max}
					invert={resize.side === "left"}
					onPreview={resize.onPreview}
					onCommit={resize.onCommit}
					title="拖动调整面板宽度"
					className={`absolute inset-y-0 w-1.5 ${resize.side === "left" ? "left-0" : "right-0"}`}
				/>
			)}
		</section>
	);
}
