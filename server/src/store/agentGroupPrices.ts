import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, saveJson } from './db.ts';
import { audienceGroupId, PLATFORM_AUDIENCE } from './agents.ts';
import type { ModelDef } from './models.ts';
import { offsetLinePrice } from '../agentPriceEditor.ts';
import type { PriceLayer } from './agentLinePrices.ts';

export type PriceOffsets = Record<string,number>;
interface GroupLine { purchase?: PriceOffsets; retail?: PriceOffsets; revision: number }
interface State { version:number; groups:Record<string,Record<string,GroupLine>> }
const FILE='agent-group-prices.json';
let state:State=existsSync(join(DATA_DIR,FILE))?JSON.parse(readFileSync(join(DATA_DIR,FILE),'utf8')):{version:0,groups:{}};
export function groupLineSetting(groupId:string,lineId:string):GroupLine {
  return structuredClone(state.groups[groupId]?.[lineId]??{revision:0});
}
export function groupPriceVersion(agentId?:string):string {
  const groupId=audienceGroupId(agentId||PLATFORM_AUDIENCE);
  return createHash('sha256').update(JSON.stringify([groupId,state.groups[groupId]??{}])).digest('hex').slice(0,20);
}
export function pricedGroupLine<T extends ModelDef|undefined>(model:T,agentId?:string,layer:PriceLayer='retail'):T {
  if(!model||!model.id.startsWith('route:'))return model;
  return pricedLineForGroup(model,audienceGroupId(agentId||PLATFORM_AUDIENCE),layer) as T;
}
export function pricedLineForGroup(model:ModelDef,groupId:string,layer:PriceLayer):ModelDef {
  const offsets=groupLineSetting(groupId,model.id)[layer];
  if(!offsets||!Object.values(offsets).some(Boolean))return model;
  const {costRules,...price}=offsetLinePrice(model,offsets);
  return {...model,...price,routes:costRules?.map(r=>({...r,upstreamModel:''}))};
}
export function saveGroupLineOffsets(groupId:string,lineId:string,expectedRevision:number,patch:{purchase:PriceOffsets;retail:PriceOffsets}):void {
  const old=groupLineSetting(groupId,lineId);
  if(old.revision!==expectedRevision)throw Object.assign(new Error('分组价格已更新，请刷新后重试'),{statusCode:409});
  const next=structuredClone(state);next.groups[groupId]??={};
  next.groups[groupId][lineId]={...structuredClone(patch),revision:old.revision+1};next.version++;
  saveJson(FILE,next);state=next;
}
