import { useProjectStore } from "@/store/projectStore";
import type { GenerationOwner } from "./generationReceipts";
import type { RtcGenerationResult, RtcGenerationTarget } from "./projectFile";
import { isProjectWriter } from "./windowSync";
import { useSyncExternalStore } from "react";
import { registerRtcGeneratedAsset } from "./rtcGeneratedLibrary";
import { notifyRtcResizeWarning } from "./rtcGenerationDelivery";

export type FreeRtcGenerationTask = {
  id: string; target: RtcGenerationTarget; taskRef?: string;
  media: "image" | "video" | "audio"; name: string; createdAt: number;
  status: "preparing" | "running" | "saving" | "failed"; progress?: number; error?: string;
};
type TaskDetails = Partial<Pick<FreeRtcGenerationTask, "media" | "name" | "createdAt" | "status" | "progress" | "error">>;
type Receipt = TaskDetails & { target: RtcGenerationTarget; taskRef: string; result?: RtcGenerationResult; supersededTaskRefs?: string[] };
const prefix = "Qiji:rtcFreeGeneration:";
const memory = new Map<string, Receipt>();
const locallyDelivered = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { version++; for (const listener of listeners) listener(); };
const ownerKey = (owner: GenerationOwner) => owner.savePath || owner.projectInstanceId;
const keyOf = (owner: GenerationOwner, target: RtcGenerationTarget) => prefix + JSON.stringify([ownerKey(owner), target.episodeId, target.subDocId ?? null, target.segId]);
const deliveryKey = (owner: GenerationOwner, receipt: Pick<Receipt, "target" | "taskRef">) => JSON.stringify([owner.projectInstanceId, keyOf(owner, receipt.target), receipt.taskRef]);
const ownerCurrent = (owner: GenerationOwner) => {
  const state = useProjectStore.getState();
  return state.projectInstanceId === owner.projectInstanceId && !state.isProjectLoading;
};
function read(owner: GenerationOwner, target: RtcGenerationTarget): Receipt | undefined {
  const key = keyOf(owner, target);
  let receipt = memory.get(key);
  if (!receipt) { try { receipt = JSON.parse(localStorage.getItem(key) || "null") ?? undefined; } catch { /* 无副本 */ } }
  return receipt?.target?.segId && (receipt.taskRef || receipt.media) ? receipt : undefined;
}
function write(owner: GenerationOwner, receipt: Receipt, persist = true): void {
  const key = keyOf(owner, receipt.target);
  memory.set(key, receipt);
  if (persist) {
    try { localStorage.setItem(key, JSON.stringify(receipt)); }
    catch (error) { console.warn("[rtc] 自由生成凭据暂存失败，保留会话副本", error); }
  }
  notify();
}

/** Preparation shares the accepted-task receipt; no second task ledger is introduced. */
export function rememberFreeRtcPreparation(owner: GenerationOwner, target: RtcGenerationTarget,
  details: Pick<FreeRtcGenerationTask, "media" | "name" | "createdAt">, previousTaskRef?: string): void {
  const previous = read(owner, target);
  const inherited = previous?.taskRef === previousTaskRef ? previous?.supersededTaskRefs ?? [] : [];
  const supersededTaskRefs = [...new Set([...inherited, ...(previousTaskRef ? [previousTaskRef] : [])])];
  write(owner, { target, taskRef: "", ...details, status: "preparing", progress: 0, ...(supersededTaskRefs.length ? { supersededTaskRefs } : {}) });
}
export function updateFreeRtcTask(owner: GenerationOwner, target: RtcGenerationTarget, patch: TaskDetails, persist = true): void {
  const receipt = read(owner, target);
  if (receipt) write(owner, { ...receipt, ...patch }, persist);
}
export function discardFreeRtcPreparation(owner: GenerationOwner, target: RtcGenerationTarget): void {
  const receipt = read(owner, target);
  if (!receipt || receipt.taskRef || receipt.status !== "preparing") return;
  const key = keyOf(owner, target); memory.delete(key);
  try { localStorage.removeItem(key); } catch { /* No accepted task to recover. */ }
  notify();
}
/** Save As changes the durable path, while the active project instance still owns its task. */
export function moveFreeRtcReceipt(from: GenerationOwner, to: GenerationOwner, target: RtcGenerationTarget): void {
  const fromKey = keyOf(from, target), toKey = keyOf(to, target);
  if (fromKey === toKey) return;
  const receipt = read(from, target);
  if (!receipt) return;
  const existing = read(to, target);
  if (existing && existing.taskRef !== receipt.taskRef) return;
  write(to, receipt); memory.delete(fromKey);
  try { localStorage.removeItem(fromKey); } catch { /* The new path still owns its durable receipt. */ }
  notify();
}

