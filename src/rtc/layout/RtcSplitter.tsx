/**
 * RtcSplitter —— 通用拖动分隔条（实时剪辑布局用）。
 *
 * 受控语义：拖动中逐帧回调 onPreview(v)（调用方用**本地 state** 承接实时预览）、
 * pointerup 才回调 onCommit(v)（调用方此刻才写 rtcLayoutStore → localStorage）——
 * ⚠ 性能红线：本组件绝不直接写 store/localStorage；未发生位移的点击不触发任何回调。
 *
 * orientation："x"=竖条拖水平尺寸（col-resize）、"y"=横条拖竖直尺寸（row-resize）；
 * invert=true 时指针负方向位移=增大（右栏左缘手柄 / 底部时间轴上缘手柄用它）。
 * 尺寸/定位类（宽高、absolute 等）由调用方经 className 提供，本组件只带交互与配色。
 */
import { useRef } from "react";
import { clamp } from "./rtcLayoutCore";

export interface RtcSplitterProps {
	orientation: "x" | "y";
	/** 当前值（拖动开始那一刻采样为基准；预览期间父级传回 live 值也不影响基准） */
	value: number;
	min: number;
	max: number;
	invert?: boolean;
	onPreview: (v: number) => void;
	onCommit: (v: number) => void;
	className?: string;
	title?: string;
}

export function RtcSplitter({ orientation, value, min, max, invert, onPreview, onCommit, className, title }: RtcSplitterProps) {
	const valueRef = useRef(value);
	valueRef.current = value;
	const dragRef = useRef<{ start: number; base: number; moved: boolean } | null>(null);
	// min/max/invert 拖动中现读最新（视口变化时钳位跟随）
	const boundsRef = useRef({ min, max, invert: !!invert });
	boundsRef.current = { min, max, invert: !!invert };

	const posOf = (e: React.PointerEvent) => (orientation === "x" ? e.clientX : e.clientY);
	const valOf = (e: React.PointerEvent) => {
		const drag = dragRef.current!;
		const { min: lo, max: hi, invert: inv } = boundsRef.current;
		const delta = (posOf(e) - drag.start) * (inv ? -1 : 1);
		return clamp(Math.round(drag.base + delta), lo, hi);
	};

	return (
		<div
			title={title}
			className={`shrink-0 select-none z-20 transition-colors bg-transparent hover:bg-[color-mix(in_srgb,var(--primary)_35%,transparent)] active:bg-[color-mix(in_srgb,var(--primary)_55%,transparent)] ${
				orientation === "x" ? "cursor-col-resize" : "cursor-row-resize"
			} ${className ?? ""}`}
			style={{ touchAction: "none" }}
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				dragRef.current = { start: posOf(e), base: valueRef.current, moved: false };
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
				e.preventDefault();
			}}
			onPointerMove={(e) => {
				const drag = dragRef.current;
				if (!drag) return;
				if (!drag.moved && Math.abs(posOf(e) - drag.start) < 2) return;
				drag.moved = true;
				onPreview(valOf(e));
			}}
			onPointerUp={(e) => {
				const drag = dragRef.current;
				dragRef.current = null;
				if (!drag || !drag.moved) return;
				onCommit(valOf(e));
			}}
			onPointerCancel={(e) => {
				const drag = dragRef.current;
				dragRef.current = null;
				if (!drag || !drag.moved) return;
				onCommit(valOf(e));
			}}
		/>
	);
}
