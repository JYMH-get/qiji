import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR, saveJson } from './db.ts';
import type { ModelDef } from './models.ts';
import { groupPriceVersion, pricedGroupLine } from './agentGroupPrices.ts';

export type PriceLayer = 'purchase' | 'retail';
export type LinePrice = Pick<ModelDef, 'cost' | 'costField' | 'costPerUnit' | 'tokenPricing'> & {
  costRules?: { when: Record<string, string>; cost?: number; costPerUnit?: number }[];
};
interface Layer { price?: LinePrice; enabled?: boolean }
interface LineSetting { purchase?: Layer; retail?: Layer; revision: number }
interface State { version: number; agents: Record<string, Record<string, LineSetting>> }
const FILE = 'agent-line-prices.json';
// A damaged price file must not silently fall back to another price.
let state: State = existsSync(join(DATA_DIR, FILE)) ? JSON.parse(readFileSync(join(DATA_DIR, FILE), 'utf8')) : { version: 0, agents: {} };
export function agentLineSetting(agentId: string, lineId: string): LineSetting {
  return structuredClone(state.agents[agentId]?.[lineId] ?? { revision: 0 });
}
export function agentLinePriceVersion(agentId?: string): string {
  return groupPriceVersion(agentId)+ (agentId ? createHash('sha256').update(JSON.stringify(state.agents[agentId] ?? {})).digest('hex').slice(0, 20) : '');
}
export function linePriceOf(model: ModelDef): LinePrice {
  return structuredClone({ cost: model.cost, costField: model.costField, costPerUnit: model.costPerUnit, tokenPricing: model.tokenPricing,
    costRules: model.routes?.map(({ when, cost, costPerUnit }) => ({ when, cost, costPerUnit })) });
}
export function pricedAgentLine<T extends ModelDef | undefined>(model: T, agentId?: string, layer: PriceLayer = 'retail'): T {
  return pricedGroupLine(model,agentId,layer);
}
/** Source gate replaces its legacy route switch; retailer's switch can only restrict it. */
export function agentLineGates(agentId: string, inherited?: Record<string, boolean>): Record<string, boolean> | undefined {
  const gates = { ...inherited };
  for (const [id, line] of Object.entries(state.agents[agentId] ?? {})) {
    if (line.purchase?.enabled !== undefined) gates[id] = line.purchase.enabled;
    if (line.retail?.enabled === false) gates[id] = false;
  }
  return Object.keys(gates).length ? gates : undefined;
}
export function saveAgentLineSetting(agentId: string, lineId: string, layer: PriceLayer, expectedRevision: number, patch: { price?: LinePrice | null; enabled?: boolean }): void {
  const line = agentLineSetting(agentId, lineId);
  if (line.revision !== expectedRevision) throw Object.assign(new Error('线路已被更新，请刷新后重新保存'), { statusCode: 409 });
  const value = { ...line[layer] };
  if ('price' in patch) { if (patch.price === null) delete value.price; else value.price = structuredClone(patch.price); }
  if (patch.enabled !== undefined) value.enabled = patch.enabled;
  const next = structuredClone(state);
  next.agents[agentId] ??= {};
  next.agents[agentId][lineId] = { ...line, [layer]: value, revision: line.revision + 1 };
  next.version++;
  saveJson(FILE, next); state = next;
}
export function removeAgentLineSettings(agentId: string): void {
  if (!state.agents[agentId]) return;
  const next = structuredClone(state); delete next.agents[agentId]; next.version++;
  saveJson(FILE, next); state = next;
}
