import type { PendingGen, RtcGenerationResult, RtcGenerationTarget } from "./projectFile";
import type { GenerationOwner } from "./generationReceipts";

type Receipt = { createdAt: number; target?: RtcGenerationTarget; result: RtcGenerationResult };
const prefix = "Qiji:rtcGenerationResult:";
const memory = new Map<string, Receipt>();
const keyOf = (owner: GenerationOwner, id: string) => prefix + JSON.stringify([owner.savePath || owner.projectInstanceId, id]);

/** 项目磁盘保存失败或已切页时，终态仍按原项目和原任务持久保留。 */
export function rememberRtcGenerationResult(owner: GenerationOwner, pending: PendingGen, target: RtcGenerationTarget | undefined, result: RtcGenerationResult): void {
  const key = keyOf(owner, pending.id);
  const receipt = { createdAt: pending.createdAt, target, result };
  memory.set(key, receipt);
  try { localStorage.setItem(key, JSON.stringify(receipt)); }
  catch (error) { console.warn("[rtc] 结果凭据暂存失败，保留会话副本", error); }
}

export function readRtcGenerationResult(owner: GenerationOwner, pending: PendingGen): Receipt | undefined {
  const key = keyOf(owner, pending.id);
  let receipt = memory.get(key);
  if (!receipt) {
    try { receipt = JSON.parse(localStorage.getItem(key) || "null") ?? undefined; } catch { /* 无副本 */ }
  }
  if (!receipt || receipt.createdAt !== pending.createdAt || !receipt.result?.uri) return;
  if (receipt.target ? !receipt.target.episodeId || !receipt.target.segId : !pending.shot && !pending.derived) return;
  if (pending.taskId && receipt.result.taskId && pending.taskId !== receipt.result.taskId) return;
  return receipt;
}

export function forgetRtcGenerationResult(owner: GenerationOwner, id: string): void {
  const key = keyOf(owner, id);
  memory.delete(key);
  try { localStorage.removeItem(key); } catch { /* 剩余副本仍由任务身份校验 */ }
}
