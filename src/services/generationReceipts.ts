import type { PendingGen } from "./projectFile";

export type GenerationOwner = { projectInstanceId: string; savePath: string | null };
type Receipt = GenerationOwner & { createdAt: number; taskId: string; adapterKey: string };
const prefix = "Qiji:generationReceipt:";
const memory = new Map<string, Receipt>();
const keyOf = (owner: GenerationOwner, id: string) => prefix + JSON.stringify([owner.savePath || owner.projectInstanceId, id]);

/** 提交回执独立于当前打开的项目保存；切项目后到达的 taskId 仍能在原项目重开时认领。 */
export function rememberGenerationReceipt(owner: GenerationOwner, pending: PendingGen, taskId: string, adapterKey: string): void {
    const key = keyOf(owner, pending.id);
    const receipt = { ...owner, createdAt: pending.createdAt, taskId, adapterKey };
    memory.set(key, receipt);
    try { localStorage.setItem(key, JSON.stringify(receipt)); }
    catch (error) { console.warn("[generation] 任务凭据暂存失败，保留会话副本", error); }
}

export function readGenerationReceipt(owner: GenerationOwner, pending: PendingGen): Receipt | undefined {
    const key = keyOf(owner, pending.id);
    let receipt = memory.get(key);
    if (!receipt) {
        try { receipt = JSON.parse(localStorage.getItem(key) || "null") ?? undefined; } catch { /* 无持久化副本 */ }
    }
    if (!receipt || receipt.createdAt !== pending.createdAt || !receipt.taskId || !receipt.adapterKey) return;
    return receipt;
}

export function forgetGenerationReceipt(owner: GenerationOwner, id: string): void {
    const key = keyOf(owner, id);
    memory.delete(key);
    try { localStorage.removeItem(key); } catch { /* 项目仍保存着受理凭据，之后可幂等找回 */ }
}
