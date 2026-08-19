/**
 * NodeCountWarnToast —— 画布节点数量预警提示条（Canvas 挂载，自订阅小组件，§9：不牵动 Canvas 本体）。
 * 节点数越过阈值（350/450/500/550、之后每10，见 lib/nodeCountWarn）时顶部弹出提示：
 * 节点过多可能卡顿甚至保存时损坏项目文件。**仅提示不拦截**——无遮罩、不抢键、不挡画布操作，
 * 12s 自动消失/可手动关闭；驻留同档不重复提醒，回落后再次越过会重新提醒（含切画布）。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { advanceWarn } from "@/lib/nodeCountWarn";

const AUTO_HIDE_MS = 12_000;

export function NodeCountWarnToast() {
	// 单值选择器：仅节点数变化才重渲染（返回原始值，nodes map 引用变化不触发）
	const count = useCanvasStore((s) => Object.keys(s.nodes).length);
	const lastRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [warn, setWarn] = useState<{ at: number; count: number } | null>(null);

	useEffect(() => {
		const { warnAt, last } = advanceWarn(lastRef.current, count);
		lastRef.current = last;
		if (warnAt == null) return;
		setWarn({ at: warnAt, count });
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => setWarn(null), AUTO_HIDE_MS);
	}, [count]);

	useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

	if (!warn) return null;
	return createPortal(
		<div
			data-node-count-warn={warn.at}
			style={{
				position: "fixed", top: 76, left: "50%", transform: "translateX(-50%)", zIndex: 10250,
				display: "flex", alignItems: "flex-start", gap: 8, width: 400, maxWidth: "calc(100vw - 48px)",
				background: "#12151c", border: "1px solid rgba(251,191,36,0.35)", borderRadius: 12,
				padding: "10px 12px", boxShadow: "0 14px 44px rgba(0,0,0,0.55)", pointerEvents: "auto",
			}}
		>
			<AlertTriangle size={15} color="#fbbf24" style={{ flexShrink: 0, marginTop: 2 }} />
			<div style={{ flex: 1, minWidth: 0 }}>
				<div style={{ fontSize: 12.5, fontWeight: 700, color: "#fbbf24", marginBottom: 3 }}>
					当前画布节点已达 {warn.count} 个
				</div>
				<div style={{ fontSize: 11.5, lineHeight: 1.65, color: "rgba(255,255,255,0.75)" }}>
					节点过多可能导致画布卡顿、保存变慢，极端情况下保存中断会损坏项目文件。建议按分集拆分画布或清理不再使用的节点。
				</div>
			</div>
			<button
				onClick={() => setWarn(null)}
				title="关闭提示"
				style={{ flexShrink: 0, background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.5)", padding: 2, lineHeight: 0 }}
			>
				<X size={13} />
			</button>
		</div>,
		document.body,
	);
}
