/**
 * rtcCenterTabCore —— 中栏双页签（AI 工作台 / 预览）的纯逻辑层（零依赖可单测）。
 *
 * ⚠ **第251轮需求⑨：页签改纯手动，自动切换整体废止（勿回退）**。
 *   用户实报：「现在时间轴一动，就会回到预览，很影响用户在整理提示词的状态」——第240轮那套
 *   自动切换（新选中占位→工作台 / 选素材→预览 / 占位变成片→预览 / 播放头跟随）会在用户正在
 *   编辑提示词时把页面抽走，是**明确的干扰**，故全部删除。本文件现在只剩两件事：
 *
 *  1) **初始页签**（会话首次挂载定一次，见 rtcCenterTabStore）：播放头下主轨片段有结果?「预览」:
 *     占位符?「AI 工作台」: 按 doc 是否有可播片段兜底（用户定「当没有结果时默认显示 AI 工作台」）；
 *  2) **手动点页签永远生效**，且**只有**手动能切。
 *
 * 「播放到无结果区间露出工作台」不是切页签——那是**层级**语义（工作台是底、结果是面），
 * 由 [RtcCenterStage](../RtcCenterStage.tsx) 按播放头处片段有没有结果决定面层显隐，页签态不动。
 */
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";

export type RtcCenterTab = "workbench" | "preview";

/**
 * 播放头下的主轨片段（主轨=第一条 video 轨，与 rtcScriptLane/占位入轨同定义；区间右开，
 * 与字幕/原文车道同规）。无 doc/无主轨/落在空白处 = null。
 */
export function mainTrackSegAt(
	doc: RtcDoc | null | undefined,
	tUs: number,
): { seg: RtcSegment; track: RtcTrack; segIndex: number } | null {
	const track = doc?.tracks.find((t) => t.type === "video");
	if (!track) return null;
	for (let i = 0; i < track.segments.length; i++) {
		const seg = track.segments[i];
		if (tUs >= seg.targetStartUs && tUs < seg.targetStartUs + seg.targetDurationUs) {
			return { seg, track, segIndex: i };
		}
	}
	return null;
}

export const CENTER_TABS: readonly { id: RtcCenterTab; label: string }[] = [
	{ id: "workbench", label: "AI 工作台" },
	{ id: "preview", label: "预览" },
];

/** 规则 1：初始页签——优先按播放头下主轨片段（占位=工作台/有结果=预览）；
 *  空白处按 docHasPlayable 兜底（doc 是否已有任何 media/compound 片段）。 */
export function initialCenterTab(docHasPlayable: boolean, phSegKind?: string | null): RtcCenterTab {
	if (phSegKind) return phSegKind === "placeholder" ? "workbench" : "preview";
	return docHasPlayable ? "preview" : "workbench";
}

/**
 * 「预览」页里**面层（结果预览）是否露出**：播放头所在的主轨片段有成片才露出，
 * 占位符 / 空白区间一律让开，露出底下的 AI 工作台（第251轮需求⑨用户定稿的层级语义）。
 * ⚠ 这不改页签态——页签只由用户手动切；本判定每帧都可能被问到，故做成零分配纯函数。
 */
export function resultLayerVisible(tab: RtcCenterTab, phSegKind: string | null | undefined): boolean {
	if (tab !== "preview") return false;
	return phSegKind === "media" || phSegKind === "compound";
}
