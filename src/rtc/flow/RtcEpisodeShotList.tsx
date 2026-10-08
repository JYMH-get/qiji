import { useMemo } from "react";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { useProjectStore } from "@/store/projectStore";
import type { VideoEpisode } from "@/services/projectFile";
import { rtcShotListRows } from "./rtcShotListCore";
import { isRtcShotListSelection, navigateRtcShot, useRtcShotNavigation } from "./rtcShotNavigation";
import { useRtcPropsTabStore } from "../panel/rtcPropsTabStore";

const time = (us: number) => `${Math.floor(us / 60_000_000).toString().padStart(2, "0")}:${(us / 1_000_000 % 60).toFixed(2).padStart(5, "0")}`;

export function RtcEpisodeShotList({ episode }: { episode: VideoEpisode }) {
	const doc = useRtcStore(activeRtcDoc);
	const subDocId = useRtcStore((s) => s.editingSubDocId);
	const listSelection = useRtcShotNavigation((s) => s.listSelection);
	const projectId = useProjectStore((s) => s.projectInstanceId);
	const rows = useMemo(() => rtcShotListRows(doc, episode.id, episode.shots), [doc, episode]);
	return <div aria-label="当集分镜列表" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
		{rows.map((row) => {
			const selected = listSelection?.rowKey === row.key && isRtcShotListSelection();
			const go = (seek: boolean) => {
				if (doc && navigateRtcShot({ projectId, episodeId: episode.id, subDocId, docId: doc.id }, doc, row.key, seek)) {
					useRtcPropsTabStore.getState().setTab("shots");
				}
			};
			return <button key={row.key} type="button" disabled={!row.segmentId}
				aria-pressed={selected}
				aria-label={`${row.shot.title} ${row.startUs == null ? row.status : time(row.startUs)}`}
				title={row.segmentId ? `单击平滑定位片段，双击跳转播放头${row.status.startsWith("复合") ? "；进入复合片段后编辑" : ""}` : row.status}
				onClick={() => go(false)} onDoubleClick={() => go(true)}
				style={{ textAlign: "left", padding: "8px 10px", borderRadius: 7, cursor: row.segmentId ? "pointer" : "default",
					border: `1px solid ${selected ? "#a78bfa" : "rgba(255,255,255,0.09)"}`, background: selected ? "rgba(139,92,246,0.16)" : "rgba(255,255,255,0.03)", opacity: row.segmentId ? 1 : .55 }}>
				<div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
					<span style={{ fontSize: 12, color: "#eee", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.shot.title}</span>
					<span style={{ marginLeft: "auto", flexShrink: 0, color: "#aaa", fontSize: 10 }}>{row.startUs == null ? "—" : time(row.startUs)}</span>
				</div>
				<div style={{ marginTop: 4, color: "#999", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
					{row.trackName ? `${row.trackName} · ` : ""}{row.status}{row.durationUs != null ? ` · ${(row.durationUs / 1_000_000).toFixed(1)}s` : ""}
				</div>
			</button>;
		})}
	</div>;
}
