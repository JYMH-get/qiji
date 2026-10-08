/**
 * rtcCenterTabCore —— 中栏三页签（总览 / AI 工作台 / 预览）的纯逻辑层。
 *
 * 初始页签仅在会话首次挂载时按播放头与 doc 内容确定一次。之后由页签、快捷键及明确导航入口
 * 切换（时间轴单击片段打开 AI 工作台，预览页需双击），移动播放头和生成完成不自动切页。
 * 「预览」的显示只取决于页签，播放到占位符或空隙仍显示预览，不自动露出工作台。
 */
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";

export type RtcCenterTab = "overview" | "workbench" | "preview";

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
	{ id: "overview", label: "总览" },
	{ id: "workbench", label: "AI 工作台" },
	{ id: "preview", label: "预览" },
];

/** 仅用于首次初始化：优先按播放头下主轨片段（占位=工作台/有结果=预览）；
 *  空白处按 docHasPlayable 兜底（doc 是否已有任何 media/compound 片段）。 */
export function initialCenterTab(docHasPlayable: boolean, phSegKind?: string | null): RtcCenterTab {
	if (phSegKind) return phSegKind === "placeholder" ? "workbench" : "preview";
	return docHasPlayable ? "preview" : "workbench";
}

/**
 * 预览显示只由页签决定，占位符和空隙也保持预览。
 * 保留片段类型参数兼容调用方，但它不再参与显示判定。
 */
export function resultLayerVisible(tab: RtcCenterTab, _phSegKind?: string | null): boolean {
	return tab === "preview";
}
