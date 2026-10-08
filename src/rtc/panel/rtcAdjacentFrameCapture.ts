import { captureFromUri } from "@/canvas/videoCapture";
import { newLocalAssetId } from "@/canvas/nodeUpload";
import { saveUploadedLocal } from "@/services/assetPersist";
import { useProjectStore } from "@/store/projectStore";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { resolveAdjacentFrame, type RtcAdjacentFrame, type RtcFrameEdge } from "./rtcAdjacentFrames";

export interface RtcInsertedFrame {
	uri: string;
	assetId?: string;
	name: string;
	sourceSegId: string;
	sourceSec: number;
}

/** 只等有效解码帧；超时不把上一帧/黑画面当成成功。 */
export async function captureBrowserVideoFrame(uri: string, timeSec: number, current: () => boolean): Promise<Blob | null> {
	if (typeof document === "undefined" || !current()) return null;
	const video = document.createElement("video");
	video.preload = "auto"; video.muted = true; video.crossOrigin = "anonymous";
	const waitFor = (check: () => boolean, start?: () => void): Promise<void> => new Promise((resolve, reject) => {
		const events = ["loadedmetadata", "loadeddata", "seeked", "canplay", "error"];
		const finish = (error?: Error) => { clearTimeout(timer); for (const name of events) video.removeEventListener(name, update); error ? reject(error) : resolve(); };
		const update = () => {
			if (!current()) finish(new Error("取帧目标已变化"));
			else if (video.error) finish(new Error("无法读取相邻视频"));
			else if (check()) finish();
		};
		const timer = setTimeout(() => finish(new Error("读取相邻视频帧超时")), 12_000);
		for (const name of events) video.addEventListener(name, update);
		try { start?.(); update(); } catch (error) { finish(error instanceof Error ? error : new Error("读取视频失败")); }
	});
	try {
		await waitFor(() => video.readyState >= 1, () => { video.src = uri; });
		if (!current()) return null;
		const end = Number.isFinite(video.duration) && video.duration > 0 ? Math.max(0, video.duration - 0.001) : timeSec;
		const at = Math.max(0, Math.min(timeSec, end));
		await waitFor(() => video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - at) < 0.002,
			() => { video.currentTime = at; });
		if (!current() || !video.videoWidth || !video.videoHeight) return null;
		const canvas = document.createElement("canvas");
		canvas.width = video.videoWidth; canvas.height = video.videoHeight;
		const context = canvas.getContext("2d");
		if (!context) return null;
		context.drawImage(video, 0, 0);
		return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
	} finally {
		video.removeAttribute("src");
		video.load();
	}
}

function sameFrame(a: RtcAdjacentFrame | null, b: RtcAdjacentFrame): boolean {
	return !!a && a.sourceSegId === b.sourceSegId && a.trackId === b.trackId && a.uri === b.uri
		&& a.media === b.media && a.sourceSec === b.sourceSec && a.timeUs === b.timeUs;
}

/** 产出持久引用后同步回调写垫图；所有等待期间都守住原项目、编辑层、目标与相邻帧。 */
export async function insertAdjacentFrame(args: {
	segId: string;
	edge: RtcFrameEdge;
	shouldContinue?: () => boolean;
	onInsert: (frame: RtcInsertedFrame, edge: RtcFrameEdge) => void;
}): Promise<boolean> {
	const owner = useProjectStore.getState().projectInstanceId;
	const rtc = useRtcStore.getState(), doc = activeRtcDoc(rtc);
	if (!doc) throw new Error("当前时间轴尚未载入");
	const frame = resolveAdjacentFrame(doc, args.segId, args.edge);
	if (!frame) throw new Error(args.edge === "first" ? "前方没有可取帧的图片或视频" : "后方没有可取帧的图片或视频");
	const target = doc.tracks.flatMap(track => track.segments).find(seg => seg.id === args.segId)!;
	const episodeKey = rtc.ownerEpisodeKey, editingSubDocId = rtc.editingSubDocId, docId = doc.id;
	const targetStartUs = target.targetStartUs, targetDurationUs = target.targetDurationUs;
	const current = () => {
		const project = useProjectStore.getState(), now = useRtcStore.getState(), active = activeRtcDoc(now);
		const liveTarget = active?.tracks.flatMap(track => track.segments).find(seg => seg.id === args.segId);
		return project.projectInstanceId === owner && !project.isProjectLoading && now.ownerProjectId === owner
			&& now.ownerEpisodeKey === episodeKey && now.editingSubDocId === editingSubDocId && active?.id === docId
			&& liveTarget?.targetStartUs === targetStartUs && liveTarget?.targetDurationUs === targetDurationUs
			&& args.shouldContinue?.() !== false && !!active && sameFrame(resolveAdjacentFrame(active, args.segId, args.edge), frame);
	};
	if (!current()) return false;
	const name = `${args.edge === "first" ? "首帧" : "尾帧"}-${frame.name}`;
	if (frame.media === "image" && !/^(data|blob):/i.test(frame.uri)) {
		args.onInsert({ uri: frame.uri, assetId: frame.assetId ?? useProjectStore.getState().blobByUri(frame.uri)?.id,
			name, sourceSegId: frame.sourceSegId, sourceSec: 0 }, args.edge);
		return true;
	}
	let blob: Blob | null = null;
	if (frame.media === "image") {
		const response = await fetch(frame.uri);
		if (!current()) return false;
		if (response.ok) blob = await response.blob();
	} else {
		try { blob = (await captureFromUri(frame.uri, "frame", { timeSec: frame.sourceSec }))?.blob ?? null; }
		catch { /* 原生取帧失败时尝试浏览器解码；结果仍需实际落盘。 */ }
		if (!current()) return false;
		if (!blob) blob = await captureBrowserVideoFrame(frame.uri, frame.sourceSec, current);
	}
	if (!current()) return false;
	if (!blob?.size) throw new Error("无法截取相邻素材帧，请确认源文件可以播放");
	const file = new File([blob], `${name}.png`, { type: blob.type || "image/png" });
	const saved = await saveUploadedLocal(file, newLocalAssetId(), undefined, file.name, { shouldContinue: current });
	if (!current()) return false;
	if (!saved?.localUri || !saved.localPath || /^(data|blob):/i.test(saved.localUri)) throw new Error("取帧图片未能保存到本地，请在桌面客户端重试");
	args.onInsert({ uri: saved.localUri, assetId: saved.id, name, sourceSegId: frame.sourceSegId, sourceSec: frame.sourceSec }, args.edge);
	return true;
}
