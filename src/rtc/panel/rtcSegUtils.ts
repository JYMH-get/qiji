/**
 * rtcSegUtils —— 属性面板对片段的**内联不可变更新** + 时间格式化。
 *
 * ⚠ 本轮分工约定：rtcOps.ts / rtcStore.ts / types/rtc.ts 归时间轴任务独占——
 *   属性面板改 segment 属性一律走 `rtcStore.commit(doc => …)` + 本文件的内联不可变 patch，
 *   **不往 rtcOps 加函数**。找不到片段返回原 doc 引用（commit 视为 no-op，不进撤销栈不落盘）。
 */
import { useRtcStore } from "@/store/rtcStore";
import { setSegmentSpeed } from "@/lib/rtcOps";
import type { RtcDoc, RtcSegment } from "@/types/rtc";

/** 对某片段应用属性补丁（内联不可变更新；片段不存在=原 doc 引用 no-op） */
export function patchSegmentDoc(doc: RtcDoc, segId: string, patch: Partial<RtcSegment>): RtcDoc {
	let hit = false;
	const tracks = doc.tracks.map((t) => {
		const idx = t.segments.findIndex((s) => s.id === segId);
		if (idx < 0) return t;
		hit = true;
		const segments = [...t.segments];
		segments[idx] = { ...segments[idx], ...patch };
		return { ...t, segments };
	});
	return hit ? { ...doc, tracks } : doc;
}

/** 经 rtcStore.commit 提交一次片段属性补丁（自动 undo + 落盘；片段已删则静默 no-op）。
 *  ⚠ speed 不许经这里纯 patch（时长不联动=播放出错的老 bug），走 commitSegmentSpeed。 */
export function commitSegmentPatch(segId: string, patch: Partial<RtcSegment>): void {
	useRtcStore.getState().commit((doc) => patchSegmentDoc(doc, segId, patch));
}

/** 变速唯一提交入口：走 rtcOps.setSegmentSpeed（speed 与 target 时长联动，维持
 *  sourceDurationUs ≈ targetDurationUs × speed 不变量）。经 commitActive 提交——
 *  编辑复合子层时写进子文档（§9A 第238轮：编辑动作须感知复合子层；主层=commit 同义）。 */
export function commitSegmentSpeed(segId: string, speed: number): void {
	useRtcStore.getState().commitActive((doc) => setSegmentSpeed(doc, segId, speed));
}

/** 微秒 → 时间码 "m:ss.d"（分:秒.十分位；小时级自动带 h:） */
export function fmtUs(us: number): string {
	const totalSec = Math.max(0, us) / 1_000_000;
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	const sec = s.toFixed(1).padStart(4, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** 微秒 → 秒（保留 1 位小数，展示用） */
export function usToSecLabel(us: number): string {
	return `${(Math.max(0, us) / 1_000_000).toFixed(1)}s`;
}
