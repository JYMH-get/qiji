/**
 * RtcFreeGenWorkbench —— 中栏「AI 工作台」页的**自由结果占位**正文（无 shotRef 的占位，第240轮）。
 * 用户定稿：提示词与垫素材从右栏属性移入中栏工作台编辑；右栏 [RtcFreeGenProps](./RtcFreeGenProps.tsx)
 * 收敛为「AI 设置」（时间码/模型/参数说明/生成动作）。
 *
 * 布局对齐 RtcShotAiWorkbench 工作台风格：
 *   - 左窄列：占位身份（名/产物类型/轨道·时间窗）+ 进度/失败/引导状态；
 *   - 右大列：提示词大编辑区（灯箱式）+ 垫素材条 + 底部「开始生成/重试」+ 状态说明。
 *
 * ⚠ 红线（逻辑零重写，与 RtcFreeGenProps 同一套语义）：
 *   - 提示词/垫素材 = useRtcFreeGenStore（DraftArea/RefStrip 共享件见 freeGenParts，勿复制两份）；
 *   - 生成只走 freeGenActions.startFreeGen/retryFreeGen（内部 runPurpose 唯一路径）；
 *   - 任务态由**片段自身的 status/progress**驱动（随 rtcDoc 落项目文件，重开自动接回）。
 */
import { useState } from "react";
import { Image as ImageIcon, Video } from "lucide-react";
import { PromptExpandButton } from "@/components/PromptExpandButton";
import type { RtcSegment, RtcTrack } from "@/types/rtc";
import { AUDIO_GEN_UNSUPPORTED, genCapabilityFor, segSeconds } from "./rtcGenCore";
import { fmtUs, usToSecLabel } from "./rtcSegUtils";
import { useRtcFreeGenStore } from "./rtcFreeGenStore";
import { DraftArea, KIND_LABEL, RefStrip, secBox, secTitle } from "./freeGenParts";
import { retryFreeGen, segGenKind, startFreeGen } from "./freeGenActions";

