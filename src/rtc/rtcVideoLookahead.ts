import type { RtcDoc } from "@/types/rtc";
import { findJyTransition } from "@/lib/jyTransitions";
import { segmentRate, videoStageAt, type RtcVideoLayer } from "./rtcPlayback";

/**
 * 画面可能换段的真实边界。调用方按 doc 引用缓存；不按帧扫描，不持有 store 或媒体元素。
 * 子时间轴只展开播放器已支持的一层；其转场在主层预览中未展开，故也不额外造转场边界。
 */
export function videoBoundaryTimes(doc: RtcDoc): number[] {
	const times = new Set<number>();
	const add = (time: number) => { if (Number.isFinite(time) && time >= 0) times.add(time); };
	for (const track of doc.tracks) {
		if (track.type !== "video") continue;
		for (const seg of track.segments) {
			const start = seg.targetStartUs, end = start + seg.targetDurationUs;
			if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
			add(start); add(end);
			if (seg.transitionAfter) {
				const kind = findJyTransition(seg.transitionAfter.effectId)?.previewKind;
				const next = track.segments.find(s => s !== seg && s.targetStartUs === end);
				if (kind && next) {
					const duration = Math.max(1, seg.transitionAfter.durationUs);
					const push = kind.startsWith("slide");
					const windowStart = Math.max(start, push ? end - duration : end - Math.floor(duration / 2));
					const windowEnd = Math.min(next.targetStartUs + next.targetDurationUs, push ? end : end + Math.ceil(duration / 2));
					if (windowStart < windowEnd) { add(windowStart); add(windowEnd); }
				}
			}
			const sub = seg.kind === "compound" && seg.subDocId ? doc.subDocs?.[seg.subDocId] : undefined;
			if (!sub) continue;
			const sourceStart = seg.sourceStartUs ?? 0;
			const sourceEnd = seg.sourceDurationUs == null ? Infinity : sourceStart + seg.sourceDurationUs;
			const rate = segmentRate(seg);
			const addChildTime = (childTime: number) => {
				if (childTime < sourceStart || childTime > sourceEnd) return;
				// 子边界可能被倍速映成分数微秒；向上取首个有效微秒，避免浮点回算落到切点左侧。
				const mapped = Math.ceil(start + (childTime - sourceStart) / rate);
				if (mapped >= start && mapped <= end) add(mapped);
			};
			for (const childTrack of sub.tracks) {
				if (childTrack.type !== "video") continue;
				for (const child of childTrack.segments) {
					addChildTime(child.targetStartUs);
					addChildTime(child.targetStartUs + child.targetDurationUs);
				}
			}
		}
	}
	return [...times].sort((a, b) => a - b);
}

function firstBoundaryAfter(boundaries: readonly number[], atUs: number): number {
	let lo = 0, hi = boundaries.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (boundaries[mid] <= atUs) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** 严格晚于播放头的下一边界；传入 videoBoundaryTimes 的已排序结果，便于 rAF 复用缓存。 */
export function nextVideoBoundaryUs(boundaries: readonly number[], atUs: number): number | null {
	if (!Number.isFinite(atUs)) return null;
	return boundaries[firstBoundaryAfter(boundaries, atUs)] ?? null;
}

function continuousVideo(before: RtcVideoLayer | undefined, after: RtcVideoLayer, deltaUs: number): boolean {
	if (!before || before.media !== "video" || before.uri !== after.uri) return false;
	if (before.seg === after.seg && before.frozen === after.frozen) return true;
	const expected = before.sourceSec + (before.frozen ? 0 : deltaUs * before.rate / 1_000_000);
	// 边界前最多取 1µs，容纳源尾钳位与倍速微秒取整；不把真正的裁剪跳转当作连续 split。
	return Math.abs(after.sourceSec - expected) <= 0.00002;
}

/**
 * 每个槽只取 lookahead 窗口内首个需要准备的视频入点（返回的 sourceSec 就是入点源时间）。
 * 同 URI 且源时间连续的 split 不预热；空隙后的重新入场、源时间跳转和转场幽灵都按实际层解算。
 * boundaries 可由调用方 useMemo 缓存，默认独立调用也可用。
 */
export function nextVideoLayers(
	doc: RtcDoc,
	atUs: number,
	lookaheadUs = 1_500_000,
	boundaries: readonly number[] = videoBoundaryTimes(doc),
): RtcVideoLayer[] {
	if (!Number.isFinite(atUs) || !Number.isFinite(lookaheadUs) || lookaheadUs <= 0) return [];
	const out = new Map<string, RtcVideoLayer>();
	const end = atUs + lookaheadUs;
	for (let i = firstBoundaryAfter(boundaries, atUs); i < boundaries.length && boundaries[i] <= end; i++) {
		const boundary = boundaries[i];
		const previous = Math.max(atUs, boundaries[i - 1] ?? atUs);
		const deltaUs = Math.min(1, (boundary - previous) / 2);
		const before = new Map(videoStageAt(doc, boundary - deltaUs).layers.map(layer => [layer.trackId, layer]));
		for (const layer of videoStageAt(doc, boundary).layers) {
			if (layer.media !== "video" || !layer.uri || out.has(layer.trackId)) continue;
			if (!continuousVideo(before.get(layer.trackId), layer, deltaUs)) out.set(layer.trackId, layer);
		}
	}
	return [...out.values()];
}