/** previousTaskRef 来自提交前的片段快照；保存失败重开时只替代这条明确的旧任务链。 */
export function rememberFreeRtcTask(owner: GenerationOwner, target: RtcGenerationTarget, taskRef: string, previousTaskRef?: string): void {
  if (!taskRef) return;
  const previous = read(owner, target);
  const sameTask = previous?.taskRef === taskRef;
  const inherited = sameTask || previous?.taskRef === previousTaskRef || (!previous?.taskRef && !!previousTaskRef && previous?.supersededTaskRefs?.includes(previousTaskRef)) ? previous?.supersededTaskRefs ?? [] : [];
  const supersededTaskRefs = [...new Set([...inherited, ...(previousTaskRef && previousTaskRef !== taskRef ? [previousTaskRef] : [])])];
  const details: TaskDetails = previous?.media ? { media: previous.media, name: previous.name, createdAt: previous.createdAt, status: sameTask && previous.result ? "saving" : "running", progress: sameTask ? previous.progress : undefined } : {};
  write(owner, { ...details, target, taskRef, ...(supersededTaskRefs.length ? { supersededTaskRefs } : {}), ...(sameTask && previous.result ? { result: previous.result } : {}) });
}
export function rememberFreeRtcCompletion(owner: GenerationOwner, target: RtcGenerationTarget, taskRef: string, result: RtcGenerationResult): void {
  if (!taskRef || !result.uri) return;
  const taskId = taskRef.slice(taskRef.indexOf("|") + 1);
  if (result.taskId && result.taskId !== taskId) return;
  const previous = read(owner, target);
  if (previous && previous.taskRef !== taskRef) return;
  write(owner, { ...previous, target, taskRef, ...(previous?.media ? { status: "saving" as const, progress: 100, error: undefined } : {}), result: { ...result, taskId } });
}
export function readFreeRtcCompletion(owner: GenerationOwner, target: RtcGenerationTarget, taskRef: string): RtcGenerationResult | undefined {
  const receipt = read(owner, target);
  if (receipt?.taskRef === taskRef && receipt.result?.uri) return receipt.result;
  if (!ownerCurrent(owner)) return;
  const doc = useProjectStore.getState().rtcDocs?.[target.episodeId];
  const tracks = target.subDocId ? doc?.subDocs?.[target.subDocId]?.tracks : doc?.tracks;
  const seg = tracks?.flatMap(t => t.segments).find(s => s.id === target.segId);
  return seg?.taskRef === taskRef && seg.rtcResult?.taskId === taskRef.slice(taskRef.indexOf("|") + 1) ? seg.rtcResult : undefined;
}
export function receivedFreeRtcTasks(owner: GenerationOwner): Array<Omit<Receipt, "result">> {
  const keys = new Set(memory.keys());
  try { for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (key) keys.add(key); } } catch { /* 使用会话副本 */ }
  const receipts: Receipt[] = [];
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    try {
      if (JSON.parse(key.slice(prefix.length))[0] !== ownerKey(owner)) continue;
      const receipt = memory.get(key) ?? JSON.parse(localStorage.getItem(key) || "null");
      if ((receipt?.taskRef || receipt?.media) && receipt.target?.segId) receipts.push(receipt);
    } catch { /* 坏凭据不认领 */ }
  }
  return receipts.map(({ result: _result, ...receipt }) => receipt);
}

// First save / Save As changes the path before another runner callback may arrive.
// Move only within the same loaded project instance, so closing immediately remains recoverable.
const detachPathWatcher = useProjectStore.subscribe?.((state, previous) => {
  if (state.isProjectLoading || previous.isProjectLoading || state.projectInstanceId !== previous.projectInstanceId || state.savePath === previous.savePath) return;
  const from = { projectInstanceId: previous.projectInstanceId, savePath: previous.savePath };
  const to = { projectInstanceId: state.projectInstanceId, savePath: state.savePath };
  for (const receipt of receivedFreeRtcTasks(from)) moveFreeRtcReceipt(from, to, receipt.target);
});
if (import.meta.hot) import.meta.hot.dispose(() => detachPathWatcher?.());

export function useFreeRtcGenerationTasks(): FreeRtcGenerationTask[] {
  const projectInstanceId = useProjectStore(state => state.projectInstanceId);
  const savePath = useProjectStore(state => state.savePath);
  const loading = useProjectStore(state => state.isProjectLoading);
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version, () => 0);
  if (loading) return [];
  return getFreeRtcGenerationTasks({ projectInstanceId, savePath });
}
export function getFreeRtcGenerationTasks(owner: GenerationOwner): FreeRtcGenerationTask[] {
  return receivedFreeRtcTasks(owner).flatMap(receipt => receipt.media && !locallyDelivered.has(deliveryKey(owner, receipt)) ? [{
    id: keyOf(owner, receipt.target), target: receipt.target, taskRef: receipt.taskRef || undefined,
    media: receipt.media, name: receipt.name || "自由生成", createdAt: receipt.createdAt ?? 0,
    status: receipt.status ?? "running", progress: receipt.progress, error: receipt.error,
  }] : []);
}

