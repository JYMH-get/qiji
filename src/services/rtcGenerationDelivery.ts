import { useProjectStore } from "@/store/projectStore";
import type { PendingGen, RtcGenerationTarget } from "./projectFile";
import type { GenerationOwner } from "./generationReceipts";
import { isProjectWriter } from "./windowSync";
import { rememberRtcGenerationResult } from "./rtcGenerationReceipts";
import { registerRtcGeneratedAsset } from "./rtcGeneratedLibrary";

/** 媒体已保留；时间轴遇锁定或联动冲突时说明未自动调整的原因。 */
export function notifyRtcResizeWarning(reason: string): void {
  if (typeof window !== "undefined") window.alert(`视频已保存到素材区。${reason}`);
}

/** 旧项目仅凭精确 taskRef 认领，歧义与没有凭据时不猜分镜最新历史。 */
export function pendingRtcTarget(pending: PendingGen): RtcGenerationTarget | undefined {
  if (pending.rtcTarget) return pending.rtcTarget;
  const hits: RtcGenerationTarget[] = [];
  for (const [episodeId, doc] of Object.entries(useProjectStore.getState().rtcDocs ?? {})) {
    for (const track of doc.tracks) for (const seg of track.segments) {
      if (seg.taskRef === pending.id) hits.push({ episodeId, segId: seg.id });
    }
    for (const [subDocId, sub] of Object.entries(doc.subDocs ?? {})) {
      for (const track of sub.tracks) for (const seg of track.segments) {
        if (seg.taskRef === pending.id) hits.push({ episodeId, segId: seg.id, subDocId });
      }
    }
  }
  return hits.length === 1 ? hits[0] : undefined;
}

/** 在用户尚未打开 RTC 页面时，也先把目标和本次 taskRef 一起保存。 */
export async function rtcPendingReady(pending: PendingGen, owner: GenerationOwner, bind = false): Promise<boolean> {
  if (!pending.rtcTarget) return true;
  const sink = await import("@/rtc/panel/rtcGenSink");
  if (!sink.ownerAlive(owner.projectInstanceId)) return false;
  const seg = sink.liveSegment(pending.rtcTarget.segId, pending.rtcTarget);
  if (!seg || seg.kind !== "placeholder" || (seg.taskRef && seg.taskRef !== pending.id)) return false;
  const shotTarget = pending.shot ?? pending.derived;
  if (shotTarget) {
    const shot = useProjectStore.getState().episodes.find(ep => ep.id === shotTarget.episodeId)?.shots.find(sh => sh.id === shotTarget.shotId);
    if (!shot || (seg.shotRef && (seg.shotRef.episodeId !== shotTarget.episodeId || seg.shotRef.shotId !== shotTarget.shotId))) return false;
    if (pending.derived && !(pending.derived.field === "storyboard" ? shot.sbDerived : shot.videoDerived)?.some(rec => rec.id === pending.derived!.recId)) return false;
  }
  if (bind) sink.armRunning(pending.rtcTarget.segId, pending.id, owner.projectInstanceId, { target: pending.rtcTarget });
  return sink.liveSegment(pending.rtcTarget.segId, pending.rtcTarget)?.taskRef === pending.id;
}

/** 先保存任务自己的素材库结果，再按需落轨；删除片段不取消已受理产物。 */
export async function deliverRtcPending(owner: GenerationOwner, pending: PendingGen, current: () => boolean): Promise<boolean> {
  const target = pending.rtcTarget, result = pending.rtcResult;
  if (!result || !current()) return false;
  const episodeId = target?.episodeId ?? pending.shot?.episodeId ?? pending.derived?.episodeId;
  if (!episodeId || !registerRtcGeneratedAsset({ owner: owner.projectInstanceId, episodeId,
    taskKey: `pending:${JSON.stringify([pending.id, pending.createdAt, result.taskId ?? pending.taskId ?? ""])}`,
    media: result.media, uri: result.displayUri || result.uri, assetId: result.assetId,
    name: pending.label, createdAt: pending.createdAt })) return false;
  if (target) {
    const sink = await import("@/rtc/panel/rtcGenSink");
    if (!current()) return false;
    let seg = sink.liveSegment(target.segId, target);
    // 删除/手动替换/新任务取代时不重建原片段；保存当前用户选择后才销旧任务。
    if (seg?.kind === "placeholder" && seg.taskRef === pending.id) {
      let sourceWindow = result.sourceWindow;
      if (!sourceWindow && pending.derived && seg.originSegId) {
        const src = sink.liveSegment(seg.originSegId, { ...target, segId: seg.originSegId });
        if (src?.sourceStartUs != null && src.sourceDurationUs != null) sourceWindow = { sourceStartUs: src.sourceStartUs, sourceDurationUs: src.sourceDurationUs };
      }
      const uri = result.displayUri || result.uri;
      const durationSec = sourceWindow ? undefined : result.durationSec ?? await sink.probeDurationSec(uri, result.media);
      if (!current()) return false;
      seg = sink.liveSegment(target.segId, target);
      const resolved = { ...result, ...(sourceWindow ? { sourceWindow } : { durationSec }) };
      rememberRtcGenerationResult(owner, pending, target, resolved);
      useProjectStore.getState().updatePendingGen(pending.id, { rtcResult: resolved });
      if (seg?.kind === "placeholder" && seg.taskRef === pending.id) {
        if (!sink.landMedia(target.segId, { media: result.media, uri, assetId: result.assetId, durationSec, sourceWindow,
          resizeToDuration: result.media === "video" && !pending.derived, onResizeWarning: notifyRtcResizeWarning,
          owner: owner.projectInstanceId, target, expectedTaskRef: pending.id, shouldContinue: current })) return false;
      }
    }
  }
  if (!current()) return false;
  await useProjectStore.getState().save(true);
  // 从窗口同步结果与 pending 移除；独立凭据由 queue 的写者落盘确认另行清理。
  return current() && (!isProjectWriter() || !useProjectStore.getState().isDirty);
}

export async function failRtcPending(owner: GenerationOwner, pending: PendingGen, error: string): Promise<void> {
  const target = pendingRtcTarget(pending);
  if (!target) return;
  const sink = await import("@/rtc/panel/rtcGenSink");
  sink.markFailed(target.segId, error, owner.projectInstanceId, { target, expectedTaskRef: pending.id });
}
