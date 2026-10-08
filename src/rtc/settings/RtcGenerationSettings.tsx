import { useProjectStore } from "@/store/projectStore";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import type { RtcDoc } from "@/types/rtc";
import type { RtcSelected } from "../panel/useRtcSelected";
import { workbenchSelectedId } from "../panel/rtcWorkbenchTargetCore";
import { rtcShotListTarget, useRtcShotNavigation } from "../flow/rtcShotNavigation";
import { RtcShotWorkbench } from "../panel/RtcShotWorkbench";
import { RtcFreeGenProps } from "../panel/RtcFreeGenProps";
import { useRtcAssetSelStore } from "../rtcAssetSelStore";

/** 只使用明确目标，不按播放头回退到另一镜；字幕/复合/普通素材只展示项目默认。 */
export function rtcGenerationSettingsTarget(doc: RtcDoc | null, selectedId: string | undefined, listTarget: RtcSelected | null): RtcSelected | null {
    let target = selectedId ? null : listTarget;
    if (selectedId) for (const track of doc?.tracks ?? []) {
        const segIndex = track.segments.findIndex(seg => seg.id === selectedId);
        if (segIndex >= 0) { target = { seg: track.segments[segIndex], track, segIndex }; break; }
    }
    if (!target || target.track.type === "text" || target.seg.kind === "compound") return null;
    return target.seg.kind === "placeholder" || target.seg.shotRef ? target : null;
}

/** 项目默认始终可编辑；当前目标的独立设置仍写回原字段。 */
export function RtcGenerationSettings() {
    const owner = useProjectStore(s => s.projectInstanceId);
    const loading = useProjectStore(s => s.isProjectLoading);
    const doc = useRtcStore(s => s.ownerProjectId === owner ? activeRtcDoc(s) : null);
    const selectedId = useRtcStore(workbenchSelectedId);
    useRtcShotNavigation(s => s.listSelection);
    const asset = useRtcAssetSelStore(s => s.selected);
    const target = asset ? null : rtcGenerationSettingsTarget(doc, selectedId, rtcShotListTarget());
    const shot = target?.seg.shotRef;
    if (loading) return <div style={{ padding: 16, color: "rgba(255,255,255,0.5)" }}>正在打开项目…</div>;
    return <div key={owner} data-rtc-generation-settings style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <RtcShotWorkbench episodeId={shot?.episodeId} shotId={shot?.shotId} />
        {target?.seg.kind === "placeholder" && !shot && <section aria-label="当前占位生成设置" style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
            <RtcFreeGenProps key={target.seg.id} {...target} />
        </section>}
    </div>;
}
