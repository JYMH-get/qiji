import { create } from "zustand";
import { resolveEpisodeKey, useProjectStore } from "@/store/projectStore";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { useRtcAssetSelStore } from "../rtcAssetSelStore";
import { useRtcCenterTabStore } from "../panel/rtcCenterTabStore";
import { rtcShotListRows } from "./rtcShotListCore";
import { navigateRtcShot } from "./rtcShotNavigation";
import { workbenchFocusMatches } from "../panel/rtcWorkbenchTargetCore";

/** 显式打开的整集归属；总览与单镜工作台各有独立页签。 */
interface EpisodeView {
	projectId: string;
	episodeId: string;
}
export const useRtcEpisodeWorkbenchView = create<{ target: EpisodeView | null }>(() => ({ target: null }));

export function closeRtcEpisodeWorkbench(): void {
	if (useRtcEpisodeWorkbenchView.getState().target) useRtcEpisodeWorkbenchView.setState({ target: null });
}

export function openRtcEpisodeWorkbench(episodeId: string): void {
	const project = useProjectStore.getState();
	if (project.isProjectLoading || !project.episodes.some((ep) => ep.id === episodeId)) return;
	project.switchRtcEpisode(episodeId);
	const rtc = useRtcStore.getState();
	if (rtc.editingSubDocId) rtc.exitCompound();
	rtc.setSelection([]);
	useRtcAssetSelStore.getState().clear();
	useRtcEpisodeWorkbenchView.setState({ target: {
		projectId: project.projectInstanceId, episodeId,
	} });
	// 切到总览时隐藏剧本处理面但保留挂载，未保存草稿可再次打开继续编辑。
	useRtcCenterTabStore.getState().setTab("overview");
}

/** 预览中单击仅选中供画面编辑，双击才打开 AI 工作台；其他页单击即打开。不改变播放头或文档。 */
export function openRtcTimelineWorkbench(segmentId: string, gesture: "single" | "double" = "single"): boolean {
	if (gesture === "single" && useRtcCenterTabStore.getState().tab === "preview") return false;
	const project = useProjectStore.getState();
	const rtc = useRtcStore.getState();
	if (project.isProjectLoading || rtc.ownerProjectId !== project.projectInstanceId
		|| rtc.ownerEpisodeKey !== resolveEpisodeKey(project.rtcEpisodeId, project.episodes)
		|| !rtc.selection.includes(segmentId)
		|| !activeRtcDoc(rtc)?.tracks.some(track => track.segments.some(seg => seg.id === segmentId))) return false;
	if (rtc.workbenchFocus?.segId !== segmentId || !workbenchFocusMatches(rtc.workbenchFocus, rtc)) rtc.setSelection(rtc.selection, segmentId);
	closeRtcEpisodeWorkbench();
	useRtcAssetSelStore.getState().clear();
	useRtcCenterTabStore.getState().setTab("workbench");
	return true;
}

/** 表格里的查看操作与右侧分镜列表共用定位规则；用户删掉的占位不会被查看动作重建。 */
export function openRtcEpisodeShot(episodeId: string, shotId: string): boolean {
	const project = useProjectStore.getState();
	const rtc = useRtcStore.getState();
	const doc = activeRtcDoc(rtc);
	const episode = project.episodes.find((ep) => ep.id === episodeId);
	if (!doc || !episode) return false;
	const row = rtcShotListRows(doc, episodeId, episode.shots).find((r) => r.shot.id === shotId && r.segmentId);
	if (!row) return false;
	const moved = navigateRtcShot({ projectId: project.projectInstanceId, episodeId,
		subDocId: rtc.editingSubDocId, docId: doc.id }, doc, row.key, false);
	if (moved) {
		closeRtcEpisodeWorkbench();
		useRtcCenterTabStore.getState().setTab("workbench");
	}
	return moved;
}

// 订阅只清理显式打开的整集归属标记，不切页；时间轴用户入口负责打开 AI 工作台。
// 播放和流式写入不自动离开总览，当前分集内容由总览组件跟随项目状态显示。
useRtcStore.subscribe((rtc, previous) => {
	const target = useRtcEpisodeWorkbenchView.getState().target;
	if (!target) return;
	if (rtc.workbenchFocusRevision !== previous.workbenchFocusRevision && rtc.selection.length > 0) {
		closeRtcEpisodeWorkbench();
	}
});
useProjectStore.subscribe((project) => {
	const target = useRtcEpisodeWorkbenchView.getState().target;
	if (target && (project.isProjectLoading || target.projectId !== project.projectInstanceId
		|| resolveEpisodeKey(project.rtcEpisodeId, project.episodes) !== target.episodeId
		|| !project.episodes.some((ep) => ep.id === target.episodeId))) closeRtcEpisodeWorkbench();
});
