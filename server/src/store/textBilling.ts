import { db } from './sqlite.ts';
import { settle, type Charged } from './credits.ts';
import { textCharge } from '../textPricing.ts';
import { updateTextBillingLog } from './logs.ts';
import type { TaskState, TextTokenPricing, TextBill } from '../contract.ts';

export interface TextPriceSnapshot { modelId: string; pricing: TextTokenPricing; at: number; discountPercent: number }
interface Entry { charged: Charged; snapshot: TextPriceSnapshot; taskId?: string; result?: TaskState['result']; finalized?: boolean }
db.exec('CREATE TABLE IF NOT EXISTS text_billing (log_id TEXT PRIMARY KEY, data TEXT NOT NULL)');
const put = (id: string, e: Entry) => db.prepare('INSERT INTO text_billing(log_id,data) VALUES (?,?) ON CONFLICT(log_id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(e));
const get = (id: string): Entry | undefined => {
  const row = db.prepare('SELECT data FROM text_billing WHERE log_id=?').get(id) as {data: string} | undefined;
  return row ? JSON.parse(row.data) : undefined;
};

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
  if (e.finalized) { if (e.result?.billing) updateTextBillingLog(logId, e.result.billing, e.result.usage); return e.result; }
  if (!e.result) { e.result = result ?? {}; put(logId, e); }
  const original = e.charged;
  const precharged = original.agents.length ? original.agents[0].cost : original.userAmount;
  let bill: TextBill;
  if (!e.result.usage) {
    db.prepare('DELETE FROM text_billing WHERE log_id=?').run(logId);
    throw new Error('该文本模型未返回有效用量，本次失败并退回预扣');
  }
  else {
    const calculated = textCharge(e.snapshot.pricing, e.result.usage, e.snapshot.at, e.snapshot.discountPercent);
    const delta = calculated.cost - precharged;
    const settled = settle({ reason: 'text-token-settle', idempotencyKey: 'text:'+logId, ref: logId,
      payerId: original.payerId, statsUserId: original.statsUserId,
      userAmount: original.agents.length ? 0 : delta, agents: original.agents.map(a => ({id:a.id, cost:delta})) });
    if (!settled.ok) throw new Error(settled.error);
    bill = { ...calculated, status: 'settled', precharged };
  }
  e.result.billing = bill;
  e.finalized = bill.status === 'settled';
  put(logId, e);
  updateTextBillingLog(logId, bill, e.result.usage);
  return e.result;
}

/** Restore successfully generated text before generic orphan refunds run. */
export function recoverTextBillingResults(): {logId: string; taskId?: string; result: TaskState['result']}[] {
  const rows = db.prepare('SELECT log_id,data FROM text_billing').all() as {log_id:string;data:string}[];
  return rows.flatMap(row => {
    const e = JSON.parse(row.data) as Entry;
    if (!e.result) return [];
    return [{logId: row.log_id, taskId: e.taskId, result: finishTextBilling(row.log_id, e.result)}];
  });
}
