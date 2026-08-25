/**
 * useRtcSelected —— 右栏属性面板 / 中央舞台共用的「当前选中片段」解析。
 * 取 rtcStore.selection 第一个 id，在 doc 里定位片段与所在轨道；
 * 占位符片段另可经 useShotOfSeg 解析出关联的分集/分镜（projectStore）。
 */
import { useMemo } from "react";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { useProjectStore } from "@/store/projectStore";
import { mainTrackSegAt } from "./rtcCenterTabCore";
import type { RtcSegment, RtcTrack } from "@/types/rtc";
import type { StoryboardShot, VideoEpisode } from "@/services/projectFile";

export interface RtcSelected {
	seg: RtcSegment;
	track: RtcTrack;
	/** 该轨道内序号（0 基，展示用） */
	segIndex: number;
}

/** 当前选中的第一个片段（无选中/片段已删=null）。订阅 doc+selection，选中变化即刷新。
 *  第四批：按**当前编辑层**解析（复合子层编辑时选中的是子文档片段）。 */
export function useRtcSelected(): RtcSelected | null {
	const doc = useRtcStore(activeRtcDoc);
	const selection = useRtcStore((s) => s.selection);
	return useMemo(() => {
		if (!doc || selection.length === 0) return null;
		const id = selection[0];
		for (const track of doc.tracks) {
			const segIndex = track.segments.findIndex((s) => s.id === id);
			if (segIndex >= 0) return { seg: track.segments[segIndex], track, segIndex };
		}
		return null;
	}, [doc, selection]);
}

/**
 * 中栏「AI 工作台」的绑定目标（第240轮补充3 用户定稿「默认显示当前时间的 ai 界面」）：
 * 显式选中的**可编辑片段**优先；无选中（或选中的不可编辑）→ 回退**播放头下主轨的可编辑片段**——
 * 播放头停在待生成/已成片的片段上时工作台直接绑定它（三栏常显，不再出现「未选中」引导黑屏）。
 *
 * ⚠ 「可编辑」的判据（第251轮需求⑦，勿收回成 `kind === "placeholder"`）：
 *   **占位符 或 带 shotRef 的片段**。用户实报「占位符变成成品后丢失了 AI 工作台数据，
 *   无法二次编辑」——数据其实一直在（成片替换只改 kind/media/uri，shotRef 原样保留），
 *   丢的是**入口**：判定写死了 kind。放宽后成片片段照样能回工作台改提示词/垫图并重跑
 *   （重跑落在上方新占位，原结果原位保留，见 timeline/segActions.regenerateShotResult）。
 * ⚠ 播放头选择器只返回 doc 里的稳定 seg 引用（帧级 playheadUs 变化下结果不变=不重渲染）。
 */
/** 该片段能否进 AI 工作台（占位符=待生成的坑位；带 shotRef 的成片=可二次编辑重跑） */
function workbenchEditable(seg: { kind: string; shotRef?: unknown }): boolean {
	return seg.kind === "placeholder" || !!seg.shotRef;
}

export function useWorkbenchTarget(): RtcSelected | null {
	const sel = useRtcSelected();
	const doc = useRtcStore(activeRtcDoc);
	const phSeg = useRtcStore((s) => {
		const m = mainTrackSegAt(activeRtcDoc(s), s.playheadUs);
		return m && workbenchEditable(m.seg) ? m.seg : null;
	});
	return useMemo(() => {
		if (sel && workbenchEditable(sel.seg)) return sel;
		if (!doc || !phSeg) return null;
		for (const track of doc.tracks) {
			const segIndex = track.segments.findIndex((s) => s.id === phSeg.id);
			if (segIndex >= 0) return { seg: track.segments[segIndex], track, segIndex };
		}
		return null;
	}, [sel, doc, phSeg]);
}

/** 片段 shotRef → 关联的分集/分镜（实时订阅 projectStore；分镜被删=shot undefined） */
export function useShotOfSeg(seg: RtcSegment | null): { episode?: VideoEpisode; shot?: StoryboardShot } {
	const episodeId = seg?.shotRef?.episodeId;
	const shotId = seg?.shotRef?.shotId;
	const episode = useProjectStore((s) => (episodeId ? s.episodes.find((e) => e.id === episodeId) : undefined));
	const shot = useMemo(
		() => (shotId ? episode?.shots.find((x) => x.id === shotId) : undefined),
		[episode, shotId],
	);
	return { episode, shot };
}
