/**
 * RtcTextProps —— 右栏「字幕片段」属性视图（第三批）。
 *
 * 可编辑：正文（多行，草稿式失焦/Ctrl+Enter 提交）/ 字号（画幅高比例滑杆）/ 字体色 / 描边色 /
 *         位置 x/y 滑杆（画幅比例，0=中心）；起点/时长沿用 RtcTimeFields（与 media 片段同款）。
 * 写库一律 rtcStore.commit + rtcSegUtils.patchSegmentPatch 内联不可变（红线：不绕过 commit）；
 * 正文变更同步刷新片段显示名（textSegName——时间轴片段上直接看得到字幕内容）。
 * 样式读取一律 textStyleOf（缺省回退唯一入口，勿自写回退）。
 */
import { useEffect, useState } from "react";
import type { RtcSegment, RtcTrack } from "@/types/rtc";
import {
	SUBTITLE_FONT_MAX,
	SUBTITLE_FONT_MIN,
	textSegName,
	textStyleOf,
	type RtcSubtitleStyle,
} from "@/lib/rtcTextCore";
import { RtcTimeFields } from "./RtcTimeFields";
import { commitSegmentPatch } from "./rtcSegUtils";

const rowSt: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 11, color: "rgba(255,255,255,0.6)" };

/** 提交一次字幕样式补丁（读取当前样式合并单字段；正文变更连带刷新显示名） */
function patchSubtitle(seg: RtcSegment, patch: Partial<RtcSubtitleStyle>): void {
	const cur = textStyleOf(seg);
	const next = { ...cur, ...patch };
	commitSegmentPatch(seg.id, {
		text: { content: next.content, fontSize: next.fontSize, color: next.color, strokeColor: next.strokeColor, x: next.x, y: next.y },
		...(patch.content !== undefined ? { name: textSegName(next.content) } : {}),
	});
}

export function RtcTextProps({ seg, track }: { seg: RtcSegment; track: RtcTrack }) {
	const t = textStyleOf(seg);
	const [draft, setDraft] = useState(t.content);
	useEffect(() => { setDraft(textStyleOf(seg).content); }, [seg.id]); // eslint-disable-line react-hooks/exhaustive-deps
	const commitContent = () => {
		if (draft !== t.content) patchSubtitle(seg, { content: draft });
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 12px 24px" }}>
			<div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
				<span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>字幕</span>
				<span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>文本轨片段（导出为剪映字幕）</span>
			</div>

			{/* 正文 */}
			<textarea
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commitContent}
				onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur(); }}
				rows={3}
				placeholder="输入字幕内容…"
				style={{
					width: "100%",
					resize: "vertical",
					minHeight: 64,
					background: "rgba(255,255,255,0.05)",
					border: "1px solid rgba(255,255,255,0.12)",
					borderRadius: 6,
					color: "#fff",
					padding: "7px 9px",
					fontSize: 12,
					lineHeight: 1.6,
					outline: "none",
				}}
				title="字幕正文（失焦或 Ctrl+Enter 保存）"
			/>

			{/* 时间（起点/时长，与 media 片段同款可精确输入） */}
			<RtcTimeFields seg={seg} track={track} />

			{/* 样式 */}
			<div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.07)" }}>
				<div style={rowSt}>
					<span>字号 {(t.fontSize * 100).toFixed(0)}%（画幅高）</span>
					<input
						type="range" min={SUBTITLE_FONT_MIN} max={SUBTITLE_FONT_MAX} step={0.005} value={t.fontSize}
						onChange={(e) => patchSubtitle(seg, { fontSize: Number(e.target.value) })}
						style={{ width: 130 }}
						title="字号（画幅高的比例）"
					/>
				</div>
				<div style={rowSt}>
					<span>字体颜色</span>
					<input
						type="color" value={t.color}
						onChange={(e) => patchSubtitle(seg, { color: e.target.value })}
						style={{ width: 44, height: 24, padding: 0, border: "1px solid rgba(255,255,255,0.14)", borderRadius: 5, background: "transparent", cursor: "pointer" }}
						title="字体颜色"
					/>
				</div>
				<div style={rowSt}>
					<span>描边颜色</span>
					<input
						type="color" value={t.strokeColor}
						onChange={(e) => patchSubtitle(seg, { strokeColor: e.target.value })}
						style={{ width: 44, height: 24, padding: 0, border: "1px solid rgba(255,255,255,0.14)", borderRadius: 5, background: "transparent", cursor: "pointer" }}
						title="描边颜色（预览为近似描边，导出剪映为真描边）"
					/>
				</div>
			</div>

			{/* 位置（画幅比例，0=中心） */}
			<div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.07)" }}>
				<div style={rowSt}>
					<span>水平位置 {Math.round(t.x * 100)}%</span>
					<input
						type="range" min={-0.5} max={0.5} step={0.01} value={t.x}
						onChange={(e) => patchSubtitle(seg, { x: Number(e.target.value) })}
						style={{ width: 130 }}
						title="水平位置（0=居中，负=向左）"
					/>
				</div>
				<div style={rowSt}>
					<span>垂直位置 {Math.round(t.y * 100)}%</span>
					<input
						type="range" min={-0.5} max={0.5} step={0.01} value={t.y}
						onChange={(e) => patchSubtitle(seg, { y: Number(e.target.value) })}
						style={{ width: 130 }}
						title="垂直位置（0=居中，正=向下；默认 40%≈底部字幕带）"
					/>
				</div>
				<div style={{ fontSize: 10, lineHeight: 1.6, color: "rgba(255,255,255,0.38)" }}>
					位置按画幅比例存储——切换画幅/分辨率档字幕不失位；导出剪映草稿时落到片段 clip.transform。
				</div>
			</div>
		</div>
	);
}
