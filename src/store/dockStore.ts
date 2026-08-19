/**
 * dockStore —— 右侧悬浮助手「停靠位」的共享位置。
 *
 * 资产助手（上）、简一助手（下）两个悬浮按钮共用同一份停靠坐标，
 * 始终竖直叠放、同步移动：拖动任一按钮 → 整组一起走，松手吸附左/右边缘。
 * 锚点 = 最上方的资产助手按钮；各按钮按 deltaY = n×DOCK_STACK 依次向下排列。
 * 位置持久到 localStorage（沿用旧 key `Qiji:assistantPos`，老用户位置不丢）。
 */
import { create } from "zustand";

export const DOCK_BTN = 48; // 悬浮按钮直径
export const DOCK_GAP = 12; // 相邻按钮竖直间距
/** 锚点（上按钮）到下一个按钮顶部的竖直距离 */
export const DOCK_STACK = DOCK_BTN + DOCK_GAP;
/** 停靠组按钮数量（资产助手 / 简一助手） */
export const DOCK_COUNT = 2;

export type DockSide = "left" | "right";
export interface DockPos {
	side: DockSide;
	top: number;
}

const POS_KEY = "Qiji:assistantPos";

function viewportH(): number {
	return typeof window !== "undefined" ? window.innerHeight : 800;
}

/** 把锚点 top 钳制在可视范围内（保证整组按钮都不出屏） */
export function clampDockTop(top: number): number {
	const stackH = (DOCK_COUNT - 1) * DOCK_STACK + DOCK_BTN; // 锚点顶到最下按钮底的总高
	const max = Math.max(8, viewportH() - stackH - 8);
	return Math.min(Math.max(top, 8), max);
}

function loadPos(): DockPos {
	try {
		const r = localStorage.getItem(POS_KEY);
		if (r) {
			const p = JSON.parse(r) as DockPos;
			return { side: p.side === "left" ? "left" : "right", top: clampDockTop(p.top) };
		}
	} catch {
		/* ignore */
	}
	return { side: "right", top: Math.round(viewportH() * 0.4) };
}

interface DockState {
	/** 锚点（上按钮）停靠位 */
	pos: DockPos;
	/** 拖动中：锚点（上按钮）左上角的实时坐标；非拖动为 null */
	drag: { x: number; y: number } | null;
	setPos: (p: DockPos) => void;
	setDrag: (d: { x: number; y: number } | null) => void;
}

export const useDockStore = create<DockState>((set) => ({
	pos: loadPos(),
	drag: null,
	setPos: (pos) => {
		try {
			localStorage.setItem(POS_KEY, JSON.stringify(pos));
		} catch {
			/* ignore */
		}
		set({ pos });
	},
	setDrag: (drag) => set({ drag }),
}));

/**
 * 悬浮按钮的拖动 / 点击处理（资产助手、简一助手共用）。
 *  - `deltaY`：本按钮顶部相对锚点（最上按钮）的竖直偏移（资产助手=0，简一助手=DOCK_STACK）。
 *  - 几乎没移动（<4px）→ 视为点击，触发 `onClick`（展开对应面板）。
 *  - 有移动 → 整组同步移动，松手吸附最近边缘并记忆。
 */
export function startDockDrag(e: React.MouseEvent, deltaY: number, onClick: () => void): void {
	const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
	const offX = e.clientX - rect.left;
	const offY = e.clientY - rect.top;
	const startX = e.clientX;
	const startY = e.clientY;
	let moved = false;

	const onMove = (ev: MouseEvent) => {
		if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) moved = true;
		if (moved) {
			// 锚点左上角 = 本按钮左上角 − 偏移（下按钮减去 deltaY 回到锚点）
			useDockStore.getState().setDrag({ x: ev.clientX - offX, y: ev.clientY - offY - deltaY });
		}
	};
	const onUp = (ev: MouseEvent) => {
		window.removeEventListener("mousemove", onMove);
		window.removeEventListener("mouseup", onUp);
		if (moved) {
			const side: DockSide = ev.clientX < window.innerWidth / 2 ? "left" : "right";
			const top = clampDockTop(ev.clientY - offY - deltaY);
			useDockStore.getState().setPos({ side, top });
		} else {
			onClick();
		}
		useDockStore.getState().setDrag(null);
	};
	window.addEventListener("mousemove", onMove);
	window.addEventListener("mouseup", onUp);
}
