import { db } from './sqlite.ts';
import { settle, type Charged } from './credits.ts';
import { textCharge } from '../textPricing.ts';
import { updateTextBillingLog, getRunningLogIds } from './logs.ts';
import { DATA_DIR } from './db.ts';
import { join } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { readRecoveryCandidates } from '../startupRecovery.ts';
import type { TaskState, TextTokenPricing, TextBill } from '../contract.ts';

interface AccountPrice { cost: number; pricing?: TextTokenPricing; discountPercent: number }
export interface TextPriceSnapshot { modelId: string; pricing: TextTokenPricing; at: number; discountPercent: number;
  accounts?: { user: AccountPrice; agents: (AccountPrice & { id: string })[] } }
interface Entry { charged: Charged; snapshot: TextPriceSnapshot; taskId?: string; result?: TaskState['result']; finalized?: boolean }
db.exec('CREATE TABLE IF NOT EXISTS text_billing (log_id TEXT PRIMARY KEY, data TEXT NOT NULL)');
const put = (id: string, e: Entry) => db.prepare('INSERT INTO text_billing(log_id,data) VALUES (?,?) ON CONFLICT(log_id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(e));
const get = (id: string): Entry | undefined => {
  const row = db.prepare('SELECT data FROM text_billing WHERE log_id=?').get(id) as {data: string} | undefined;
  return row ? JSON.parse(row.data) : undefined;
};
export function textBillingAmounts(logId: string): { userAmount: number; agents: { id: string; cost: number }[] } | undefined {
  const e = get(logId); if (!e?.finalized || !e.result?.usage || !e.snapshot.accounts) return;
  const cost = (p: AccountPrice) => p.pricing ? textCharge(p.pricing, e.result!.usage!, e.snapshot.at, p.discountPercent).cost : p.cost;
  return { userAmount: cost(e.snapshot.accounts.user), agents: e.snapshot.accounts.agents.map(p => ({ id: p.id, cost: cost(p) })) };
}

export function prepareTextBilling(logId: string, charged: Charged, snapshot: TextPriceSnapshot): void {
  if (!get(logId)) put(logId, { charged, snapshot });
  db.prepare("DELETE FROM text_billing WHERE json_extract(data,'$.snapshot.at') < ? AND (json_extract(data,'$.finalized')=1 OR json_extract(data,'$.result') IS NULL)").run(Date.now()-7*86400_000);
}
export function linkTextBillingTask(logId: string, taskId: string): void {
  const e = get(logId); if (e) { e.taskId = taskId; put(logId, e); }
}

/** Persist the result before moving money, then use one durable operation id across retries/restarts. */
export function finishTextBilling(logId: string, result: TaskState['result']): TaskState['result'] {
  const e = get(logId); if (!e) return result;
  if (e.finalized) { if (e.result?.billing) updateTextBillingLog(logId, e.result.billing, e.result.usage, textBillingAmounts(logId)); return e.result; }
  if (!e.result) { e.result = result ?? {}; put(logId, e); }
  const original = e.charged;
  const precharged = e.snapshot.accounts ? original.userAmount : original.agents.length ? original.agents[0].cost : original.userAmount;
  let bill: TextBill;
  if (!e.result.usage) {
    db.prepare('DELETE FROM text_billing WHERE log_id=?').run(logId);
    throw new Error('该文本模型未返回有效用量，本次失败并退回预扣');
  }
  else {
    const accounts = e.snapshot.accounts;
    const calculate = (p: AccountPrice) => p.pricing ? textCharge(p.pricing, e.result!.usage!, e.snapshot.at, p.discountPercent) : { cost: p.cost };
    const calculated = accounts ? calculate(accounts.user) : textCharge(e.snapshot.pricing, e.result.usage, e.snapshot.at, e.snapshot.discountPercent);
    const delta = calculated.cost - precharged;
    const settled = settle({ reason: 'text-token-settle', idempotencyKey: 'text:'+logId, ref: logId,
      payerId: original.payerId, statsUserId: original.statsUserId,
      userWallet: original.userWallet,
      userAmount: accounts ? delta : original.agents.length ? 0 : delta,
      agents: accounts ? accounts.agents.map(a => ({ id: a.id, cost: calculate(a).cost - (original.agents.find(c => c.id === a.id)?.cost ?? 0) })) : original.agents.map(a => ({id:a.id, cost:delta})) });
    if (!settled.ok) throw new Error(settled.error);
    bill = { ...calculated, status: 'settled', precharged };
  }
  e.result.billing = bill;
  e.finalized = bill.status === 'settled';
  put(logId, e);
  updateTextBillingLog(logId, bill, e.result.usage, textBillingAmounts(logId));
  return e.result;
}

/** Restore successfully generated text before generic orphan refunds run. */
type RecoveredText = {logId: string; taskId?: string; result: TaskState['result']};
export async function recoverTextBillingResults(ids: readonly string[] = getRunningLogIds(), onRecovered?: (entry: RecoveredText) => void): Promise<RecoveredText[]> {
  const recovered: RecoveredText[] = [];
  for await (const batch of readRecoveryCandidates(join(DATA_DIR, 'qiji.db'), [...new Set(ids)])) {
    for (const candidate of batch) {
      // Re-read on the sole writer: workers never finalize, debit or refund.
      const e = get(candidate.logId);
      if (!e?.result) continue;
      const entry = {logId:candidate.logId, taskId:e.taskId, result:finishTextBilling(candidate.logId,e.result)};
      onRecovered?.(entry);
      recovered.push(entry);
      if (recovered.length % 16 === 0) await yieldToLoop();
    }
    await yieldToLoop();
  }
  return recovered;
}
