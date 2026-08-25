/**
 * RtcFreeGenWorkbench —— 中栏「AI 工作台」页的**无 shotRef 占位**残余视图。
 * ⚠ 补充6 起普通占位（视频/图片）创建/绑定即挂真实分镜（segShotBinding）走 RtcShotAiWorkbench
 * 同一条实现——本视图只剩三类服务对象（ensureShotForPlaceholder 拒绝升级的）：
 *   音频占位（无生成能力警示）/ 超分·去字幕坑位（originSegId 血缘）/ 生成中的存量自由占位。
 * 右栏对应视图 [RtcFreeGenProps](./RtcFreeGenProps.tsx)（AI 设置）同此残余范围。
 *
 * 布局（补充5 用户定稿「三栏是 AI 工作台的基本布局，不要出现其他布局，没有原文就空着」）：
 * 与分镜工作台完全同一副骨架——
 *   - 提示词列（order:1 居左，紧邻素材面板）：头部身份 → 垫素材 → 提示词大编辑（fill 框内收起）
 *     → 动作行 + 进度/失败/空闲状态 + 参数说明；
 *   - 参照列（order:2 居右，共享壳 WorkbenchRefColumn，分界可拖）：上=结果预览（占位无成片=空态
 *     说明；生成成功占位就地变结果并自动切「预览」页）、下=原文对照（自由占位无关联分镜——**空着**）。
 *
 * ⚠ 红线（逻辑零重写，与 RtcFreeGenProps 同一套语义）：
 *   - 提示词/垫素材 = useRtcFreeGenStore（DraftArea/RefStrip 共享件见 freeGenParts，勿复制两份）；
 *   - 生成只走 freeGenActions.startFreeGen/retryFreeGen（内部 runPurpose 唯一路径）；
 *   - 任务态由**片段自身的 status/progress**驱动（随 rtcDoc 落项目文件，重开自动接回）。
 */
import { useState } from "react";
import { Image as ImageIcon, Video } from "lucide-react";
import { PromptExpandButton } from "@/components/PromptExpandButton";
import { progressLabel } from "@/lib/queueLabel";
import type { RtcSegment, RtcTrack } from "@/types/rtc";
import { AUDIO_GEN_UNSUPPORTED, genCapabilityFor, segSeconds } from "./rtcGenCore";
import { fmtUs, usToSecLabel } from "./rtcSegUtils";
import { useRtcFreeGenStore } from "./rtcFreeGenStore";
import { DraftArea, KIND_LABEL, RefStrip, secBox, secTitle } from "./freeGenParts";
import { WorkbenchRefColumn } from "./shotWorkbenchParts";
import { retryFreeGen, segGenKind, startFreeGen } from "./freeGenActions";
import { useSegQueueInfo } from "./rtcQueueStore";

/** 参照列·上格「结果预览」：占位期间恒空态（生成成功占位就地变成结果片段并自动切「预览」页） */
function ResultPreviewPane({ kind, isNewVersion }: { kind: "video" | "image" | "audio"; isNewVersion: boolean }) {
	return (
		<div style={{ ...secBox, flex: 1, minHeight: 0, minWidth: 0 }}>
			<div style={secTitle}><span>结果预览</span></div>
			<div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 12 }}>
				{kind === "video" ? <Video size={22} color="rgba(255,255,255,0.3)" /> : <ImageIcon size={22} color="rgba(255,255,255,0.3)" />}
				<span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", textAlign: "center", lineHeight: 1.8 }}>
					{KIND_LABEL[kind]}占位——尚无结果
					<br />生成成功后本占位就地变成结果片段（位置与时长不变），并自动切到「预览」页
					{isNewVersion ? (
						<>
							<br /><span style={{ color: "rgba(167,139,250,0.75)" }}>新版本占位：下方轨道的原结果原位保留</span>
						</>
					) : null}
				</span>
			</div>
		</div>
	);
}

/** 参照列·下格「原文对照」：自由占位没有关联分镜——按用户定稿**空着**（栏位保留，三栏布局不变） */
function EmptyScriptPane() {
	return (
		<div style={{ ...secBox, flex: 1, minHeight: 0, minWidth: 0 }}>
			<div style={secTitle}><span>原文对照</span></div>
			<div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: 12 }}>
				<span style={{ fontSize: 11, color: "rgba(255,255,255,0.28)", textAlign: "center", lineHeight: 1.8 }}>
					（自由占位没有关联分镜——无原文）
				</span>
			</div>
		</div>
	);
}

