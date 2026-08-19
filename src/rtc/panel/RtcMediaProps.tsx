/**
 * RtcMediaProps —— 右栏「media 片段」属性视图。
 * 只读：名称/所在轨/素材源（assetId + source 窗口）；
 * 可编辑：起点 / 时长（RtcTimeFields，走 moveSegment / trimSegment）+ speed / volume / muted
 *        （volume/muted 经 rtcStore.commit + 内联不可变 patch；speed 经 commitSegmentSpeed →
 *        rtcOps.setSegmentSpeed 联动 target 时长，见 rtcSegUtils）。
 */
import { useEffect, useState } from "react";
import { openLightbox } from "@/store/lightboxStore";
import type { RtcSegment, RtcTrack } from "@/types/rtc";
import { RtcTimeFields } from "./RtcTimeFields";
import { commitSegmentPatch, commitSegmentSpeed, fmtUs, usToSecLabel } from "./rtcSegUtils";
/* ── 第三批：倒放/裁剪/转场 ── */
import { cropOf, withSegmentCrop } from "@/lib/rtcCropCore";
import { useRtcStore } from "@/store/rtcStore";
import { RtcCropEditor } from "./RtcCropEditor";
import { useCropEditorRequest } from "./cropEditorStore";
import { RtcTransitionPicker } from "./RtcTransitionPicker";
import { toggleReverse, useReverseBusy } from "./reverseActions";

const TRACK_TYPE_LABEL: Record<RtcTrack["type"], string> = { video: "视频轨", audio: "音频轨", text: "文本轨" };

const rowSt: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 11, color: "rgba(255,255,255,0.6)" };
const valSt: React.CSSProperties = { color: "rgba(255,255,255,0.9)", fontSize: 12, textAlign: "right", wordBreak: "break-all" };
const ctlSt: React.CSSProperties = { width: 110, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#fff", padding: "5px 8px", fontSize: 12, outline: "none" };

/** 变速输入（草稿式；失焦/回车提交，夹 0.1–5）。
 *  ⚠ 提交走 commitSegmentSpeed（speed 与 target 时长联动，10s×2倍=5s 轨道长度），
 *  勿回退成 commitSegmentPatch 纯 patch speed——时长不跟=播放到源素材耗尽后画面出错。 */
function SpeedInput({ segId, speed }: { segId: string; speed: number }) {
	const [draft, setDraft] = useState(String(speed));
	useEffect(() => { setDraft(String(speed)); }, [speed, segId]);
	const commit = () => {
		const n = Number(draft);
		const v = Number.isFinite(n) ? Math.min(5, Math.max(0.1, Math.round(n * 100) / 100)) : speed;
		setDraft(String(v));
		if (v !== speed) commitSegmentSpeed(segId, v);
	};
	return (
		<input
			type="number" min={0.1} max={5} step={0.05} value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
			style={ctlSt}
			title="变速倍率（0.1–5）"
		/>
	);
}

/* ── 第三批：倒放行（视频/音频片段；桌面版转码，busy 态 + 失败直显） ── */
function ReverseRow({ seg }: { seg: RtcSegment }) {
	const busy = useReverseBusy((s) => !!s.busy[seg.id]);
	const [err, setErr] = useState<string | null>(null);
	const reversed = !!seg.reversedFromAssetId;
	const onClick = async () => {
		setErr(null);
		const r = await toggleReverse(seg.id);
		if (!r.ok && r.error) setErr(r.error);
	};
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
			<div style={rowSt}>
				<span>倒放{reversed ? "（已倒放）" : ""}</span>
				<button
					type="button"
					disabled={busy}
					onClick={() => void onClick()}
					title={reversed ? "换回原素材（source 窗口镜像还原）" : "生成物理倒放副本并换入（桌面版 ffmpeg 转码；长视频较慢）"}
					style={{
						height: 24,
						padding: "0 12px",
						borderRadius: 5,
						fontSize: 11,
						cursor: busy ? "wait" : "pointer",
						border: reversed ? "1px solid rgba(139,92,246,0.6)" : "1px solid rgba(255,255,255,0.14)",
						background: reversed ? "rgba(139,92,246,0.18)" : "rgba(255,255,255,0.06)",
						color: reversed ? "#d6c8ff" : "rgba(255,255,255,0.85)",
						opacity: busy ? 0.6 : 1,
					}}
				>
					{busy ? "倒放转码中…" : reversed ? "取消倒放" : "倒放"}
				</button>
			</div>
			{err ? <div style={{ fontSize: 10, lineHeight: 1.6, color: "#f87171" }}>{err}</div> : null}
		</div>
	);
}

