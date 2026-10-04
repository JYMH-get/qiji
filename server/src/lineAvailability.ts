import { measuredSuccessRate } from './availabilityHistory.ts';
import { db } from './store/sqlite.ts';
import { randomUUID } from 'node:crypto';
import { archiveAvailability, clearAvailabilityArchive, retainAvailabilityArchives } from './availabilityArchive.ts';
import { readChannelObservationState, writeChannelObservationState } from './store/channelObservations.ts';
import { routingAvailability, routingConfig } from './autoRouting.ts';
import { onAvailabilityConfigChange } from './availabilityConfigEvents.ts';
import { adjustedHistory, syncAdjustmentScopes, clearHistoryAdjustments, type HistoryScope } from './availabilityAdjustments.ts';
import { AV_HISTORY_MS, AV_SAMPLE_MS, availabilityRateHistory, sampleAvailabilityInterval, type AvailabilityRateState } from './availabilityHistory.ts';
import type { Catalog, RoutePriceAvailability } from './contract.ts';
import { getModelDef } from './store/models.ts';
import { publicAvailabilityPricing } from './publicPricing.ts';

interface Tracking { active:Record<string,{identity:string;since:number;generation?:string}>; }
let tracking=readChannelObservationState<Tracking>('line-rate-tracking-v1');
let history=readChannelObservationState<AvailabilityRateState>('line-rate-history-v1')??{models:{}};
type LineCount={id:string;requests:number;success:number;failed:number;running:number;successRate:number|null;trackingSince:number};
type Snapshot={since:number;until:number;rows:LineCount[]};
let snapshot:Snapshot|undefined;
function reconcile(now:number){
 const bindings=routingAvailability(now),active:Tracking['active']={};
 for(const line of routingConfig().lines){
  if(line.members.length&&!line.members.some(member=>getModelDef(member.modelId)))continue;
  if((!line.enabled||!bindings.some(b=>b.lineId===line.id&&b.status!=='disabled'))&&!tracking?.active[line.id])continue;
  const identity=JSON.stringify([line.familyId,line.capability??'video']);
  const previous=tracking?.active[line.id];
  active[line.id]=previous?.identity===identity?previous:{identity,since:tracking?now:0};
 }
 const models=Object.fromEntries(Object.entries(history.models).filter(([id])=>active[id]&&active[id]===tracking?.active[id]));
 if(Object.keys(models).length!==Object.keys(history.models).length){history={...history,models};writeChannelObservationState('line-rate-history-v1',history);}
 const next={active};if(JSON.stringify(next)!==JSON.stringify(tracking)){tracking=next;writeChannelObservationState('line-rate-tracking-v1',tracking);}
 syncAdjustmentScopes('line:',Object.fromEntries(Object.entries(active).map(([id,t])=>['line:'+id,JSON.stringify(t)])),now);
 retainAvailabilityArchives('line:',new Set(Object.keys(active).map(id=>'line:'+id)),now);
 for(const [id,value] of Object.entries(history.models))archiveAvailability('line:'+id,value.history,now);
}
reconcile(Date.now());
onAvailabilityConfigChange(()=>{reconcile(Date.now());snapshot=undefined;});

/** Read the light request index once per minute; aggregate final requests, never averages of model rates. */
export function refreshLineAvailability(now=Date.now(),sample=false){
 reconcile(now);
 const rows=new Map<string,LineCount>(Object.entries(tracking!.active).map(([id,t])=>[id,{id,trackingSince:t.since,requests:0,success:0,failed:0,running:0,successRate:null}]));
 const logs=db.prepare('SELECT id,meta FROM logs WHERE started_at>=? AND started_at<=?').all(new Date(now-3600000).toISOString(),new Date(now).toISOString()) as {id:string;meta:string}[];
 for(const {meta} of logs){
  const log=JSON.parse(meta);if(typeof log.model!=='string'||!log.model.startsWith('route:'))continue;
  const row=rows.get(log.model.slice(6));if(!row||Date.parse(log.startedAt)<row.trackingSince)continue;
  const status=Date.parse(log.finishedAt)>now?'running':log.status;
  if(!['success','failed','running'].includes(status))continue;
  row.requests++;if(status==='success')row.success++;else if(status==='failed')row.failed++;else row.running++;
 }
 for(const row of rows.values())row.successRate=measuredSuccessRate(row.success,row.failed);
 snapshot={since:now-3600000,until:now,rows:[...rows.values()]};
 if(sample){const enabled=new Set(routingAvailability(now).filter(b=>b.status!=='disabled').map(b=>b.lineId));const until=Math.floor(now/600000)*600000;
 const records=history.lastInterval===until?[]:(db.prepare("SELECT meta FROM logs WHERE json_extract(meta,'$.finishedAt')>=? AND json_extract(meta,'$.finishedAt')<?").all(new Date(until-600000).toISOString(),new Date(until).toISOString()) as {meta:string}[]).map(({meta})=>{const l=JSON.parse(meta);return {id:typeof l.model==='string'&&l.model.startsWith('route:')?l.model.slice(6):'',startedAt:Date.parse(l.startedAt),finishedAt:Date.parse(l.finishedAt),status:l.status};});
 const next=sampleAvailabilityInterval(history,snapshot.rows.filter(r=>enabled.has(r.id)),records,now);if(next!==history){writeChannelObservationState('line-rate-history-v1',next);history=next;}for(const [id,value] of Object.entries(history.models))archiveAvailability('line:'+id,value.history,now);}
 return snapshot;
}