export function RtcFreeGenWorkbench({ seg, track, segIndex }: { seg: RtcSegment; track: RtcTrack; segIndex: number }) {
	const kind = segGenKind(seg);
	const cap = genCapabilityFor(kind);
	const draft = useRtcFreeGenStore((s) => s.drafts[seg.id]);
	const prompt = draft?.prompt ?? "";
	const refs = draft?.refs ?? [];
	const running = seg.status === "running";
	const failed = seg.status === "failed";
	const [busy, setBusy] = useState(false);

	const submit = async (retry: boolean) => {
		setBusy(true);
		try {
			const r = retry ? await retryFreeGen(seg.id) : await startFreeGen(seg.id);
			if (!r.ok) alert(r.error); // 请求没发出：明确报错，绝不静默失败
		} finally {
			setBusy(false);
		}
	};

	return (
		<div style={{ flex: 1, minHeight: 0, display: "flex", gap: 12, padding: 12, overflow: "hidden" }}>
			{/* ── 左窄列：占位身份 + 状态 ── */}
			<div style={{ flex: "0 0 240px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12, minHeight: 0, overflowY: "auto", paddingRight: 2 }}>
				<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
					<div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
						<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{seg.name || `${KIND_LABEL[kind]}占位`}</span>
						<span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>结果占位 · {KIND_LABEL[kind]}</span>
					</div>
					<div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", lineHeight: 1.7 }}>
						{track.name || (track.type === "audio" ? "音频轨" : "视频轨")} · 第 {segIndex + 1} 段
						<br />
						{fmtUs(seg.targetStartUs)} → {fmtUs(seg.targetStartUs + seg.targetDurationUs)}（{usToSecLabel(seg.targetDurationUs)}）
					</div>
					{seg.originSegId ? (
						<div style={{ fontSize: 10, color: "rgba(167,139,250,0.75)", lineHeight: 1.7 }}>
							新版本占位——结果落在这里，下方轨道的原结果原位保留。
						</div>
					) : null}
				</div>

				{/* 状态区：进度 / 失败 / 空闲说明 */}
				{running ? (
					<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
						<div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
							<div
								style={{
									width: `${Math.max(4, Math.min(100, seg.progress ?? 0))}%`,
									height: "100%",
									background: "rgba(139,92,246,0.85)",
									transition: "width 240ms linear",
								}}
							/>
						</div>
						<div style={{ fontSize: 10, color: "rgba(196,181,253,0.9)", lineHeight: 1.7 }}>
							{seg.progress != null ? `生成中 ${Math.round(seg.progress)}%` : "生成中…"}
							<span style={{ color: "rgba(255,255,255,0.35)" }}>（切页/关软件重开会自动接回，不重复扣费）</span>
						</div>
					</div>
				) : failed ? (
					<div
						style={{
							fontSize: 10.5,
							lineHeight: 1.7,
							color: "#f87171",
							background: "rgba(248,113,113,0.1)",
							border: "1px solid rgba(248,113,113,0.35)",
							borderRadius: 6,
							padding: "6px 8px",
						}}
					>
						{seg.error || "生成失败"}
						<br />
						<span style={{ color: "rgba(255,255,255,0.45)" }}>占位已保留在原位——改完提示词点「重新生成」即可（会重新扣费）。</span>
					</div>
				) : (
					<div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", lineHeight: 1.7, display: "flex", gap: 4 }}>
						{kind === "video" ? <Video size={11} style={{ flexShrink: 0, marginTop: 2 }} /> : <ImageIcon size={11} style={{ flexShrink: 0, marginTop: 2 }} />}
						<span>生成成功后本占位就地变成结果（位置与时长不变）；要另一版就对结果右键「重新生成」。</span>
					</div>
				)}

				{cap !== null ? (
					<div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", lineHeight: 1.7, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 8 }}>
						{kind === "video"
							? `时长按本占位长度（约 ${segSeconds(seg.targetDurationUs)}s）提交；`
							: "比例/分辨率/质量取「视频设置」；"}
						模型与精确摆位（时间码）在右栏「属性」页调整。
					</div>
				) : null}
			</div>

			{/* ── 右大列：提示词 + 垫素材 + 动作 ── */}
			<div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", paddingRight: 2 }}>
				{cap === null ? (
					/* 音频：库内暂无接线的音频生成能力——直说，不给点了没反应的按钮 */
					<div
						style={{
							fontSize: 11.5,
							lineHeight: 1.8,
							color: "rgba(251,191,36,0.9)",
							background: "rgba(251,191,36,0.08)",
							border: "1px solid rgba(251,191,36,0.3)",
							borderRadius: 6,
							padding: "8px 10px",
							flexShrink: 0,
						}}
					>
						{AUDIO_GEN_UNSUPPORTED}
						<br />
						<span style={{ color: "rgba(255,255,255,0.5)" }}>把素材拖到这个占位上即可替换成真实音频（占位的位置与时长保留）。</span>
					</div>
				) : (
					<>
						{/* 提示词（灯箱式大编辑区） */}
						<div style={{ ...secBox, flexShrink: 0 }}>
							<div style={secTitle}>
								<span>提示词</span>
								<PromptExpandButton
									title={`${seg.name || "结果占位"} · 提示词`}
									getValue={() => useRtcFreeGenStore.getState().draftOf(seg.id).prompt}
									onSave={(v) => useRtcFreeGenStore.getState().patch(seg.id, { prompt: v })}
									size={11}
								/>
							</div>
							<DraftArea
								value={prompt}
								rows={10}
								minHeight="30vh"
								placeholder={kind === "video" ? "描述这一段视频要拍什么…" : "描述这张图要画什么…"}
								onCommit={(v) => useRtcFreeGenStore.getState().patch(seg.id, { prompt: v })}
							/>
						</div>

						{/* 垫素材 */}
						<div style={{ ...secBox, flexShrink: 0 }}>
							<div style={secTitle}>
								<span>垫素材（{refs.length}）</span>
								<span style={{ fontSize: 9.5, color: "rgba(255,255,255,0.35)" }}>拖入资产/文件 · 按序对应 @1@2…</span>
							</div>
							<RefStrip segId={seg.id} refs={refs} />
						</div>

						{/* 动作行 */}
						<div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
							<button
								disabled={running || busy}
								title={running ? "生成中——切页/关软件重开会自动接回" : "按上面的提示词与垫素材生成；成功后本占位就地变成结果"}
								onClick={() => void submit(failed)}
								style={{
									padding: "7px 16px",
									fontSize: 12,
									borderRadius: 6,
									cursor: running || busy ? "not-allowed" : "pointer",
									opacity: running || busy ? 0.5 : 1,
									border: "1px solid rgba(139,92,246,0.6)",
									background: "rgba(139,92,246,0.22)",
									color: "#d6c8ff",
									whiteSpace: "nowrap",
								}}
							>
								{running ? "生成中…" : failed ? "重新生成" : "开始生成"}
							</button>
							<span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
								{running
									? seg.progress != null ? `生成中 ${Math.round(seg.progress)}%` : "生成中…"
									: "模型在右栏「属性」页选择"}
							</span>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
