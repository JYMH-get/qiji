import { create } from "zustand";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { resolveEpisodeKey, useProjectStore } from "@/store/projectStore";
import type { RtcDoc, RtcTrack, RtcSegment } from "@/types/rtc";
import { rtcShotListRows } from "./rtcShotListCore";
import { useRtcAssetSelStore } from "../rtcAssetSelStore";
import { useRtcCenterTabStore } from "../panel/rtcCenterTabStore";

export interface RtcShotNavScope {
	projectId: string;
	episodeId: string;
	subDocId: string | null;
	docId: string;
}
export interface RtcShotReveal extends RtcShotNavScope {
	segmentId: string;
	positionUs: number;
}
interface RtcShotListSelection {
	scope: RtcShotNavScope;
	rowKey: string;
	segmentId: string;
	shotId: string;
	revision: number;
	playheadUs: number;
}
export const useRtcShotNavigation = create<{
	reveal: RtcShotReveal | null;
	listSelection: RtcShotListSelection | null;
}>(() => ({ reveal: null, listSelection: null }));

export function isRtcShotNavScopeCurrent(scope: RtcShotNavScope): boolean {
	const project = useProjectStore.getState();
	const rtc = useRtcStore.getState();
	return !project.isProjectLoading && project.projectInstanceId === scope.projectId
		&& resolveEpisodeKey(project.rtcEpisodeId, project.episodes) === scope.episodeId
		&& rtc.ownerProjectId === scope.projectId && rtc.ownerEpisodeKey === scope.episodeId
		&& rtc.editingSubDocId === scope.subDocId && activeRtcDoc(rtc)?.id === scope.docId;
}

/** 列表焦点不属于时间轴选区；后续轨道选择/播放/换层使这次列表焦点失效。 */
export function isRtcShotListSelection(): boolean {
	const marker = useRtcShotNavigation.getState().listSelection;
	const rtc = useRtcStore.getState();
	if (!marker || marker.revision !== rtc.workbenchFocusRevision || rtc.selection.length > 0
		|| marker.playheadUs !== rtc.playheadUs || !isRtcShotNavScopeCurrent(marker.scope)) return false;
	const episode = useProjectStore.getState().episodes.find(ep => ep.id === marker.scope.episodeId);
	return rtcShotListRows(activeRtcDoc(rtc), marker.scope.episodeId, episode?.shots ?? []).some(row => row.key === marker.rowKey && row.shot.id === marker.shotId);
}

/** 当前行对应的最新可编辑素材；复合内容要进入子层后编辑，不能从主层错投写入。 */
export function rtcShotListTarget(): { seg: RtcSegment; track: RtcTrack; segIndex: number } | null {
	if (!isRtcShotListSelection()) return null;
	const marker = useRtcShotNavigation.getState().listSelection!;
	const doc = activeRtcDoc(useRtcStore.getState());
	if (!doc) return null;
	for (const track of doc.tracks) {
		const segIndex = track.segments.findIndex(seg => seg.id === marker.segmentId);
		if (segIndex < 0) continue;
		const seg = track.segments[segIndex];
		return seg.kind === "compound" ? null : { seg, track, segIndex };
	}
	return null;
}

export function navigateRtcShot(scope: RtcShotNavScope, expectedDoc: RtcDoc, rowKey: string, seek: boolean): boolean {
	if (!isRtcShotNavScopeCurrent(scope)) return false;
	const rtc = useRtcStore.getState();
	if (activeRtcDoc(rtc) !== expectedDoc) return false;
	const episode = useProjectStore.getState().episodes.find((ep) => ep.id === scope.episodeId);
	const row = rtcShotListRows(expectedDoc, scope.episodeId, episode?.shots ?? []).find((r) => r.key === rowKey);
	if (!row?.segmentId || row.startUs == null) return false;
	// 先清时间轨选区；列表仅持有自己的行身份，不借用 selection 制造第二处高亮。
	rtc.setSelection([]);
	if (seek) rtc.setPlayhead(row.startUs);
	const current = useRtcStore.getState();
	useRtcShotNavigation.setState({ listSelection: { scope, rowKey, segmentId: row.segmentId, shotId: row.shot.id,
		revision: current.workbenchFocusRevision, playheadUs: current.playheadUs },
		reveal: { ...scope, segmentId: row.segmentId, positionUs: row.startUs } });
	useRtcAssetSelStore.getState().clear();
	useRtcCenterTabStore.getState().setTab("workbench");
	return true;
}

function pruneListSelection() {
	if (useRtcShotNavigation.getState().listSelection && !isRtcShotListSelection()) {
		useRtcShotNavigation.setState({ listSelection: null, reveal: null });
	}
}
useRtcStore.subscribe(pruneListSelection);
useProjectStore.subscribe(pruneListSelection);