export function RtcMediaProps({ seg, track, segIndex }: { seg: RtcSegment; track: RtcTrack; segIndex: number }) {
	const media = seg.media || (track.type === "audio" ? "audio" : "video");
	const volume = seg.volume ?? 1;
	const hasSource = seg.sourceStartUs != null && seg.sourceDurationUs != null;
	/* ── 第三批：画面裁剪弹窗开关（仅视频轨的图/视片段） ── */
	const [cropOpen, setCropOpen] = useState(false);
	// 集成轮：键盘 C / 右键「裁剪画面…」经 cropEditorStore 请求打开（命中本片段才响应，用后即清）
	const cropReq = useCropEditorRequest((st) => st.segId);
	useEffect(() => {
		if (cropReq !== seg.id) return;
		useCropEditorRequest.getState().clear();
		if (track.type === "video" && (media === "video" || media === "image") && seg.uri) setCropOpen(true);
	}, [cropReq, seg.id, seg.uri, track.type, media]);
	const crop = cropOf(seg);
	const canCrop = track.type === "video" && (media === "video" || media === "image") && !!seg.uri;
	const canReverse = (media === "video" || media === "audio") && seg.kind === "media";
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 12px 24px" }}>
			<div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
				<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{seg.name || "未命名片段"}</span>
				<span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{media === "video" ? "视频" : media === "audio" ? "音频" : "图片"}片段</span>
			</div>

			{/* 位置：所在轨道只读；起点/时长可精确输入（改起点=移动、改时长=右端裁剪，见 RtcTimeFields） */}
			<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
				<div style={rowSt}><span>所在轨道</span><span style={valSt}>{TRACK_TYPE_LABEL[track.type]}{track.name ? ` · ${track.name}` : ""} · 第 {segIndex + 1} 段</span></div>
				<RtcTimeFields seg={seg} track={track} />
			</div>

			{/* 播放属性（可编辑，经 commit 内联不可变更新） */}
			<div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.07)" }}>
				<div style={rowSt}>
					<span>变速</span>
					<SpeedInput segId={seg.id} speed={seg.speed ?? 1} />
				</div>
				<div style={rowSt}>
					<span>音量 {Math.round(volume * 100)}%</span>
					<input
						type="range" min={0} max={2} step={0.05} value={volume}
						onChange={(e) => commitSegmentPatch(seg.id, { volume: Math.round(Number(e.target.value) * 100) / 100 })}
						style={{ width: 130 }}
						title="音量（0–200%）"
					/>
				</div>
				<div style={rowSt}>
					<span>静音</span>
					<input type="checkbox" checked={!!seg.muted} onChange={(e) => commitSegmentPatch(seg.id, { muted: e.target.checked || undefined })} style={{ cursor: "pointer" }} />
				</div>
			</div>

			{/* ── 第三批：倒放 + 画面裁剪 ── */}
			{(canReverse || canCrop) && (
				<div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.07)" }}>
					{canReverse && <ReverseRow seg={seg} />}
					{canCrop && (
						<div style={rowSt}>
							<span>画面裁剪{crop ? "（已裁剪）" : ""}</span>
							<span style={{ display: "flex", gap: 6 }}>
								{crop && (
									<button
										type="button"
										onClick={() => useRtcStore.getState().commit((d) => withSegmentCrop(d, seg.id, undefined))}
										title="清除裁剪（恢复完整画面）"
										style={{ height: 24, padding: "0 10px", borderRadius: 5, fontSize: 11, cursor: "pointer", border: "1px solid rgba(255,255,255,0.14)", background: "transparent", color: "rgba(255,255,255,0.7)" }}
									>
										清除
									</button>
								)}
								<button
									type="button"
									onClick={() => setCropOpen(true)}
									title="打开裁剪编辑器（四边/四角拖动 + 比例预设）"
									style={{ height: 24, padding: "0 12px", borderRadius: 5, fontSize: 11, cursor: "pointer", border: crop ? "1px solid rgba(139,92,246,0.6)" : "1px solid rgba(255,255,255,0.14)", background: crop ? "rgba(139,92,246,0.18)" : "rgba(255,255,255,0.06)", color: crop ? "#d6c8ff" : "rgba(255,255,255,0.85)" }}
								>
									裁剪…
								</button>
							</span>
						</div>
					)}
				</div>
			)}

			{/* ── 第三批：转场（仅视频轨；作用于与下一段的衔接，导出剪映后生效） ── */}
			{track.type === "video" && seg.kind === "media" && <RtcTransitionPicker seg={seg} />}

			{/* 素材源信息（只读） */}
			<div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.07)" }}>
				<div style={rowSt}><span>素材资产 id</span><span style={valSt}>{seg.assetId || "（无——本地/未登记素材）"}</span></div>
				{hasSource ? (
					<div style={rowSt}><span>源素材窗口</span><span style={valSt}>{fmtUs(seg.sourceStartUs as number)} → {fmtUs((seg.sourceStartUs as number) + (seg.sourceDurationUs as number))}（{usToSecLabel(seg.sourceDurationUs as number)}）</span></div>
				) : (
					<div style={rowSt}><span>源素材窗口</span><span style={valSt}>整段（未裁剪）</span></div>
				)}
				{seg.uri ? (
					<button
						onClick={() => openLightbox({ uri: seg.uri as string, media: media === "audio" ? "audio" : media === "image" ? "image" : "video", name: seg.name || "" })}
						style={{ marginTop: 4, padding: "6px 8px", fontSize: 12, borderRadius: 6, cursor: "pointer", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.85)" }}
					>在灯箱中查看</button>
				) : null}
			</div>

			{/* ── 第三批：裁剪编辑器弹窗（「确定」才一次 commit） ── */}
			{cropOpen && canCrop && seg.uri ? (
				<RtcCropEditor
					segId={seg.id}
					uri={seg.uri}
					media={media === "image" ? "image" : "video"}
					initial={crop}
					onClose={() => setCropOpen(false)}
				/>
			) : null}
		</div>
	);
}
