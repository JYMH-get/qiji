/**
 * RtcFreeGenProps —— 右栏「自由结果占位」属性视图（时间轴空白右键新建的占位，**无 shotRef**）。
 *
 * 区块（第240轮收敛为「AI 设置」，用户定稿）：占位身份（名/产物类型/时间码）→ 模型 →
 * 参数说明 → 生成/进度/失败重试；**提示词与垫素材在中栏「AI 工作台」页编辑**
 * （[RtcFreeGenWorkbench](./RtcFreeGenWorkbench.tsx)，共享编辑件见 freeGenParts）。
 *
 * ⚠ 语义（第237轮定稿）：轨道是结果的存放位置——这个占位就是「这一版结果的坑位」，
 *   生成成功后它**就地**变成结果片段（target 位置/时长分毫不动，时长不符留给用户裁剪）；
 *   要新版本请对成片右键「重新生成」（在上方轨道另起一个占位，原结果原位保留）。
 *
 * ⚠ 红线：生成只走 [freeGenActions.startFreeGen](./freeGenActions.ts)（内部 runPurpose 唯一路径，
 *   选路理由见该文件头注释）；本文件不拼提示词模板正文、不改写生成参数。
 * 任务态由**片段自身的 status/progress**驱动（随 rtcDoc 落项目文件）——关掉客户端重开后，
 * [placeholderSwap.initRtcGenWatch] 会凭 taskRef 重挂轮询继续回填，不依赖任何回调闭包。
 */
import { useState } from "react";
import { Image as ImageIcon, Video } from "lucide-react";
import ModelPicker from "@/components/ModelPicker";
import type { RtcSegment, RtcTrack } from "@/types/rtc";
import { AUDIO_GEN_UNSUPPORTED, genCapabilityFor, segSeconds } from "./rtcGenCore";
import { fmtUs, usToSecLabel } from "./rtcSegUtils";
import { RtcTimeFields } from "./RtcTimeFields";
import { KIND_LABEL, secBox } from "./freeGenParts";
import { retryFreeGen, segGenKind, startFreeGen } from "./freeGenActions";

export function RtcFreeGenProps({ seg, track, segIndex }: { seg: RtcSegment; track: RtcTrack; segIndex: number }) {
	const kind = segGenKind(seg);
	const cap = genCapabilityFor(kind);
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
		<div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "12px 12px 24px" }}>
			{/* 头部：占位身份 */}
			<div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
				<div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
					<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{seg.name || `${KIND_LABEL[kind]}占位`}</span>
					<span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>结果占位 · {KIND_LABEL[kind]}</span>
				</div>
				<div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
					{track.name || (track.type === "audio" ? "音频轨" : "视频轨")} · 第 {segIndex + 1} 段 · {fmtUs(seg.targetStartUs)} →{" "}
					{fmtUs(seg.targetStartUs + seg.targetDurationUs)}（{usToSecLabel(seg.targetDurationUs)}）
				</div>
				{/* 精确摆位：起点/时长可直接填（占位时长同时决定提交给模型的视频秒数，见下方参数说明） */}
				<div style={{ marginTop: 4 }}>
					<RtcTimeFields seg={seg} track={track} />
				</div>
				{seg.originSegId ? (
					<div style={{ fontSize: 10, color: "rgba(167,139,250,0.75)", lineHeight: 1.7 }}>
						新版本占位——结果落在这里，下方轨道的原结果原位保留。
						<br />
						<span style={{ color: "rgba(255,255,255,0.4)" }}>
							若它是「超分 / 去字幕」的坑位且失败了，请对下方的原结果重新右键处理；也可以在中栏工作台填提示词，生成一段新内容占住这个位置。
						</span>
					</div>
				) : null}
			</div>

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
					}}
				>
					{AUDIO_GEN_UNSUPPORTED}
					<br />
					<span style={{ color: "rgba(255,255,255,0.5)" }}>把素材拖到这个占位上即可替换成真实音频（占位的位置与时长保留）。</span>
				</div>
			) : (
				<>
					{/* 引导：提示词/垫素材已移入中栏工作台（第240轮，选中本占位即自动切到「AI 工作台」页） */}
					<div style={{ fontSize: 10.5, color: "rgba(167,139,250,0.8)", lineHeight: 1.7 }}>
						提示词与垫素材在中栏「AI 工作台」页编辑（选中本占位已自动打开）。
					</div>

					{/* 模型 */}
					<div style={secBox}>
						<ModelPicker cap={cap} label={kind === "video" ? "视频模型" : "生图模型"} />
					</div>

					{/* 参数说明（视频时长默认取占位自身长度——占位多长就生成多长，再按模型开放档收敛） */}
					{kind === "video" ? (
						<div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", lineHeight: 1.7 }}>
							时长按本占位长度（约 {segSeconds(seg.targetDurationUs)}s）提交，分辨率/比例取「视频设置」，
							三者都会按所选模型开放的档位收敛。
						</div>
					) : (
						<div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", lineHeight: 1.7 }}>
							比例/分辨率/质量取「视频设置」里的故事板图像设置，按所选模型开放的档位收敛。
						</div>
					)}

					{/* 动作 + 状态 */}
					<div style={secBox}>
						<button
							disabled={running || busy}
							title={running ? "生成中——切页/关软件重开会自动接回" : "按中栏工作台填好的提示词与垫素材生成；成功后本占位就地变成结果"}
							onClick={() => void submit(failed)}
							style={{
								padding: "7px 8px",
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
								<div style={{ fontSize: 10, color: "rgba(196,181,253,0.9)" }}>
									{seg.progress != null ? `生成中 ${Math.round(seg.progress)}%` : "生成中…"}
									<span style={{ color: "rgba(255,255,255,0.35)" }}>（切页/关软件重开会自动接回，不重复扣费）</span>
								</div>
							</div>
						) : null}

						{failed ? (
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
								<span style={{ color: "rgba(255,255,255,0.45)" }}>占位已保留在原位——在中栏工作台改完提示词点「重新生成」即可（会重新扣费）。</span>
							</div>
						) : null}

						{!running && !failed ? (
							<div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", lineHeight: 1.7, display: "flex", alignItems: "center", gap: 4 }}>
								{kind === "video" ? <Video size={11} /> : <ImageIcon size={11} />}
								生成成功后本占位就地变成结果（位置与时长不变）；要另一版就对结果右键「重新生成」。
							</div>
						) : null}
					</div>
				</>
			)}
		</div>
	);
}
