import type { RtcDoc, RtcSegment } from "@/types/rtc";
import { MIN_SEGMENT_US } from "./rtcOps";

export interface RtcTimelineTimingResult {
	doc: RtcDoc;
	/** 调时被阻止的原因；生成调用方仍应保存媒体结果并提示用户。 */
	reason?: string;
}

/**
 * 新生成视频落位时调整当前编辑层的时长（调用方负责精确的分集/子文档地址）。
 * 缩短留空隙；增长以占位旧右缘为插入点，后续各轨片段和标记右移同一增量。
 * 原文由主轨派生、关键帧相对段起点，不另造或重写联动数据；跨插入点的长音轨不拉伸。
 * groupId 是移动单元，补齐其跨轨成员；锁轨、牵动目标本身或新增重叠时整次调时放弃，
 * 由调用方继续收媒体结果，避免部分挤移破坏现有编排。复合片段父窗口保持既有裁剪语义。
 */
export function resizeGeneratedVideo(doc: RtcDoc, segId: string, durationUs: number): RtcTimelineTimingResult {
	if (!Number.isFinite(durationUs) || durationUs <= 0) return { doc };
	const host = doc.tracks.find(t => t.segments.some(s => s.id === segId));
	const target = host?.segments.find(s => s.id === segId);
	if (!host || !target || target.kind !== "placeholder") return { doc };
	const duration = Math.max(MIN_SEGMENT_US, Math.round(durationUs));
	const delta = duration - target.targetDurationUs;
	if (!delta) return { doc };
	if (host.locked) return blocked(doc, "目标轨道已锁定，未调整片段时长。");
	const oldEnd = target.targetStartUs + target.targetDurationUs;
	return retime(doc, oldEnd, Math.max(0, delta), { id: segId, duration });
}

/** 闭合指定轨道两片段间仍然存在的空隙；跨轨后续内容按同一增量移动。 */
export function closeTimelineGap(doc: RtcDoc, trackId: string, gapStartUs: number, gapEndUs: number): RtcTimelineTimingResult {
	const track = doc.tracks.find(t => t.id === trackId);
	if (!track || !Number.isFinite(gapStartUs) || !Number.isFinite(gapEndUs) || gapStartUs < 0 || gapEndUs <= gapStartUs) {
		return blocked(doc, "该空隙已变化，请重新选择。");
	}
	const gap = timelineGapAt(doc, trackId, gapStartUs);
	if (!gap || gap.startUs !== gapStartUs || gap.endUs !== gapEndUs) return blocked(doc, "该空隙已变化，请重新选择。");
	if (track.locked) return blocked(doc, "目标轨道已锁定，无法闭合空隙。");
	return retime(doc, gapEndUs, gapStartUs - gapEndUs);
}

/** 只认片段之间的空隙；合并重叠/相邻片段后判断，不把首尾空白当成可闭合间隙。 */
export function timelineGapAt(doc: RtcDoc, trackId: string, atUs: number): { startUs: number; endUs: number } | null {
	if (!Number.isFinite(atUs)) return null;
	const track = doc.tracks.find(t => t.id === trackId);
	if (!track) return null;
	const sorted = [...track.segments].sort((a, b) => a.targetStartUs - b.targetStartUs);
	let previousEnd: number | undefined;
	for (const seg of sorted) {
		if (previousEnd !== undefined && seg.targetStartUs > previousEnd && atUs >= previousEnd && atUs < seg.targetStartUs) {
			return { startUs: previousEnd, endUs: seg.targetStartUs };
		}
		previousEnd = Math.max(previousEnd ?? 0, end(seg));
	}
	return null;
}

function retime(doc: RtcDoc, cutUs: number, delta: number, resized?: { id: string; duration: number }): RtcTimelineTimingResult {
	const moved = new Set<string>();
	if (delta) {
		const groups = new Set<string>();
		for (const track of doc.tracks) for (const seg of track.segments) {
			if (seg.id === resized?.id || seg.targetStartUs < cutUs) continue;
			moved.add(seg.id);
			if (seg.groupId) groups.add(seg.groupId);
		}
		for (const track of doc.tracks) for (const seg of track.segments) {
			if (seg.groupId && groups.has(seg.groupId)) moved.add(seg.id);
		}
		if (resized && moved.has(resized.id)) return blocked(doc, "组合关联到当前生成片段，未调整时间轴位置。");
		if (doc.tracks.some(t => t.locked && t.segments.some(s => moved.has(s.id)))) return blocked(doc, "需要联动的轨道已锁定，未调整时间轴位置。");
	}
	const tracks = doc.tracks.map(track => {
		let changed = false;
		const segments = track.segments.map(seg => {
			if (seg.id === resized?.id) { changed = true; return { ...seg, targetDurationUs: resized.duration }; }
			if (!moved.has(seg.id)) return seg;
			changed = true;
			return { ...seg, targetStartUs: seg.targetStartUs + delta };
		});
		return changed ? { ...track, segments: segments.sort((a, b) => a.targetStartUs - b.targetStartUs) } : track;
	});
	// 组成员可能早于插入点。只拒绝本次变更新造成的重叠，不放大历史脏数据的影响。
	if (delta) {
		for (let i = 0; i < tracks.length; i++) {
			if (tracks[i] === doc.tracks[i]) continue;
			const old = new Map(doc.tracks[i].segments.map(s => [s.id, s]));
			const next = tracks[i].segments;
			if (next.some(s => s.targetStartUs < 0)) return blocked(doc, "组合联动会将片段移到时间轴起点之前。");
			for (let a = 0; a < next.length; a++) for (let b = a + 1; b < next.length; b++) {
				if (next[b].targetStartUs >= end(next[a])) break;
				if (overlap(next[a], next[b]) > overlap(old.get(next[a].id)!, old.get(next[b].id)!)) return blocked(doc, "联动后会覆盖其他片段，未调整时间轴位置。");
			}
		}
	}
	const markerCut = delta < 0 ? cutUs + delta : cutUs;
	const markers = delta && doc.markers?.some(m => m.timeUs >= markerCut)
		? doc.markers.map(m => m.timeUs < markerCut ? m : { ...m, timeUs: m.timeUs >= cutUs ? m.timeUs + delta : markerCut })
		: doc.markers;
	return { doc: { ...doc, tracks, ...(markers !== doc.markers ? { markers } : {}) } };
}

function blocked(doc: RtcDoc, reason: string): RtcTimelineTimingResult { return { doc, reason }; }

function end(seg: RtcSegment): number { return seg.targetStartUs + seg.targetDurationUs; }
function overlap(a: RtcSegment, b: RtcSegment): number {
	return Math.max(0, Math.min(end(a), end(b)) - Math.max(a.targetStartUs, b.targetStartUs));
}
