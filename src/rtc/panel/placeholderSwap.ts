/**
 * RTC 在途状态对账。所有分集都扫描；终态由 generationQueue 按任务自己的
 * rtcTarget/rtcResult 投递并保存后销账，不再以历史列表长度或最新一条结果猜测。
 */
import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { orphanPatch, parseTaskRef, pendingMirrorPatch } from "./rtcGenCore";
import { armRunning, currentOwner, liveSegment, mirrorStatus, resolveRtcTarget, rtcSegments } from "./rtcGenSink";
import { resumeFreeGens } from "./freeGenActions";

/** 兼容旧调用方；任务是否在接管中以持久台账为准，不依赖页面挂载。 */
export function isPlaceholderArmed(segId: string): boolean {
  return rtcSegments().some(({ seg }) => seg.id === segId && useProjectStore.getState().pendingGens.some(p => p.id === seg.taskRef));
}

export function armPendingWatch(pendingId: string, segId: string): void {
  const state = useProjectStore.getState();
  const pending = state.pendingGens.find(p => p.id === pendingId);
  const target = pending?.rtcTarget ?? resolveRtcTarget(segId);
  if (!pending || !target || target.segId !== segId) return;
  const seg = liveSegment(segId, target);
  if (!seg || seg.kind !== "placeholder" || (seg.taskRef && seg.taskRef !== pendingId)) return;
  if (!pending.rtcTarget) state.updatePendingGen(pendingId, { rtcTarget: target });
  armRunning(segId, pendingId, currentOwner(), { target });
  scanPlaceholders();
}

export function armPlaceholderSwap(pendingId: string, _episodeId: string, _shotId: string, segId: string): void {
  armPendingWatch(pendingId, segId);
}

let scanning = false;
let recoveryQueued = false;
function recoverCompleted(): void {
  if (recoveryQueued) return;
  recoveryQueued = true;
  void import("@/services/generationQueue").then(({ resumeRtcPendingResults }) => {
    resumeRtcPendingResults();
  }).finally(() => { recoveryQueued = false; });
}

/** 旧 taskRef 只有精确命中 pending 才补显式目标；无凭据的旧结果绝不拿 latest 历史代替。 */
export function scanPlaceholders(): void {
  const state = useProjectStore.getState();
  if (scanning || state.isProjectLoading) return;
  scanning = true;
  try {
    const owner = currentOwner();
    const entries = rtcSegments();
    for (const { seg, target } of entries) {
      if (seg.kind !== "placeholder") continue;
      const ref = parseTaskRef(seg.taskRef);
      if (!ref || ref.kind !== "pending") continue;
      const pending = useProjectStore.getState().pendingGens.find(p => p.id === ref.pendingId);
      if (pending) {
        if (!pending.rtcTarget && entries.filter(x => x.seg.taskRef === pending.id).length === 1) {
          useProjectStore.getState().updatePendingGen(pending.id, { rtcTarget: target });
        }
        if (pending.rtcTarget && (pending.rtcTarget.episodeId !== target.episodeId || pending.rtcTarget.segId !== target.segId || pending.rtcTarget.subDocId !== target.subDocId)) continue;
        const patch = pendingMirrorPatch(seg, pending);
        if (patch) mirrorStatus(seg.id, patch, owner, { target, expectedTaskRef: ref.pendingId });
      } else if (seg.status !== "failed") {
        mirrorStatus(seg.id, orphanPatch(), owner, { target, expectedTaskRef: ref.pendingId });
      }
    }
    resumeFreeGens();
    recoverCompleted();
  } finally { scanning = false; }
}

let inited = false;

/** 页面首次启用后保留项目级订阅；queue 即便从未挂载本 watcher 也会交付结果。 */
export function initRtcGenWatch(): void {
  if (inited) return;
  inited = true;
  let previousDoc = useRtcStore.getState().doc;
  let previous = useProjectStore.getState();
  useRtcStore.subscribe(s => {
    if (s.doc === previousDoc) return;
    previousDoc = s.doc;
    scanPlaceholders();
  });
  useProjectStore.subscribe(s => {
    const changed = s.projectInstanceId !== previous.projectInstanceId || s.rtcDocs !== previous.rtcDocs || s.pendingGens !== previous.pendingGens || (previous.isDirty && !s.isDirty);
    previous = s;
    if (changed) scanPlaceholders();
  });
  scanPlaceholders();
}