/** Caller supplies the already-authorized catalog and mode gates. No upstream identity or request details leave here. */
export function publicLineAvailability(catalog:Catalog,modes?:Record<string,boolean>,discount:(id:string)=>number=()=>100,now=Date.now()):RoutePriceAvailability{
 if(!snapshot||now-snapshot.until>=AV_SAMPLE_MS||snapshot.until>now)refreshLineAvailability(now);
 const stats=new Map(snapshot!.rows.map(row=>[row.id,row]));
 const rows=catalog.models.filter(m=>m.id.startsWith('route:')&&modes?.[m.modeId??m.id]!==false).flatMap(m=>{
  const stat=stats.get(m.id.slice(6));if(!stat)return [];
  const {cost,costField,costPerUnit,costRules,tokenPricing,params,refVideoSecondsWeight}=m;
  return [{...stat,id:m.id,name:catalog.modes?.find(mode=>mode.id===m.modeId)?.name??m.label,
   familyId:m.familyId??'other',familyName:catalog.families?.find(f=>f.id===m.familyId)?.name??'其他',capability:m.capability,
   history:adjustedHistory(availabilityRateHistory(history,stat.id,now),'line:'+stat.id,now),pricing:{cost,costField,costPerUnit,costRules,tokenPricing,params,refVideoSecondsWeight},discountPercent:discount(m.id)}];
 });
 return {since:snapshot!.since,until:snapshot!.until,historyWindowMs:AV_HISTORY_MS,rows:rows.map(publicAvailabilityPricing)};
}
export function lineHistoryScope(id:string,now=Date.now()):HistoryScope{
 reconcile(now);const t=tracking?.active[id];
 return {scope:'line:'+id,epoch:JSON.stringify(t)??'',active:!!t&&routingAvailability(now).some(b=>b.lineId===id&&b.status!=='disabled'),history:availabilityRateHistory(history,id,now)};
}
export function resetLineRateHistory(id:string,now=Date.now()){
 if(!routingConfig().lines.some(l=>l.id===id))throw new Error('线路不存在');
 const scope=lineHistoryScope(id,now),models={...history.models};delete models[id];
 const nextHistory={...history,models},nextTracking={active:{...tracking!.active}};
 if(nextTracking.active[id])nextTracking.active[id]={...nextTracking.active[id],generation:randomUUID()};
 db.exec('BEGIN IMMEDIATE');
 try{clearAvailabilityArchive(scope.scope);clearHistoryAdjustments(scope.scope,scope.history,now);writeChannelObservationState('line-rate-history-v1',nextHistory);writeChannelObservationState('line-rate-tracking-v1',nextTracking);db.exec('COMMIT');}
 catch(e){db.exec('ROLLBACK');throw e;}
 history=nextHistory;tracking=nextTracking;
}
function tick(){try{refreshLineAvailability(Date.now(),true);}catch(e){console.error('[line-availability] refresh failed',e instanceof Error?e.message:String(e));}}
const initial=setTimeout(tick,1000);initial.unref();
const interval=setInterval(tick,AV_SAMPLE_MS);interval.unref();
export function stopLineAvailabilityBackground(){clearTimeout(initial);clearInterval(interval);}