export function RtcFreeGenWorkbench({ seg, track, segIndex }: { seg: RtcSegment; track: RtcTrack; segIndex: number }) {
	const kind = segGenKind(seg);
	const cap = genCapabilityFor(kind);
	const draft = useRtcFreeGenStore((s) => s.drafts[seg.id]);
	const prompt = draft?.prompt ?? "";
	const refs = draft?.refs ?? [];
	const running = seg.status === "running";
	const failed = seg.status === "failed";
	// 在途排队信息（内存态）→ 「排队中 · 第 N 位」/「生成中 42%」
	const queueInfo = useSegQueueInfo(seg.id);
	const runLabel = progressLabel(seg.progress ?? null, queueInfo);
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
			{/* ── 参照列（order:2 居右，共享壳）：结果预览空态 + 原文空着 ── */}
			<WorkbenchRefColumn
				top={<ResultPreviewPane kind={kind} isNewVersion={!!seg.originSegId} />}
				bottom={<EmptyScriptPane />}
			/>

			{/* ── 提示词列（order:1 居左，紧邻素材面板）：头部 → 垫素材 → 提示词(fill) → 动作/状态 ── */}
			<div style={{ flex: 1, order: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", paddingRight: 2 }}>
				{/* 头部：占位身份（与分镜工作台头部行同构） */}
				<div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", flexShrink: 0 }}>
					<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{seg.name || `${KIND_LABEL[kind]}占位`}</span>
					<span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
						结果占位 · {KIND_LABEL[kind]} · {track.name || (track.type === "audio" ? "音频轨" : "视频轨")} 第 {segIndex + 1} 段
						· {fmtUs(seg.targetStartUs)} → {fmtUs(seg.targetStartUs + seg.targetDurationUs)}（{usToSecLabel(seg.targetDurationUs)}）
					</span>
				</div>

				{cap === null ? (
					/* 音频：库内暂无接线的音频生成能力——直说，不给点了没反应的按钮（三栏骨架不变） */
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
						{/* 垫素材（与分镜工作台垫图区同位：提示词编辑框上方） */}
						<div style={{ ...secBox, flexShrink: 0 }}>
							<div style={secTitle}>
								<span>垫素材（{refs.length}）</span>
								<span style={{ fontSize: 9.5, color: "rgba(255,255,255,0.35)" }}>拖入资产/文件 · 按序对应 @1@2…</span>
							</div>
							<RefStrip segId={seg.id} refs={refs} />
						</div>

						{/* 提示词（fill 大编辑区：吃满剩余高、超长内容框内滚动收起——与分镜工作台同规） */}
						<div style={{ ...secBox, flex: 1, minHeight: 150 }}>
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
								fill
								placeholder={kind === "video" ? "描述这一段视频要拍什么…" : "描述这张图要画什么…"}
								onCommit={(v) => useRtcFreeGenStore.getState().patch(seg.id, { prompt: v })}
							/>
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
								{running ? runLabel : "模型在右栏「属性」页选择"}
							</span>
						</div>

						{/* 状态区：进度 / 失败 / 空闲说明 */}
						{running ? (
							<div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
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
									{runLabel}
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
									flexShrink: 0,
								}}
							>
								{seg.error || "生成失败"}
								<br />
								<span style={{ color: "rgba(255,255,255,0.45)" }}>占位已保留在原位——改完提示词点「重新生成」即可（会重新扣费）。</span>
							</div>
						) : null}

						{/* 参数说明（与右栏 AI 设置的分工提示） */}
						<div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", lineHeight: 1.7, flexShrink: 0 }}>
							{kind === "video"
								? `时长按本占位长度（约 ${segSeconds(seg.targetDurationUs)}s）提交；`
								: "比例/分辨率/质量取「视频设置」；"}
							模型与精确摆位（时间码）在右栏「属性」页调整。
						</div>
					</>
				)}
			</div>
		</div>
	);
}
