/** 时间轴异步拖入：整次手势绑定原项目、分集和编辑层，目标改变即取消剩余工作。 */
import { useProjectStore, resolveEpisodeKey } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { useLibraryStore } from "@/store/libraryStore";
import { uploadKindFromFile, uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { createRtcTrack, type RtcSegment } from "@/types/rtc";
import { genId } from "@/lib/id";
import { addSegment, MIN_SEGMENT_US, replaceSegmentMedia, snapCandidates, snapSegmentStart, trackTypeForMedia } from "@/lib/rtcOps";
import { imageDefaultUs, MEDIA_FALLBACK_US, probeMediaDurationSec, SNAP_PX, type DroppedAsset } from "./timelineUtil";

const US_PER_SEC = 1_000_000;

export function captureRtcDropTarget() {
	const ps = useProjectStore.getState(), rtc = useRtcStore.getState();
	const owner = ps.projectInstanceId;
	const episodeId = resolveEpisodeKey(ps.rtcEpisodeId, ps.episodes);
	const docId = rtc.doc?.id;
	const subDocId = rtc.editingSubDocId;
	return {
		episodeId,
		isCurrent: () => {
			const current = useProjectStore.getState(), editor = useRtcStore.getState();
			return current.projectInstanceId === owner && !current.isProjectLoading
				&& current.episodes.some((e) => e.id === episodeId)
				&& resolveEpisodeKey(current.rtcEpisodeId, current.episodes) === episodeId
				&& editor.ownerProjectId === owner && editor.ownerEpisodeKey === episodeId
				&& !!docId && editor.doc?.id === docId && editor.editingSubDocId === subDocId
				&& (!subDocId || !!editor.doc?.subDocs?.[subDocId]);
		},
	};
}

/** 素材拖到已有片段：保留原位替换语义，时长探测期间切项目/分集/编辑层则取消。 */
export async function replaceSegmentWithAsset(segId: string, asset: DroppedAsset): Promise<void> {
	const target = captureRtcDropTarget();
	if (!target.isCurrent()) return;
	let sourceTotalUs = 0;
	if (asset.media !== "image" && asset.probeUri) {
		const sec = await probeMediaDurationSec(asset.probeUri, asset.media);
		if (sec > 0) sourceTotalUs = Math.round(sec * US_PER_SEC);
	}
	if (!target.isCurrent()) return;
	useRtcStore.getState().commitActive((d) => replaceSegmentMedia(d, segId, {
		media: asset.media,
		...(asset.assetId ? { assetId: asset.assetId } : {}),
		...(asset.displayUri ? { uri: asset.displayUri } : {}),
		...(asset.name ? { name: asset.name } : {}),
		sourceTotalUs,
	}));
	if (target.isCurrent()) useRtcStore.getState().setSelection([segId]);
}

/** 视频/音频先探测源时长，再按原落点与轨道规则提交一次。图片时长仍走剪辑设置。 */
export async function placeDroppedAsset(
	asset: DroppedAsset, dropUs: number, preferTrackId?: string,
	target = captureRtcDropTarget(),
): Promise<boolean> {
	if (!target.isCurrent()) return false;
	let durUs = imageDefaultUs();
	let source: { sourceStartUs: number; sourceDurationUs: number } | null = null;
	if (asset.media !== "image") {
		const sec = asset.probeUri ? await probeMediaDurationSec(asset.probeUri, asset.media) : 0;
		if (sec > 0) {
			durUs = Math.max(MIN_SEGMENT_US, Math.round(sec * US_PER_SEC));
			source = { sourceStartUs: 0, sourceDurationUs: durUs };
		} else durUs = MEDIA_FALLBACK_US;
	}
	if (!target.isCurrent()) return false;
	const st = useRtcStore.getState(), wanted = trackTypeForMedia(asset.media), segId = genId("seg");
	st.commitActive((d) => {
		let next = d;
		let track = preferTrackId ? next.tracks.find((t) => t.id === preferTrackId) : undefined;
		if (!track || track.type !== wanted || track.locked) track = next.tracks.find((t) => t.type === wanted && !t.locked);
		let trackId = track?.id;
		if (!trackId) {
			const created = createRtcTrack(wanted);
			next = { ...next, tracks: [...next.tracks, created] };
			trackId = created.id;
		}
		const startUs = st.snapOn
			? Math.max(0, snapSegmentStart(snapCandidates(next), dropUs, durUs, (SNAP_PX / st.pxPerSec) * US_PER_SEC))
			: dropUs;
		const seg: RtcSegment = {
			id: segId, kind: "media", media: asset.media,
			...(asset.name ? { name: asset.name } : {}),
			...(asset.assetId ? { assetId: asset.assetId } : {}),
			...(asset.displayUri ? { uri: asset.displayUri } : {}),
			targetStartUs: startUs, targetDurationUs: durUs, ...(source ?? {}),
		};
		return addSegment(next, trackId, seg);
	});
	if (target.isCurrent()) useRtcStore.getState().setSelection([segId]);
	return true;
}

/** 多文件共享一个归属；正常单文件错误继续，其间切换目标则停止整批。 */
export async function importDroppedFiles(files: File[], dropUs: number, preferTrackId?: string): Promise<void> {
	const target = captureRtcDropTarget();
	for (const file of files) {
		if (!target.isCurrent()) break;
		const kind = uploadKindFromFile(file);
		if (kind === "script") continue;
		const name = file.name.replace(/\.[^.]+$/, "");
		try {
			const up = await uploadMediaToCanvasAsset(file, "TP", { shouldContinue: target.isCurrent });
			if (!target.isCurrent()) break;
			useLibraryStore.getState().addAsset({
				id: up.assetId, kind, name, uri: up.displayUri,
				serverAssetId: up.assetId, thumbnailUri: kind === "image" ? up.displayUri : null,
				createdAt: new Date().toISOString(), deletedByUser: false, localPath: up.localPath,
				origin: "upload", episodeId: target.episodeId || null,
			});
			const displayUri = /^(data|blob):/i.test(up.displayUri) ? undefined : up.displayUri;
			if (!await placeDroppedAsset({ media: kind, name, assetId: up.assetId, displayUri, probeUri: up.displayUri }, dropUs, preferTrackId, target)) break;
		} catch (error) {
			if (!target.isCurrent()) break;
			console.warn("[rtc] 外部文件入轨失败", file.name, error);
		}
	}
}
