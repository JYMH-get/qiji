/**
 * JianyiAssistant —— 「简一助手」管理器（资产助手下方的机器人入口 + 多窗口/分身）。
 *
 * 机器人图标常驻停靠位（dockStore，与资产助手竖直叠放、同步移动）：
 *   - 点击：无窗口→打开一个；已有窗口→全部收起（与资产助手「点击展开 / 双击外部收起」一致）。
 *   - 双击任意简一助手窗口之外（且非机器人图标）→ 收起全部。
 * 每个窗口（[JianyiWindow](src/components/JianyiWindow.tsx)）独立浏览/对话一个会话，可同时使用多个（分身）。
 */
import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { useDockStore, startDockDrag, DOCK_BTN, DOCK_STACK } from "@/store/dockStore";
import { useJianyiStore } from "@/store/jianyiAssistantStore";
import { usePromptModalStore } from "@/store/promptModalStore";
import JianyiWindow, { loadSize } from "./JianyiWindow";

const accent = "#22c55e";

interface WinState {
	winId: string;
	sessionId: string;
	x: number;
	y: number;
}

let _win = 0;
const nextWinId = () => `jw-${++_win}`;

/**
 * 窗口初始坐标：默认居中（按记忆尺寸算中心），第 n 个（分身）按顺序级联偏移避免重叠。
 * 关闭全部后重开 n 归零→重新居中。
 */
function basePos(n: number): { x: number; y: number } {
	const viewW = typeof window !== "undefined" ? window.innerWidth : 1200;
	const viewH = typeof window !== "undefined" ? window.innerHeight : 800;
	const { w, h } = loadSize();
	const cx = Math.max(12, Math.round((viewW - w) / 2));
	const cy = Math.max(12, Math.round((viewH - h) / 2));
	const off = (n % 6) * 32;
	return { x: Math.min(cx + off, Math.max(12, viewW - 120)), y: Math.min(cy + off, Math.max(12, viewH - 120)) };
}

/** 最近活跃的会话 id（按 updatedAt），无则新建一个 */
function recentSessionId(): string {
	const sessions = useJianyiStore.getState().sessions;
	if (!sessions.length) return useJianyiStore.getState().newSession();
	return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
}

export default function JianyiAssistant() {
	const { pos, drag } = useDockStore();
	const [windows, setWindows] = useState<WinState[]>([]);
	// 提示词放大弹窗打开时抬到其上方（便于放大编辑时打开助手）
	const promptModalOpen = usePromptModalStore((s) => s.open);
	const zBase = promptModalOpen ? 100100 : 9000;

	const spawn = (sessionId: string) => {
		// 居中：第一个窗口（ws.length=0）正中；分身按当前窗口数级联偏移
		setWindows((ws) => {
			const p = basePos(ws.length);
			return [...ws, { winId: nextWinId(), sessionId, x: p.x, y: p.y }];
		});
	};

	const open = () => spawn(recentSessionId()); // 机器人仅在无窗口时显示，点击打开最近会话
	const cloneWin = () => spawn(useJianyiStore.getState().newSession()); // 分身=新会话独立窗口
	const closeWin = (winId: string) => setWindows((ws) => ws.filter((w) => w.winId !== winId));

	// 双击任意简一助手窗口之外（且非机器人图标）→ 收起全部
	useEffect(() => {
		if (windows.length === 0) return;
		const onDbl = (e: MouseEvent) => {
			const t = e.target as HTMLElement | null;
			if (t && (t.closest(".jy-window") || t.closest(".jy-dock-btn"))) return;
			setWindows([]);
		};
		document.addEventListener("dblclick", onDbl);
		return () => document.removeEventListener("dblclick", onDbl);
	}, [windows.length]);

	const style: React.CSSProperties = drag
		? { left: drag.x, top: drag.y + DOCK_STACK }
		: { [pos.side]: 14, top: pos.top + DOCK_STACK };

	return (
		<>
			{windows.length === 0 && (
				<button
					className="jy-dock-btn"
					onMouseDown={(e) => startDockDrag(e, DOCK_STACK, open)}
					title="简一助手（点击展开 · 可拖动；双击界面外收起）"
					style={{
						position: "fixed",
						zIndex: zBase,
						width: DOCK_BTN,
						height: DOCK_BTN,
						borderRadius: "50%",
						border: "none",
						cursor: drag ? "grabbing" : "grab",
						background: accent,
						color: "#06280f",
						boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						userSelect: "none",
						...style,
					}}
				>
					<Bot size={22} />
				</button>
			)}
			{windows.map((w) => (
				<JianyiWindow key={w.winId} initialSessionId={w.sessionId} initX={w.x} initY={w.y} onClose={() => closeWin(w.winId)} onClone={cloneWin} />
			))}
		</>
	);
}
