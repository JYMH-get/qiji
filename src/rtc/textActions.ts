/**
 * textActions —— 字幕轨动作层：添加字幕片段（无字幕轨自动新建）。
 *
 * 入口（第三批）：
 *   - 时间轴角块「＋字幕」按钮 → addSubtitleAtPlayhead()（落在播放头处）；
 *   - 时间轴 text 轨空白**双击** → addSubtitleSegmentAt(trackId, atUs)（落在双击处）。
 * 一次调用 = 一条 undo（新建轨 + 落片段在同一 commit 里）；落点被占走 addSegment 的
 * 「夹到最近空隙」既有语义。片段形状：kind="media" + text 字段（无 assetId/uri——字幕无素材）。
 */
import { genId } from "@/lib/id";
import { addSegment, insertTrackAt } from "@/lib/rtcOps";
import { DEFAULT_SUBTITLE_TEXT, SUBTITLE_DEFAULT_US, textSegName } from "@/lib/rtcTextCore";
import { useRtcStore } from "@/store/rtcStore";
import type { RtcSegment } from "@/types/rtc";

/**
 * 在指定字幕轨（trackId 为空/失效则取首条未锁 text 轨；再没有则**新建**一条「字幕」轨）
 * 的 atUs 处添加一条默认字幕片段（3 秒、「双击编辑字幕」），并选中它。
 */
export function addSubtitleSegmentAt(trackId: string | null, atUs: number): void {
	const st = useRtcStore.getState();
	if (!st.doc) return;
	const segId = genId("seg");
	st.commit((d) => {
		let next = d;
		// 原文参考轨（role:"script"）不接字幕——它不导出，字幕落上去会静默丢（挑轨时一律绕开）
		let tid = trackId && next.tracks.some((t) => t.id === trackId && t.type === "text" && t.role !== "script" && !t.locked) ? trackId : null;
		if (!tid) {
			const existing = next.tracks.find((t) => t.type === "text" && t.role !== "script" && !t.locked);
			if (existing) tid = existing.id;
			else {
				// text 组恒在 doc.tracks 数组头部（TRACK_TYPE_ORDER text<video<audio），插 0 即组内
				tid = genId("track");
				next = insertTrackAt(next, "text", 0, { id: tid, name: "字幕" });
			}
		}
		const seg: RtcSegment = {
			id: segId,
			kind: "media",
			name: textSegName(DEFAULT_SUBTITLE_TEXT),
			text: { content: DEFAULT_SUBTITLE_TEXT },
			targetStartUs: Math.max(0, Math.round(atUs)),
			targetDurationUs: SUBTITLE_DEFAULT_US,
		};
		return addSegment(next, tid, seg);
	});
	st.setSelection([segId]);
}

/** 在播放头处添加字幕片段（时间轴角块「＋字幕」按钮用） */
export function addSubtitleAtPlayhead(): void {
	addSubtitleSegmentAt(null, useRtcStore.getState().playheadUs);
}