const delivering = new Map<string, Promise<boolean>>();
/** Results are retained in the episode library before optional timeline placement. */
export function deliverFreeRtcCompletion(args: { owner: GenerationOwner; target: RtcGenerationTarget; taskRef: string; shouldContinue?: () => boolean }): Promise<boolean> {
  const key = JSON.stringify([args.owner.projectInstanceId, args.target, args.taskRef]);
  const running = delivering.get(key);
  if (running) return running;
  const promise = deliver(args).catch(error => { console.warn("[rtc] 自由生成结果待保存", error); return false; }).finally(() => delivering.delete(key));
  delivering.set(key, promise);
  return promise;
}
async function deliver({ owner: originalOwner, target, taskRef, shouldContinue }: { owner: GenerationOwner; target: RtcGenerationTarget; taskRef: string; shouldContinue?: () => boolean }): Promise<boolean> {
  const owner = { ...originalOwner };
  const followSavedPath = () => {
    if (!ownerCurrent(owner)) return false;
    const savePath = useProjectStore.getState().savePath;
    if (savePath !== owner.savePath) {
      moveFreeRtcReceipt(owner, { ...owner, savePath }, target);
      owner.savePath = savePath;
    }
    return true;
  };
  if (!followSavedPath()) return false;
  const sink = await import("@/rtc/panel/rtcGenSink");
  if (!followSavedPath()) return false;
  let seg = sink.liveSegment(target.segId, target);
  let result = readFreeRtcCompletion(owner, target, taskRef);
  if (!result) return false;
  const current = () => followSavedPath() && shouldContinue?.() !== false && read(owner, target)?.taskRef === taskRef;
  if (!read(owner, target)) rememberFreeRtcCompletion(owner, target, taskRef, result);
  if (!current()) return false;
  if (seg?.kind === "placeholder" && seg.taskRef === taskRef) {
    sink.mirrorStatus(target.segId, { rtcResult: result }, owner.projectInstanceId, { target, expectedTaskRef: taskRef, shouldContinue: current });
  }
  const details = read(owner, target);
  await useProjectStore.getState().save(true);
  if (!current()) return false;
  if (!result.displayUri) {
      const landed = await sink.persistGenAsset({ resultUri: result.uri, assetId: result.assetId, rawLink: result.rawLink, saveToOss: result.saveToOss,
        kind: result.media, label: details?.name || seg?.name || "自由生成", owner: owner.projectInstanceId, shouldContinue: current });
      if (!current()) return false;
      result = { ...result, displayUri: landed.uri, assetId: landed.assetId };
      rememberFreeRtcCompletion(owner, target, taskRef, result);
  }
  const durationSec = result.durationSec ?? await sink.probeDurationSec(result.displayUri || result.uri, result.media);
  if (!current()) return false;
  result = { ...result, durationSec };
  rememberFreeRtcCompletion(owner, target, taskRef, result);
  if (!registerRtcGeneratedAsset({ owner: owner.projectInstanceId, episodeId: target.episodeId, taskKey: `free:${taskRef}`,
    media: result.media, uri: result.displayUri || result.uri, assetId: result.assetId, name: details?.name || seg?.name || "自由生成", createdAt: details?.createdAt })) return false;
  // A deleted/replaced placement is optional; it never blocks retaining the paid result.
  seg = sink.liveSegment(target.segId, target);
  if (seg?.kind === "placeholder" && seg.taskRef === taskRef) sink.landMedia(target.segId, {
    media: result.media, uri: result.displayUri || result.uri, assetId: result.assetId, durationSec,
    resizeToDuration: result.media === "video", onResizeWarning: notifyRtcResizeWarning,
    owner: owner.projectInstanceId, target, expectedTaskRef: taskRef, shouldContinue: current });
  // landMedia 清 taskRef 后，调用方的 placeholder 守卫自然失效；保存确认改验 owner 和已交付标识。
  if (!followSavedPath()) return false;
  seg = sink.liveSegment(target.segId, target);
  if (seg?.kind === "placeholder" && seg.taskRef === taskRef) return false;
  await useProjectStore.getState().save(true);
  if (!followSavedPath()) return false;
  if (!isProjectWriter()) {
    // The result is already visible/synchronized here; only the writer can acknowledge its receipt.
    locallyDelivered.add(deliveryKey(owner, { target, taskRef })); notify();
    return true;
  }
  if (useProjectStore.getState().isDirty) return false;
  if (read(owner, target)?.taskRef === taskRef) {
    const key = keyOf(owner, target);
    memory.delete(key);
    locallyDelivered.delete(deliveryKey(owner, { target, taskRef }));
    try { localStorage.removeItem(key); } catch { /* 保存已确认，残留副本仍按任务精确去重 */ }
    notify();
  }
  return true;
}
