import { db } from './store/sqlite.ts';
import { resolveModelCost, type ModelDef } from './store/models.ts';
import { textCharge } from './textPricing.ts';
import type { TaskState, TextTokenPricing } from './contract.ts';

interface Quote { cost: number; pricing?: TextTokenPricing; at: number }
db.exec('CREATE TABLE IF NOT EXISTS node_retail_quotes (log_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL)');
db.exec('CREATE INDEX IF NOT EXISTS node_retail_quotes_task ON node_retail_quotes(task_id)');
/** Retail quote is frozen on the source, beside the independently charged purchase quote. */
export function rememberNodeRetail(logId: string, agentId: string, model: ModelDef | undefined, params?: Record<string, unknown>): number {
  const quote: Quote = { cost: model ? resolveModelCost(model, params) : 0, pricing: model?.tokenPricing?.enabled ? structuredClone(model.tokenPricing) : undefined, at: Date.now() };
  db.prepare('INSERT INTO node_retail_quotes(log_id,agent_id,data) VALUES (?,?,?)').run(logId, agentId, JSON.stringify(quote));
  db.prepare("DELETE FROM node_retail_quotes WHERE json_extract(data,'$.at') < ?").run(Date.now() - 7 * 86400000);
  return quote.cost;
}
export function linkNodeRetail(logId: string, taskId: string): void { db.prepare('UPDATE node_retail_quotes SET task_id=? WHERE log_id=?').run(taskId, logId); }
export function nodeRetailResult(id: string, agentId: string, result: TaskState['result']): { cost: number; result: TaskState['result'] } | undefined {
  const row = db.prepare('SELECT data FROM node_retail_quotes WHERE agent_id=? AND (log_id=? OR task_id=?)').get(agentId, id, id) as { data: string } | undefined;
  if (!row) return;
  const q = JSON.parse(row.data) as Quote;
  if (q.pricing && result?.usage) {
    const bill = { ...textCharge(q.pricing, result.usage, q.at), precharged: q.cost, status: 'settled' as const };
    return { cost: bill.cost, result: { ...result, billing: bill } };
  }
  // A fixed retail price must never inherit the purchase token settlement in a node response.
  if (result?.billing && !q.pricing) return { cost: q.cost, result: { ...result, billing: { cost: q.cost, precharged: q.cost, status: 'settled' } } };
  return { cost: q.cost, result };
}
