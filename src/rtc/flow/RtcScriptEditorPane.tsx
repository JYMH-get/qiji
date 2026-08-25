/**
 * RtcScriptEditorPane —— 中栏「剧本处理面」（第251轮需求⑪）。
 *
 * 用户定稿：「实时剪辑的剧本界面也是，将右栏作为属性选择，中间栏作为素材展示（工作台），
 * 当用户点击剧本下的整理剧本按键时，在中间栏摊开剧本处理的（面）。」
 *   - **右栏**「剧本 / 分镜」两页仍是**动作区**（步骤卡 + 各按钮）——即「属性选择」；
 *   - **中栏**摊开这一面做正文编辑：整块大 textarea（右栏 360px 窄栏塞不下长剧本）。
 *
 * 语义：
 *   - 打开时把 projectStore.scriptText 拷进本地草稿，**保存才回写**（取消=丢弃，不像右栏那样失焦即写）；
 *   - Esc / 取消 / 保存 都关闭本面（开合态在 rtcCenterTabStore.scriptEditorOpen，会话级）；
 *   - ⚠ 它只是最上层叠层，**RtcSequencePlayer 仍常驻挂载**（第236/239轮红线）——关掉即回到原来的页。
 */
import { useEffect, useRef, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { closeRtcScriptEditor } from "../panel/rtcCenterTabStore";

const btn = (kind: "primary" | "plain"): React.CSSProperties => ({
	padding: "6px 16px",
	fontSize: 12,
	borderRadius: 7,
	cursor: "pointer",
	whiteSpace: "nowrap",
	border: kind === "primary" ? "1px solid rgba(139,92,246,0.6)" : "1px solid rgba(255,255,255,0.16)",
	background: kind === "primary" ? "rgba(139,92,246,0.24)" : "rgba(255,255,255,0.07)",
	color: kind === "primary" ? "#d6c8ff" : "rgba(255,255,255,0.88)",
});

export function RtcScriptEditorPane() {
	const scriptText = useProjectStore((s) => s.scriptText);
	const [draft, setDraft] = useState(scriptText || "");
	const taRef = useRef<HTMLTextAreaElement>(null);

	// 打开即聚焦；Esc 关闭（capture 拦下，别漏给时间轴快捷键）
	useEffect(() => {
		taRef.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				closeRtcScriptEditor();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);

	const dirty = draft !== (scriptText || "");
	const save = () => {
		useProjectStore.getState().setScriptText(draft);
		closeRtcScriptEditor();
	};

	return (
		<div
			style={{
				position: "absolute",
				inset: 0,
				zIndex: 9, // 最上层：盖住工作台/预览两层（它们都不卸载，关掉即恢复）
				background: "#101018",
				display: "flex",
				flexDirection: "column",
				minHeight: 0,
				overflow: "hidden",
				padding: 12,
				gap: 8,
			}}
		>
			{/* 头部：标题 + 字数 + 关闭 */}
			<div style={{ display: "flex", alignItems: "baseline", gap: 10, flexShrink: 0 }}>
				<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>整理剧本</span>
				<span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)" }}>
					{draft.length} 字{dirty ? " · 未保存" : ""} — 后续的剧集拆分 / 资产拆分 / 分镜推理都以它为源
				</span>
				<span style={{ flex: 1 }} />
				<button style={btn("plain")} onClick={() => closeRtcScriptEditor()} title="不保存关闭（Esc）">
					取消
				</button>
				<button style={btn("primary")} onClick={save} title="保存并关闭">
					保存
				</button>
			</div>

			{/* 正文：整块大编辑区（中栏比右栏宽得多，长剧本在这里才好整理） */}
			<textarea
				ref={taRef}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				placeholder="粘贴完整剧本原文……保存后可在右栏「剧本」页继续 剧集拆分 / 资产拆分"
				style={{
					flex: 1,
					minHeight: 0,
					width: "100%",
					resize: "none",
					padding: "10px 12px",
					fontSize: 13,
					lineHeight: 1.9,
					borderRadius: 8,
					border: "1px solid rgba(139,92,246,0.4)",
					background: "rgba(0,0,0,0.3)",
					color: "rgba(255,255,255,0.9)",
					outline: "none",
				}}
			/>
		</div>
	);
}
