import { aggregateLineRateWindows, type LineRateLog } from './lineRateWindows.ts';
import { projectModelStatistics } from './store/modelStatisticsRules.ts';
import { statisticsHistory } from './statisticsHistory.ts';
import { db } from './store/sqlite.ts';
import { randomUUID } from 'node:crypto';
import { archiveAvailability, clearAvailabilityArchive, retainAvailabilityArchives } from './availabilityArchive.ts';
import { readChannelObservationState, writeChannelObservationState } from './store/channelObservations.ts';
import { routingAvailability, routingConfig } from './autoRouting.ts';
import { onAvailabilityConfigChange } from './availabilityConfigEvents.ts';
import { adjustedHistory, syncAdjustmentScopes, clearHistoryAdjustments, type HistoryScope } from './availabilityAdjustments.ts';
import { AV_HISTORY_MS, AV_SAMPLE_MS, availabilityRateHistory, sampleAvailabilityInterval, type AvailabilityRateState } from './availabilityHistory.ts';
import type { Catalog, RoutePriceAvailability, RouteSuccessRateWindow } from './contract.ts';
import { getModelDef } from './store/models.ts';
import { publicAvailabilityPricing } from './publicPricing.ts';

interface Tracking { active:Record<string,{identity:string;since:number;generation?:string}>; }
let tracking=readChannelObservationState<Tracking>('line-rate-tracking-v1');
let history=readChannelObservationState<AvailabilityRateState>('line-rate-history-v1')??{models:{}};
type LineCount={id:string;requests:number;success:number;failed:number;running:number;excluded:number;successRate:number|null;trackingSince:number;rateWindows:RouteSuccessRateWindow[]};
type Snapshot={since:number;until:number;rows:LineCount[]};
let snapshot:Snapshot|undefined;
let projectedHistory=new Map<string,ReturnType<typeof availabilityRateHistory>>();
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
 const logs=lineLogs('l.started_at>=? AND l.started_at<=?',[new Date(now-86400000).toISOString(),new Date(now).toISOString()],now);
 const windows=aggregateLineRateWindows(logs,tracking!.active,now);
 const rows=new Map<string,LineCount>(Object.entries(tracking!.active).map(([id,t])=>{
  const rateWindows=windows.get(id)!;
  const {requests,success,failed,running,excluded=0,successRate}=rateWindows[0];
  return [id,{id,trackingSince:t.since,requests,success,failed,running,excluded,successRate,rateWindows}];
 }));
 snapshot={since:now-3600000,until:now,rows:[...rows.values()]};
 if(sample){const enabled=new Set(routingAvailability(now).filter(b=>b.status!=='disabled').map(b=>b.lineId));const until=Math.floor(now/600000)*600000;
 const records=history.lastInterval===until?[]:(db.prepare("SELECT meta FROM logs WHERE json_extract(meta,'$.finishedAt')>=? AND json_extract(meta,'$.finishedAt')<?").all(new Date(until-600000).toISOString(),new Date(until).toISOString()) as {meta:string}[]).map(({meta})=>{const l=JSON.parse(meta);return {id:typeof l.model==='string'&&l.model.startsWith('route:')?l.model.slice(6):'',startedAt:Date.parse(l.startedAt),finishedAt:Date.parse(l.finishedAt),status:l.status};});
 const next=sampleAvailabilityInterval(history,snapshot.rows.filter(r=>enabled.has(r.id)),records,now);if(next!==history){writeChannelObservationState('line-rate-history-v1',next);history=next;}for(const [id,value] of Object.entries(history.models))archiveAvailability('line:'+id,value.history,now);}
 const historyRecords=[...lineLogs("json_extract(l.meta,'$.finishedAt')>=? AND json_extract(l.meta,'$.finishedAt')<=?",[new Date(now-AV_HISTORY_MS).toISOString(),new Date(now).toISOString()],now)];
 projectedHistory=new Map(snapshot.rows.map(row=>[row.id,statisticsHistory(availabilityRateHistory(history,row.id,now),historyRecords.filter(r=>r.model==='route:'+row.id).map(r=>({...r,startedAt:Date.parse(r.startedAt),finishedAt:Date.parse(r.finishedAt??'')})),row.trackingSince)]));
 return snapshot;
}

/** Join the immutable executed-model identity by request ID; never infer it from today's line members. */
function* lineLogs(where:string,args:string[],now:number):Generator<LineRateLog&{ruleId?:string}>{
 const rows=db.prepare(`SELECT json_extract(l.meta,'$.model') AS model,l.started_at AS startedAt,
 json_extract(l.meta,'$.status') AS status,json_extract(l.meta,'$.finishedAt') AS finishedAt,
 json_extract(l.meta,'$.durationMs') AS durationMs,o.data AS observation FROM logs l
 LEFT JOIN channel_observations o ON o.id=l.id WHERE ${where}`).iterate(...args) as Iterable<LineRateLog&{durationMs?:number;observation?:string}>;
 for(const row of rows){
  const rawStatus=Date.parse(row.finishedAt??'')>now?'running':row.status;
  const evidence=row.observation?JSON.parse(row.observation):{};
  const ms=row.durationMs??(row.finishedAt?Date.parse(row.finishedAt)-Date.parse(row.startedAt):undefined);
  const projection=projectModelStatistics({...evidence,status:rawStatus,durationMs:ms??evidence.durationMs});
  yield {model:row.model,startedAt:row.startedAt,finishedAt:row.finishedAt,...projection};
 }
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
   history:adjustedHistory(projectedHistory.get(stat.id)??availabilityRateHistory(history,stat.id,now),'line:'+stat.id,now),pricing:{cost,costField,costPerUnit,costRules,tokenPricing,params,refVideoSecondsWeight},discountPercent:discount(m.id)}];
 });
 return {since:snapshot!.since,until:snapshot!.until,historyWindowMs:AV_HISTORY_MS,rows:rows.map(publicAvailabilityPricing)};
}
export function lineHistoryScope(id:string,now=Date.now()):HistoryScope{
 reconcile(now);const t=tracking?.active[id];
 if(!snapshot||now-snapshot.until>=AV_SAMPLE_MS||snapshot.until>now)refreshLineAvailability(now);
 return {scope:'line:'+id,epoch:JSON.stringify(t)??'',active:!!t&&routingAvailability(now).some(b=>b.lineId===id&&b.status!=='disabled'),history:availabilityRateHistory(history,id,now),displayHistory:projectedHistory.get(id)};
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
 projectedHistory.delete(id);
}
function tick(){try{refreshLineAvailability(Date.now(),true);}catch(e){console.error('[line-availability] refresh failed',e instanceof Error?e.message:String(e));}}
const initial=setTimeout(tick,1000);initial.unref();
const interval=setInterval(tick,AV_SAMPLE_MS);interval.unref();
export function stopLineAvailabilityBackground(){clearTimeout(initial);clearInterval(interval);}
