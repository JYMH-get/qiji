import { orderTracksForDisplay } from "@/lib/rtcOps";
import type { StoryboardShot } from "@/services/projectFile";
import type { RtcDoc, RtcSegment } from "@/types/rtc";

export interface RtcShotListRow {
	key: string;
	shot: StoryboardShot;
	segmentId?: string;
	trackName?: string;
	startUs?: number;
	durationUs?: number;
	status: string;
}

/** 时间轴是真实排序来源；同镜头的分割/不同版本分别保留定位入口。 */
export function rtcShotListRows(doc: RtcDoc | null, episodeId: string, shots: StoryboardShot[]): RtcShotListRow[] {
	const byId = new Map(shots.map((s) => [s.id, s]));
	const placed = new Set<string>();
	const rows: Array<RtcShotListRow & { order: number }> = [];
	const status = (seg: RtcSegment) => seg.kind === "media" ? "素材" : seg.status === "running" ? "生成中" : seg.status === "failed" ? "生成失败" : "待生成";
	for (const [order, track] of orderTracksForDisplay(doc?.tracks ?? []).entries()) {
		if (track.type !== "video") continue;
		for (const seg of track.segments) {
			const add = (source: RtcSegment, startUs: number, durationUs: number, compound = false) => {
				if (source.shotRef?.episodeId !== episodeId) return;
				const shot = byId.get(source.shotRef.shotId);
				if (!shot) return;
				placed.add(shot.id);
				rows.push({ key: `${seg.id}/${source.id}`, shot, segmentId: seg.id, startUs, durationUs, order,
					trackName: track.name || "视频轨道", status: compound ? `复合 · ${seg.name || "复合片段"}` : status(source) });
			};
			if (seg.kind !== "compound") {
				add(seg, seg.targetStartUs, seg.targetDurationUs);
				continue;
			}
			// 主层导航复合内镜头时选宿主、不切层；时间按宿主裁剪与倍速换算。
			const sub = seg.subDocId ? doc?.subDocs?.[seg.subDocId] : undefined;
			const speed = seg.speed && seg.speed > 0 ? seg.speed : 1;
			const sourceStart = seg.sourceStartUs ?? 0;
			const sourceEnd = sourceStart + Math.min(seg.sourceDurationUs ?? Infinity, seg.targetDurationUs * speed);
			for (const childTrack of orderTracksForDisplay(sub?.tracks ?? [])) {
				if (childTrack.type !== "video") continue;
				for (const child of childTrack.segments) {
					const from = Math.max(sourceStart, child.targetStartUs);
					const to = Math.min(sourceEnd, child.targetStartUs + child.targetDurationUs);
					if (to > from) add(child, seg.targetStartUs + (from - sourceStart) / speed, (to - from) / speed, true);
				}
			}
		}
	}
	rows.sort((a, b) => a.startUs! - b.startUs! || a.order - b.order || a.key.localeCompare(b.key));
	return [
		...rows,
		...shots.filter((shot) => !placed.has(shot.id)).map((shot) => ({ key: `unplaced/${shot.id}`, shot, status: "未在当前时间轴" })),
	];
}
