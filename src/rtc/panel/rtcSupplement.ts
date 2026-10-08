import type { StoryboardShot } from "@/services/projectFile";
import type { RtcDoc, RtcTrack } from "@/types/rtc";
import { mainVideoTrackId } from "@/lib/rtcOps";
import { nextSupplementIndex, reindexShots, resolveShotMainParents } from "@/lib/shotReindex";

export type RtcSupplementPlan = { ok: true; shots: StoryboardShot[] } | { ok: false; reason: string };

/** RTC 开关的纯计划：以素材起点所在主轨镜头为父，不移动分镜数组或时间轴。 */
export function planRtcSupplement(args: {
	doc: RtcDoc; shots: StoryboardShot[]; episodeId: string; shotId: string; segId: string; enabled: boolean;
}): RtcSupplementPlan {
	const { doc, shots, episodeId, shotId, segId, enabled } = args;
	const shot = shots.find(s => s.id === shotId);
	const segment = doc.tracks.flatMap(t => t.segments).find(s => s.id === segId);
	if (!shot || !segment || segment.shotRef?.episodeId !== episodeId || segment.shotRef.shotId !== shotId) {
		return { ok: false, reason: "素材关联的分镜已变化，请重新选择。" };
	}
	if (!enabled) {
		if (!shot.isSupplement) return { ok: true, shots };
		return { ok: true, shots: reindexShots(shots.map(s => s.id === shotId ? { ...s, isSupplement: false } : s)) };
	}
	const mainId = mainVideoTrackId(doc.tracks);
	const main = doc.tracks.find(t => t.id === mainId);
	const at = segment.targetStartUs;
	const covering = main?.segments.filter(s => s.targetStartUs <= at && at < s.targetStartUs + s.targetDurationUs) ?? [];
	if (covering.length !== 1) return { ok: false, reason: covering.length ? "主轨此处有重叠镜头，无法确定补镜头归属。" : "素材起点没有对应的主轨镜头，无法设为补镜头。" };
	const ref = covering[0].shotRef;
	if (!ref || ref.episodeId !== episodeId || !shots.some(s => s.id === ref.shotId)) {
		return { ok: false, reason: "主轨对应素材尚未关联本集分镜，无法设为补镜头。" };
	}
	const parentId = resolveShotMainParents(shots).get(ref.shotId);
	if (!parentId) return { ok: false, reason: "主轨镜头的父级已失效，请先修正其补镜头归属。" };
	if (ref.shotId === shotId || parentId === shotId) return { ok: false, reason: "当前素材就是该位置的主轨镜头，不能设为自己的补镜头。" };
	if (shot.isSupplement && shot.supplementParentId === parentId) return { ok: true, shots };
	const supplementIndex = nextSupplementIndex(shots, parentId);
	return { ok: true, shots: reindexShots(shots.map(s => s.id === shotId
		? { ...s, isSupplement: true, supplementParentId: parentId, supplementIndex } : s)) };
}

/** 编号改变只同步自动片段名；用户自定义名称及其它分集引用原样保留。 */
export function renameRtcShotTitles(doc: RtcDoc, episodeId: string, before: StoryboardShot[], after: StoryboardShot[]): RtcDoc {
	const previous = new Map(before.map(s => [s.id, s.title]));
	const titles = new Map(after.filter(s => previous.get(s.id) !== s.title).map(s => [s.id, s.title]));
	if (!titles.size) return doc;
	const rename = (tracks: RtcTrack[]): RtcTrack[] => {
		let changed = false;
		const next = tracks.map(track => {
			let touched = false;
			const segments = track.segments.map(seg => {
				const ref = seg.shotRef;
				if (!ref || ref.episodeId !== episodeId) return seg;
				const title = titles.get(ref.shotId);
				if (!title || (seg.name && seg.name !== previous.get(ref.shotId))) return seg;
				touched = true;
				return { ...seg, name: title };
			});
			if (!touched) return track;
			changed = true;
			return { ...track, segments };
		});
		return changed ? next : tracks;
	};
	const tracks = rename(doc.tracks);
	let subDocs = doc.subDocs;
	for (const [id, sub] of Object.entries(doc.subDocs ?? {})) {
		const childTracks = rename(sub.tracks);
		if (childTracks !== sub.tracks) subDocs = { ...subDocs, [id]: { ...sub, tracks: childTracks } };
	}
	return tracks === doc.tracks && subDocs === doc.subDocs ? doc : { ...doc, tracks, ...(subDocs !== doc.subDocs ? { subDocs } : {}) };
}
