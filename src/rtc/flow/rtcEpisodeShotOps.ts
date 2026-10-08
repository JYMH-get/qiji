import { resolveEpisodeKey, useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { useLibraryStore } from "@/store/libraryStore";
import type { StoryboardShot } from "@/services/projectFile";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import { registerRtcGeneratedAsset } from "@/services/rtcGeneratedLibrary";
import { genId } from "@/lib/id";
import { confirmDialog } from "@/lib/confirmDialog";
import { addTrack, docDurationUs, mainVideoTrackId } from "@/lib/rtcOps";
import { resizeGeneratedVideo } from "@/lib/rtcGenerationResize";
import { reindexShots } from "@/lib/shotReindex";
import { renameRtcShotTitles } from "../panel/rtcSupplement";
import { claimShotPreparation, type ShotPreparation } from "../panel/rtcShotSubmission";
import { matchShotAssets } from "../panel/shotMatchActions";
import { episodeInferLocked } from "./rtcEpisodeInferenceActions";
import { rtcShotListRows } from "./rtcShotListCore";

export interface RtcEpisodeShotScope { owner: string; episodeId: string; shotId: string }
export type RtcEpisodeShotActionResult = { ok: true; shotId?: string; message?: string } | { ok: false; reason: string };
const failure = (reason: string): RtcEpisodeShotActionResult => ({ ok: false, reason });

/** 同镜的分割/版本只占一行；有片段的镜按时间轴顺序，无片段的镜保留原序置尾。 */
export function orderedRtcEpisodeShots(doc: RtcDoc | null, episodeId: string, shots: StoryboardShot[]): StoryboardShot[] {
	const seen = new Set<string>();
	return rtcShotListRows(doc, episodeId, shots).flatMap(row => {
		if (seen.has(row.shot.id)) return [];
		seen.add(row.shot.id);
		return [row.shot];
	});
}

function current(scope: RtcEpisodeShotScope) {
	const project = useProjectStore.getState(), rtc = useRtcStore.getState();
	const episode = project.episodes.find(ep => ep.id === scope.episodeId);
	const shot = episode?.shots.find(entry => entry.id === scope.shotId);
	if (project.isProjectLoading || project.projectInstanceId !== scope.owner
		|| resolveEpisodeKey(project.rtcEpisodeId, project.episodes) !== scope.episodeId
		|| rtc.ownerProjectId !== scope.owner || rtc.ownerEpisodeKey !== scope.episodeId || !episode || !shot) return null;
	return { project, rtc, episode, shot };
}

function busy(scope: RtcEpisodeShotScope, shotIds: string[]): boolean {
	const project = useProjectStore.getState();
	return episodeInferLocked(scope.episodeId)
		|| project.inferTasks.some(task => task.episodeId === scope.episodeId && task.status === "running" && shotIds.includes(task.shotId ?? ""))
		|| project.pendingGens.some(task => task.status === "running" && (
			task.shot?.episodeId === scope.episodeId && shotIds.includes(task.shot.shotId)
			|| task.derived?.episodeId === scope.episodeId && shotIds.includes(task.derived.shotId)));
}

/** 与生成准备使用同一把分镜锁，覆盖上传/动态加载尚未登记任务的窗口。 */
function claim(scope: RtcEpisodeShotScope, shotIds = [scope.shotId]): ShotPreparation[] | null {
	if (!current(scope) || busy(scope, shotIds)) return null;
	const claims: ShotPreparation[] = [];
	for (const shotId of shotIds) for (const field of ["infer", "storyboard", "video"] as const) {
		const item = claimShotPreparation(scope.episodeId, shotId, field);
		if (!item) { for (const prior of claims) prior.release(); return null; }
		claims.push(item);
	}
	return claims;
}
const release = (claims: ShotPreparation[]) => { for (const item of claims) item.release(); };
const belongs = (segment: RtcSegment, scope: RtcEpisodeShotScope) =>
	segment.shotRef?.episodeId === scope.episodeId && segment.shotRef.shotId === scope.shotId;

function allTracks(doc: RtcDoc): RtcTrack[] { return [...doc.tracks, ...Object.values(doc.subDocs ?? {}).flatMap(sub => sub.tracks)]; }
function lockedTarget(doc: RtcDoc, scope: RtcEpisodeShotScope): boolean {
	if (allTracks(doc).some(track => track.locked && track.segments.some(seg => belongs(seg, scope)))) return true;
	return doc.tracks.some(track => track.locked && track.segments.some(seg => seg.kind === "compound" && seg.subDocId
		&& doc.subDocs?.[seg.subDocId]?.tracks.some(child => child.segments.some(item => belongs(item, scope)))));
}

/** 使用首个可见版本的宿主边界；复合内不改变父窗口或猜测源时间。 */
function anchorPosition(doc: RtcDoc, scope: RtcEpisodeShotScope, where: "above" | "below"): number | undefined {
	const shot = { id: scope.shotId } as StoryboardShot;
	const row = rtcShotListRows(doc, scope.episodeId, [shot]).find(item => item.segmentId);
	const host = doc.tracks.flatMap(track => track.segments).find(seg => seg.id === row?.segmentId);
	return host ? host.targetStartUs + (where === "below" ? host.targetDurationUs : 0) : undefined;
}

function insertPlaceholder(doc: RtcDoc, scope: RtcEpisodeShotScope, where: "above" | "below", seg: RtcSegment, fallbackUs: number): { doc: RtcDoc; reason?: string } {
	if (lockedTarget(doc, scope)) return { doc, reason: "该分镜所在轨道已锁定。" };
	const cutUs = anchorPosition(doc, scope, where) ?? fallbackUs;
	const base = mainVideoTrackId(doc.tracks) ? doc : addTrack(doc, "video", "视频1");
	const trackId = mainVideoTrackId(base.tracks)!;
	if (base.tracks.find(track => track.id === trackId)?.locked) return { doc, reason: "主视频轨道已锁定。" };
	// 临时零长占位只是纯计算输入；复用已验证的跨轨/组合/标记增长规则，成功才落正式文档。
	const seeded = { ...base, tracks: base.tracks.map(track => track.id !== trackId ? track : {
		...track, segments: [...track.segments, { ...seg, targetStartUs: cutUs, targetDurationUs: 0 }]
			.sort((a, b) => a.targetStartUs - b.targetStartUs),
	}) };
	const result = resizeGeneratedVideo(seeded, seg.id, seg.targetDurationUs);
	return result.reason ? { doc, reason: result.reason } : result;
}

function removeShotSegments(doc: RtcDoc, scope: RtcEpisodeShotScope): { doc: RtcDoc; reason?: string } {
	if (lockedTarget(doc, scope)) return { doc, reason: "该分镜所在轨道已锁定。" };
	const filter = (tracks: RtcTrack[]) => tracks.map(track => {
		const segments = track.segments.filter(seg => !belongs(seg, scope));
		return segments.length === track.segments.length ? track : { ...track, segments };
	});
	return { doc: { ...doc, tracks: filter(doc.tracks), ...(doc.subDocs ? {
		subDocs: Object.fromEntries(Object.entries(doc.subDocs).map(([id, sub]) => [id, { ...sub, tracks: filter(sub.tracks) }])),
	} : {}) } };
}

/** 分镜结构是项目元数据；同步历史映射，避免剪辑撤销恢复断连片段或旧编号。 */
function applyStructure(scope: RtcEpisodeShotScope, shots: StoryboardShot[], transform: (doc: RtcDoc) => { doc: RtcDoc; reason?: string }, beforeSave?: () => void): RtcEpisodeShotActionResult {
	const state = current(scope);
	if (!state?.rtc.doc || state.rtc.editingSubDocId) return failure("请先返回本集主时间轴。" );
	const { rtc, episode, project } = state;
	const mapped = [rtc.doc!, ...rtc.past, ...rtc.future].map(doc => {
		const result = transform(doc);
		return result.reason ? result : { doc: renameRtcShotTitles(result.doc, scope.episodeId, episode.shots, shots) };
	});
	const blocked = mapped.find(result => result.reason);
	if (blocked?.reason) return failure(blocked.reason);
	beforeSave?.();
	project.setEpisodeShots(scope.episodeId, shots);
	useRtcStore.getState().patchSilent(() => mapped[0].doc);
	useRtcStore.setState({ past: mapped.slice(1, 1 + rtc.past.length).map(result => result.doc), future: mapped.slice(1 + rtc.past.length).map(result => result.doc) });
	void useProjectStore.getState().save(true);
	return { ok: true };
}

export function moveRtcEpisodeShotLine(scope: RtcEpisodeShotScope, direction: "up" | "down"): RtcEpisodeShotActionResult {
	const state = current(scope);
	if (!state) return failure("项目、分集或分镜已变化，请重新打开。" );
	const shots = orderedRtcEpisodeShots(state.rtc.doc, scope.episodeId, state.episode.shots);
	const index = shots.findIndex(shot => shot.id === scope.shotId), adjacent = shots[index + (direction === "up" ? -1 : 1)];
	if (!adjacent) return failure(direction === "up" ? "已是第一镜，无法上拆。" : "已是最后一镜，无法下拆。" );
	const claims = claim(scope, [scope.shotId, adjacent.id]);
	if (!claims) return failure("相关分镜正在推理或生成，请完成后重试。" );
	try {
		const lines = (state.shot.scriptSegment ?? "").split(/\r?\n/).filter(line => line.trim());
		if (!lines.length) return failure("本分镜没有可移动的原文。" );
		const moved = direction === "up" ? lines.shift()! : lines.pop()!;
		const adjacentText = direction === "up"
			? `${(adjacent.scriptSegment ?? "").replace(/\s+$/, "")}\n${moved}`.replace(/^\n+/, "")
			: `${moved}\n${(adjacent.scriptSegment ?? "").replace(/^\s+/, "")}`.replace(/\n+$/, "");
		state.project.setEpisodeShots(scope.episodeId, state.episode.shots.map(shot => shot.id === scope.shotId ? { ...shot, scriptSegment: lines.join("\n") }
			: shot.id === adjacent.id ? { ...shot, scriptSegment: adjacentText } : shot));
		return { ok: true };
	} finally { release(claims); }
}

export function insertRtcEpisodeShot(scope: RtcEpisodeShotScope, where: "above" | "below", defaultDuration = 15): RtcEpisodeShotActionResult {
	const state = current(scope);
	if (!state?.rtc.doc) return failure("项目、分集或时间轴已变化，请重新打开。" );
	const claims = claim(scope);
	if (!claims) return failure("该分镜正在推理或生成，请完成后重试。" );
	try {
		const duration = Number.isFinite(defaultDuration) && defaultDuration > 0 ? defaultDuration : 15;
		const id = genId("shot"), segId = genId("seg");
		const blank: StoryboardShot = { id, index: 0, title: "", scriptSegment: "", prompt: "", materials: [], durationSec: duration };
		const shots = orderedRtcEpisodeShots(state.rtc.doc, scope.episodeId, state.episode.shots);
		shots.splice(shots.findIndex(shot => shot.id === scope.shotId) + (where === "below" ? 1 : 0), 0, blank);
		const indexed = reindexShots(shots), added = indexed.find(shot => shot.id === id)!;
		const seg: RtcSegment = { id: segId, kind: "placeholder", media: "video", name: added.title, targetStartUs: 0,
			targetDurationUs: Math.max(1000, Math.round(duration * 1_000_000)), status: "pending", shotRef: { episodeId: scope.episodeId, shotId: id } };
		const fallback = anchorPosition(state.rtc.doc, scope, where) ?? docDurationUs(state.rtc.doc);
		const result = applyStructure(scope, indexed, doc => insertPlaceholder(doc, scope, where, seg, fallback));
		return result.ok ? { ok: true, shotId: id } : result;
	} finally { release(claims); }
}

/** 旧项目只存在于分镜历史里的成品也收进素材区；已有软删除条目不复活。 */
function retainMedia(scope: RtcEpisodeShotScope, shot: StoryboardShot, doc: RtcDoc): void {
	const media = new Map<string, { kind: "image" | "video" | "audio"; uri: string; assetId?: string }>();
	const add = (kind: "image" | "video" | "audio", uri?: string, assetId?: string) => { if (uri) media.set(`${kind}:${uri}`, { kind, uri, assetId }); };
	for (const uri of [shot.videoUri, ...(shot.videoUris ?? []), ...(shot.videoDerived ?? []).map(item => item.uri)]) add("video", uri);
	for (const uri of [shot.storyboardUri, ...(shot.storyboardImages ?? []), ...(shot.sbDerived ?? []).map(item => item.uri)]) add("image", uri);
	for (const track of allTracks(doc)) for (const seg of track.segments) if (belongs(seg, scope) && seg.kind === "media") add(seg.media ?? "video", seg.uri, seg.assetId);
	for (const [key, item] of media) {
		if (Object.values(useLibraryStore.getState().assets).some(asset => asset.uri === item.uri && asset.kind === item.kind)) continue;
		registerRtcGeneratedAsset({ owner: scope.owner, episodeId: scope.episodeId, taskKey: `deleted-shot:${scope.shotId}:${key}`,
			media: item.kind, uri: item.uri, assetId: item.assetId, name: shot.title || "分镜成品" });
	}
}

export async function deleteRtcEpisodeShot(scope: RtcEpisodeShotScope): Promise<RtcEpisodeShotActionResult> {
	const original = current(scope);
	if (!original) return failure("项目、分集或分镜已变化，请重新打开。" );
	const claims = claim(scope);
	if (!claims) return failure("该分镜正在推理或生成，请完成后重试。" );
	try {
		if (!await confirmDialog(`删除${original.shot.title || "本分镜"}及其时间轴片段？已有成品保留在素材区。`)) return { ok: true };
		const state = current(scope);
		if (!state?.rtc.doc || claims.some(item => !item.alive())) return failure("项目、分集或分镜已变化，未删除。" );
		if (busy(scope, [scope.shotId])) return failure("该分镜正在推理或生成，未删除。" );
		const shots = reindexShots(orderedRtcEpisodeShots(state.rtc.doc, scope.episodeId, state.episode.shots).filter(shot => shot.id !== scope.shotId));
		return applyStructure(scope, shots, doc => removeShotSegments(doc, scope), () => retainMedia(scope, state.shot, state.rtc.doc!));
	} finally { release(claims); }
}

export function updateRtcEpisodeShot(scope: RtcEpisodeShotScope, patch: Pick<Partial<StoryboardShot>, "plotGuidance" | "durationSec" | "overrides">): RtcEpisodeShotActionResult {
	const state = current(scope);
	if (!state) return failure("项目、分集或分镜已变化，请重新打开。" );
	const claims = claim(scope);
	if (!claims) return failure("该分镜正在推理或生成，请完成后重试。" );
	try { state.project.updateShot(scope.episodeId, scope.shotId, patch); return { ok: true }; }
	finally { release(claims); }
}

export function matchRtcEpisodeShotAssets(scope: RtcEpisodeShotScope): RtcEpisodeShotActionResult {
	if (!current(scope)) return failure("项目、分集或分镜已变化，请重新打开。" );
	const claims = claim(scope);
	if (!claims) return failure("该分镜正在推理或生成，请完成后重试。" );
	try {
		const result = matchShotAssets(scope.episodeId, scope.shotId);
		return result ? { ok: true, message: `已匹配，新增 ${result.added} 个素材` } : failure("未在原文或提示词中匹配到项目资产。" );
	} finally { release(claims); }
}

export async function inferRtcEpisodeShot(scope: RtcEpisodeShotScope): Promise<RtcEpisodeShotActionResult> {
	if (!current(scope)) return failure("项目、分集或分镜已变化，请重新打开。" );
	if (busy(scope, [scope.shotId])) return failure("该分镜正在推理或生成，请完成后重试。" );
	const { inferShotPrompts } = await import("../panel/shotGenActions");
	if (!current(scope) || busy(scope, [scope.shotId])) return failure("项目、分集或任务状态已变化，请重新操作。" );
	await inferShotPrompts(scope.episodeId, scope.shotId);
	return { ok: true };
}
