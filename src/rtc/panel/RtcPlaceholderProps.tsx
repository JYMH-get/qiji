import type { RtcSelected } from "./useRtcSelected";
import { RtcTimeFields } from "./RtcTimeFields";
import { fmtUs, usToSecLabel } from "./rtcSegUtils";

/** 占位与素材共享时间轴身份；生成选项集中在工具栏的生成设置。 */
export function RtcPlaceholderProps({ seg, track, segIndex }: RtcSelected) {
    const media = seg.media || (track.type === "audio" ? "audio" : "video");
    return <div style={{ padding: "12px 12px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>{seg.name || "结果占位"}</div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.8 }}>
            <div>{({ image: "图片", video: "视频", audio: "音频" })[media]}占位 · {track.name || "轨道"} · 第 {segIndex + 1} 段</div>
            <div>{fmtUs(seg.targetStartUs)} → {fmtUs(seg.targetStartUs + seg.targetDurationUs)}（{usToSecLabel(seg.targetDurationUs)}）</div>
        </div>
        <RtcTimeFields seg={seg} track={track} />
        {seg.originSegId && <div style={{ fontSize: 11, color: "rgba(167,139,250,0.8)" }}>新版本占位，下方原结果保留。</div>}
    </div>;
}
