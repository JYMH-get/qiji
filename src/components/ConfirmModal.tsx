/**
 * ConfirmModal —— 全局应用内确认弹窗（App 挂载，单例）。
 * confirmDialog() 驱动（src/lib/confirmDialog.ts）：深色同风格替代系统默认对话框。
 * 交互：确定（红，危险操作醒目）/ 取消；Esc、点遮罩 = 取消；Enter = 确定。
 * z-index 100400：盖过提示词放大弹窗(100000)与资产助手抬升态(100100)。
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { useConfirmStore, settleConfirm } from "@/lib/confirmDialog";

const btnBase: React.CSSProperties = {
	padding: "7px 18px", fontSize: 12.5, borderRadius: 8, cursor: "pointer", fontWeight: 600,
	border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.85)",
};

export default function ConfirmModal() {
	const open = useConfirmStore((s) => s.open);
	const message = useConfirmStore((s) => s.message);
	const title = useConfirmStore((s) => s.title);

	// capture 抢键：Esc=取消、Enter=确定（先于画布快捷键等全局监听）
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); settleConfirm(false); }
			else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); settleConfirm(true); }
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open]);

	if (!open) return null;
	return createPortal(
		<div
			onMouseDown={() => settleConfirm(false)}
			style={{ position: "fixed", inset: 0, zIndex: 100400, background: "rgba(4,6,12,0.6)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center" }}
		>
			<div
				onMouseDown={(e) => e.stopPropagation()}
				style={{ width: 400, maxWidth: "calc(100vw - 48px)", background: "#12151c", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, padding: "16px 18px", boxShadow: "0 22px 70px rgba(0,0,0,0.65)" }}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
					<AlertTriangle size={16} color="#fbbf24" />
					<span style={{ fontSize: 13.5, fontWeight: 700, color: "#fff" }}>{title}</span>
				</div>
				<div style={{ fontSize: 12.5, lineHeight: 1.7, color: "rgba(255,255,255,0.78)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "50vh", overflowY: "auto" }}>
					{message}
				</div>
				<div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
					<button style={btnBase} onClick={() => settleConfirm(false)} title="取消（Esc）">取消</button>
					<button
						style={{ ...btnBase, background: "#dc2626", borderColor: "#dc2626", color: "#fff" }}
						onClick={() => settleConfirm(true)}
						title="确定（Enter）"
					>确定</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
