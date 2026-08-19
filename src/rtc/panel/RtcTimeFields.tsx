/**
 * RtcTimeFields —— 片段的**精确时间输入**（起点 / 时长，属性面板用；media 与占位片段共用）。
 *
 * 语义（对标剪映的时间码输入）：
 *   - **改起点 = 移动片段**（走 rtcOps.moveSegment）：撞到邻段就夹到最近的合法空隙，绝不推挤别人；
 *   - **改时长 = 从右端裁剪**（走 rtcOps.trimSegment "end"）：不越过后一片段左缘，
 *     带源窗口的素材还受**素材可用长度**约束（sourceTotalUs 取自 videoDurationStore 的探测结果）；
 *   - 输入形态两种都收：`0:06.30` 时间码 与 `6.3` 秒数（见 rtcOps.parseTimecodeInput）；
 *     **非法输入静默回退原值**（不报错、不提交）；
 *   - ⚠ 文本没改动就不提交——否则「点进去又点出来」会因显示精度（10ms 网格）把时长悄悄挪几毫秒；
 *   - 轨道锁定时只读。
 *
 * 每次提交 = 一次 `rtcStore.commit` = 一条 undo（与拖动/裁剪手势同粒度）。
 */
import { useEffect, useState } from "react";
import { formatEditableTime, moveSegment, parseTimecodeInput, trimSegment } from "@/lib/rtcOps";
import { useRtcStore } from "@/store/rtcStore";
import { useVideoDurationStore } from "@/store/videoDurationStore";
import type { RtcSegment, RtcTrack } from "@/types/rtc";
import { fmtUs } from "./rtcSegUtils";

const rowSt: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 11, color: "rgba(255,255,255,0.6)" };
const valSt: React.CSSProperties = { color: "rgba(255,255,255,0.9)", fontSize: 12, textAlign: "right" };
const inputSt: React.CSSProperties = {
	width: 110,
	background: "rgba(255,255,255,0.05)",
	border: "1px solid rgba(255,255,255,0.12)",
	borderRadius: 6,
	color: "#fff",
	padding: "5px 8px",
	fontSize: 12,
	textAlign: "right",
	fontFamily: "ui-monospace, monospace",
	outline: "none",
};

/** 单个时间输入框：草稿式（回车/失焦提交，Esc 放弃），非法值静默回退 */
function TimeInput({
	value,
	onCommit,
	disabled,
	title,
}: {
	/** 当前值的显示文本（同时是回退基准） */
	value: string;
	onCommit: (us: number) => void;
	disabled?: boolean;
	title?: string;
}) {
	const [draft, setDraft] = useState(value);
	// 外部值变化（提交生效 / 被夹到合法位置 / 换选片段）→ 同步回显示值
	useEffect(() => setDraft(value), [value]);

	const submit = () => {
		if (draft === value) return; // 没改动=不提交（防显示精度把值悄悄挪走）
		const us = parseTimecodeInput(draft);
		setDraft(value); // 先回退到当前值；提交成功后由上面的 effect 换成新值
		if (us != null) onCommit(us);
	};

	return (
		<input
			value={draft}
			disabled={disabled}
			title={title}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={submit}
			onKeyDown={(e) => {
				e.stopPropagation(); // 别让输入里的空格/方向键冒到时间轴快捷键
				if (e.key === "Enter") (e.target as HTMLInputElement).blur();
				else if (e.key === "Escape") {
					setDraft(value);
					(e.target as HTMLInputElement).blur();
				}
			}}
			style={{ ...inputSt, opacity: disabled ? 0.5 : 1 }}
		/>
	);
}

export function RtcTimeFields({ seg, track }: { seg: RtcSegment; track: RtcTrack }) {
	const locked = !!track.locked;
	const startText = formatEditableTime(seg.targetStartUs);
	const durText = formatEditableTime(seg.targetDurationUs);

	/** 源素材总长（有探测结果才给）——trimSegment 据此不让右缘越过素材可用长度 */
	const sourceTotalUs = useVideoDurationStore((s) => {
		if (seg.kind !== "media" || (seg.media !== "video" && seg.media !== "audio") || !seg.uri) return undefined;
		const sec = s.seconds[seg.uri];
		return sec && sec > 0 ? Math.round(sec * 1_000_000) : undefined;
	});

	const setStart = (us: number) => {
		useRtcStore.getState().commit((d) => moveSegment(d, seg.id, track.id, us));
	};
	const setDuration = (us: number) => {
		const delta = us - seg.targetDurationUs;
		if (!delta) return;
		useRtcStore.getState().commit((d) => trimSegment(d, seg.id, "end", delta, { sourceTotalUs }));
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
			<div style={rowSt}>
				<span>起点</span>
				<TimeInput
					value={startText}
					disabled={locked}
					title={locked ? "轨道已锁定" : "片段起点：可填 0:06.30 或 6.3（秒）；被邻段占住会夹到最近的空隙"}
					onCommit={setStart}
				/>
			</div>
			<div style={rowSt}>
				<span>时长</span>
				<TimeInput
					value={durText}
					disabled={locked}
					title={locked ? "轨道已锁定" : "片段时长：从右端裁剪；不会越过后一片段，也不会超出素材可用长度"}
					onCommit={setDuration}
				/>
			</div>
			<div style={rowSt}>
				<span>终点</span>
				<span style={valSt}>{fmtUs(seg.targetStartUs + seg.targetDurationUs)}</span>
			</div>
		</div>
	);
}
