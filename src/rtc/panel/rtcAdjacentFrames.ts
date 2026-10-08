import type { RtcDoc } from "@/types/rtc";
import { effectiveTransformAt } from "@/lib/rtcKeyframes";
import { videoStageAt } from "../rtcPlayback";
import { videoBoundaryTimes } from "../rtcVideoLookahead";

/** 首帧垫图取前邻尾帧；尾帧垫图取后邻首帧。 */
export type RtcFrameEdge = "first" | "last";
export interface RtcAdjacentFrame {
	edge: RtcFrameEdge;
	sourceSegId: string;
	trackId: string;
	media: "image" | "video";
	uri: string;
	assetId?: string;
	name: string;
	timeUs: number;
	sourceSec: number;
}

/**
 * 在当前编辑层寻找相邻可见素材。边界/叠层/复合时间映射与播放器共用；
 * 取素材本身的帧，转场幽灵与字幕不是参考图来源。空隙和未生成占位可跨过。
 */
export function resolveAdjacentFrame(doc: RtcDoc, targetSegId: string, edge: RtcFrameEdge): RtcAdjacentFrame | null {
	const segments = doc.tracks.flatMap(track => track.segments);
	const target = segments.find(seg => seg.id === targetSegId);
	if (!target || !(target.targetDurationUs > 0)) return null;
	// 同一镜头的重生成版本即使被裁成不同长度，也不是它的前/后镜头。
	const family = new Set([targetSegId]);
	let expanded = true;
	while (expanded) {
		expanded = false;
		for (const seg of segments) if (seg.originSegId && (family.has(seg.id) || family.has(seg.originSegId))) {
			for (const id of [seg.id, seg.originSegId]) if (!family.has(id)) { family.add(id); expanded = true; }
		}
	}
	const anchor = edge === "first" ? target.targetStartUs : target.targetStartUs + target.targetDurationUs;
	const frameUs = 1_000_000 / (Number.isFinite(doc.fps) && doc.fps > 0 ? doc.fps : 30);
	const boundaries = [...new Set([0, anchor, ...videoBoundaryTimes(doc)])].sort((a, b) => a - b);
	const intervals = boundaries.slice(1).map((end, i) => ({ start: boundaries[i], end }))
		.filter(range => range.end > range.start && (edge === "first" ? range.end <= anchor : range.start >= anchor));
	if (edge === "first") intervals.reverse();
	for (const interval of intervals) {
		const timeUs = edge === "first" ? Math.max(interval.start, interval.end - frameUs) : interval.start;
		const layer = videoStageAt(doc, timeUs).layers.slice().reverse().find(candidate =>
			!candidate.ghost && candidate.uri && !family.has(candidate.seg.id)
			&& ![...family].some(id => candidate.trackId.startsWith(id + "/"))
			&& effectiveTransformAt(candidate.seg, candidate.kfRelUs).opacity > 0);
		if (!layer) continue;
		let sourceSec = layer.sourceSec;
		// 存量源窗口比目标短时播放器会定住尾帧；不能 seek 到源窗口的开区间右缘。
		if (layer.media === "video" && layer.seg.sourceDurationUs != null) {
			const start = (layer.seg.sourceStartUs ?? 0) / 1_000_000;
			const end = start + layer.seg.sourceDurationUs / 1_000_000;
			const step = Math.min(layer.seg.sourceDurationUs / 1_000_000, frameUs * layer.rate / 1_000_000);
			sourceSec = Math.min(sourceSec, Math.max(start, end - step));
		}
		return { edge, sourceSegId: layer.seg.id, trackId: layer.trackId, media: layer.media,
			uri: layer.uri, assetId: layer.seg.assetId, name: layer.seg.name || "片段", timeUs, sourceSec: Math.max(0, sourceSec) };
	}
	return null;
}
