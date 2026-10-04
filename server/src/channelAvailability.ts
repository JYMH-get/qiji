import { measuredSuccessRate } from './availabilityHistory.ts';
import { IMAGE_ROUTE_FAMILIES } from './imageRouting.ts';
import { SEEDANCE_ROUTE_FAMILIES } from './contract.ts';
import { MODEL_CATEGORIES, modelCategory, PROCESSING_CAPABILITY_NAMES } from './modelCategory.ts';
/** Channel/model availability. Scheduling bindings supply weight only, never request counts. */
import { db } from './store/sqlite.ts';
import { randomUUID } from 'node:crypto';
import { archiveAvailability, clearAvailabilityArchive, retainAvailabilityArchives, AV_RETENTION_MS } from './availabilityArchive.ts';
import { listModels, type ModelDef } from './store/models.ts';
import { listChannels } from './store/channels.ts';
import { listFamilies } from './store/families.ts';
import { routingAvailability, routingEnabled, routingVersion, seedanceFamilyOf } from './autoRouting.ts';
import { onAvailabilityConfigChange } from './availabilityConfigEvents.ts';
import { adjustedHistory, syncAdjustmentScopes, clearHistoryAdjustments, type HistoryScope } from './availabilityAdjustments.ts';
import { routeFailureKind } from './routeObservations.ts';
import { AV_HISTORY_POINTS, AV_HISTORY_MS, AV_SAMPLE_MS, AV_SAMPLES_PER_POINT, availabilityRateHistory, sampleAvailabilityInterval, type AvailabilityRateState } from './availabilityHistory.ts';
import { channelObservationRows, channelObservationRevision, importChannelObservation, readChannelObservationState, writeChannelObservationState, type ChannelObservation } from './store/channelObservations.ts';

export const AV_CAPABILITIES=MODEL_CATEGORIES;
const capabilityOf=modelCategory;
function directModelEnabled(model:Pick<ModelDef,'enabled'|'channelId'>|undefined,channels:ReturnType<typeof listChannels>){
 return !!model?.enabled&&(!model.channelId||channels.some(channel=>channel.id===model.channelId&&channel.enabled));
}
export function availabilityFamily(m:Pick<ModelDef,'id'|'label'|'capability'|'upstreamModel'|'familyId'>,families:{id:string;name:string}[]) {
 const configured=(m.capability==='image'||m.capability==='video')?seedanceFamilyOf(m as ModelDef):m.familyId;
 if(configured)return {id:configured,name:[...families,...IMAGE_ROUTE_FAMILIES,...SEEDANCE_ROUTE_FAMILIES].find(f=>f.id===configured)?.name??'其他'};
 const text=m.upstreamModel||m.id;
 if(m.capability==='text'){
  const brands:[RegExp,string,string][]=[[/gpt|o[134](?:-|$)/i,'gpt','GPT'],[/gemini/i,'gemini','Gemini'],[/deepseek/i,'deepseek','DeepSeek'],[/claude/i,'claude','Claude'],[/qwen|千问/i,'qwen','Qwen'],[/doubao|豆包/i,'doubao','豆包'],[/glm|智谱/i,'glm','GLM']];
  const b=brands.find(([re])=>re.test(text));if(b)return{id:'text-'+b[1],name:b[2]};
 }
 const processingName=PROCESSING_CAPABILITY_NAMES[m.capability];
 if(processingName)return{id:m.capability,name:processingName};
 return{id:capabilityOf(m.capability)+'-other',name:'其他'};
}
export function aggregateAvailability(observations:ChannelObservation[], now:number) {
 const unique=new Map(observations.filter(o=>o.startedAt<=now).map(o=>[o.id,o]));
 const recent=[...unique.values()].filter(o=>o.startedAt>=now-3600000);
 const success=recent.filter(o=>o.status==='success').length,failed=recent.filter(o=>o.status==='failed').length;
 const last=[...unique.values()].filter(o=>o.status!=='running'&&o.failureKind!=='user').sort((a,b)=>(b.finishedAt??b.startedAt)-(a.finishedAt??a.startedAt))[0];
 return {requests:recent.length,success,failed,successRate:measuredSuccessRate(success,failed),
  active:[...unique.values()].filter(o=>o.status==='running').length,
  status:last?.status==='success'?'available':last?.failureKind==='channel'?'unavailable':last?'attention':'unknown'};
}
function buildChannelAvailability(now=Date.now()) {
 const models=listModels().filter(m=>!['echo','stub'].includes(m.protocol)&&AV_CAPABILITIES.includes(capabilityOf(m.capability) as any));
 const channels=listChannels(),families=listFamilies(),bindings=routingAvailability(now);
 reconcileRateTracking(now);
 const observations=channelObservationRows(now-7*86400000,now);
 const rows=new Map<string,any>();
 const add=(m:Pick<ModelDef,'id'|'label'|'capability'|'familyId'|'upstreamModel'>,channelId:string,enabled:boolean)=>{
  const key=JSON.stringify([channelId,m.id]);if(rows.has(key))return key;
  const family=availabilityFamily(m,families),weights=bindings.filter(b=>b.modelId===m.id&&b.channelId===channelId);
  const distinct=(field:'concurrencyWeight'|'effectiveWeight')=>[...new Set(weights.map(w=>w[field]))].sort((a,b)=>a-b);
  const configured=models.find(model=>model.id===m.id),channelOrder=channels.findIndex(c=>c.id===channelId);
  rows.set(key,{id:key,modelId:m.id,modelName:m.label,channelId,channelName:channels.find(c=>c.id===channelId)?.name??(channelId||'默认网关'),
   channelOrder:channelOrder<0?Number.MAX_SAFE_INTEGER:channelOrder,modelOrder:configured?(configured.order??models.indexOf(configured)):Number.MAX_SAFE_INTEGER,configured:!!configured,hidden:!!configured?.hidden,
   capability:capabilityOf(m.capability),modelCapability:m.capability,familyId:family.id,familyName:family.name,enabled,configuredWeights:distinct('concurrencyWeight'),effectiveWeights:distinct('effectiveWeight'),samples:[]});return key;
 };
 for(const m of models)add(m,m.channelId??'',routingEnabled()?bindings.some(b=>b.modelId===m.id&&b.status!=='disabled'):directModelEnabled(m,channels));
 for(const o of observations){
  const key=JSON.stringify([o.channelId,o.modelId]),tracking=rateTracking?.active[key];
  // Old/deleted model observations remain auditable, but cannot recreate cards or a new activation's rate.
  if(!tracking||o.startedAt<tracking.since)continue;
  rows.get(key)?.samples.push(o);
 }
 return{since:now-3600000,until:now,historyWindowMs:AV_HISTORY_MS,historyLimit:AV_HISTORY_POINTS,samplesPerPoint:AV_SAMPLES_PER_POINT,rows:[...rows.values()].map(({samples,...row})=>{
  const stat=aggregateAvailability(samples,now);return{...row,...stat,trackingSince:rateTracking?.active[row.id]?.since??null,status:row.enabled?stat.status:'disabled'};
 })};
}

interface BackfillState { cursor:number; upper:number; since:number; done:boolean; }
/** One bounded batch, independent of the HTTP request. The cursor survives server restarts. */
export function backfillChannelObservations(now=Date.now(),batchSize=20) {
 let state=readChannelObservationState<BackfillState>('legacy-v1');
 if(!state){const upper=Number((db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM logs').get() as {n:number}).n);state={cursor:0,upper,since:now-7*86400000,done:!upper};}
 if(state.done)return state;
 const records=db.prepare(`SELECT rowid AS cursor,id,meta FROM logs WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`).all(state.cursor,state.upper,batchSize) as {cursor:number;id:string;meta:string}[];
 const models=new Map(listModels().map(m=>[m.id,m]));
 const seen=db.prepare('SELECT 1 FROM channel_observations WHERE id=?');
 const route=db.prepare('SELECT data FROM route_observations WHERE id=?');
 const detail=db.prepare(`SELECT json_extract(detail,'$.routing.modelId') AS modelId,json_extract(detail,'$.routing.channelId') AS channelId,
 json_type(detail,'$.upstreamRequest') AS sent,json_type(detail,'$.upstreamResponse') AS received FROM log_details WHERE id=?`);
 for(const row of records){
  state.cursor=Number(row.cursor);if(seen.get(row.id))continue;
  const l=JSON.parse(row.meta),startedAt=Date.parse(l.startedAt);
  if(!Number.isFinite(startedAt)||startedAt>now||(startedAt<state.since&&l.status!=='running'))continue;
  const rrow=route.get(row.id) as {data:string}|undefined,r=rrow?JSON.parse(rrow.data):undefined;
  const d=r?undefined:detail.get(row.id) as {modelId?:string;channelId?:string;sent?:string;received?:string}|undefined;
  if(!r&&!d?.sent&&!d?.received)continue;
  const modelId=r?.modelId??d?.modelId??l.model,m=models.get(modelId);
  const capability=m?.capability??l.capability??(l.purpose?.includes('video')?'video':undefined);
  if(!capability||!AV_CAPABILITIES.includes(capabilityOf(capability) as any)||!['running','success','failed'].includes(l.status))continue;
  importChannelObservation({id:row.id,modelId,modelName:m?.label??r?.modelName??modelId,channelId:r?.channelId??d?.channelId??m?.channelId??'',capability,familyId:m?.familyId,
   startedAt,finishedAt:l.finishedAt?Date.parse(l.finishedAt):undefined,status:l.status,failureKind:r?.failureKind??(l.status==='failed'?routeFailureKind(l.error,row.id):undefined)});
 }
 state.done=records.length<batchSize||state.cursor>=state.upper;
 writeChannelObservationState('legacy-v1',state);return state;
}

let rateHistory=readChannelObservationState<AvailabilityRateState>('rate-history-v1')??{models:{}};
// The legacy key "active" now retains tracked identities while they are paused.
interface RateTrackingState { active:Record<string,{identity:string;since:number;generation?:string}>; }
let rateTracking=readChannelObservationState<RateTrackingState>('rate-tracking-v1');
function reconcileRateTracking(now:number,reset:{resetModelId?:string;resetChannelId?:string}={}) {
 const channels=listChannels(),models=listModels(),bindings=routingAvailability(now);
 const active:RateTrackingState['active']={};
 for(const m of models){
  if(['echo','stub'].includes(m.protocol)||!AV_CAPABILITIES.includes(capabilityOf(m.capability) as any))continue;
  const channelId=m.channelId??'',key=JSON.stringify([channelId,m.id]);
  const enabled=routingEnabled()?bindings.some(b=>b.modelId===m.id&&b.channelId===channelId&&b.status!=='disabled'):directModelEnabled(m,channels);
  if(!enabled&&!rateTracking?.active[key])continue;
  const identity=JSON.stringify([m.createdAt,channels.find(c=>c.id===channelId)?.createdAt]);
  const previous=rateTracking?.active[key];
  const restart=reset.resetModelId===m.id||reset.resetChannelId===channelId;
  active[key]=previous?.identity===identity&&!restart?previous:{identity,since:rateTracking||restart?now:0};
 }
 const historyModels=Object.fromEntries(Object.entries(rateHistory.models).filter(([key])=>active[key]&&active[key]===rateTracking?.active[key]));
 if(Object.keys(historyModels).length!==Object.keys(rateHistory.models).length){
  const next={...rateHistory,models:historyModels};writeChannelObservationState('rate-history-v1',next);rateHistory=next;
 }
 const next={active};
 if(JSON.stringify(next)!==JSON.stringify(rateTracking)){writeChannelObservationState('rate-tracking-v1',next);rateTracking=next;}
 syncAdjustmentScopes('model:',Object.fromEntries(Object.entries(active).map(([key,t])=>['model:'+JSON.parse(key)[1],JSON.stringify(t)])),now);
 retainAvailabilityArchives('model:',new Set(Object.keys(active).map(key=>'model:'+JSON.parse(key)[1])),now);
 for(const [key,value] of Object.entries(rateHistory.models))archiveAvailability('model:'+JSON.parse(key)[1],value.history,now);
}
function withRateHistory(summary:ReturnType<typeof buildChannelAvailability>){
 return {...summary,rows:summary.rows.map(row=>({...row,history:adjustedHistory(availabilityRateHistory(rateHistory,row.id,summary.until),'model:'+row.modelId,summary.until)}))};
}
export function modelHistoryScope(modelId:string,now=Date.now()):HistoryScope{
 reconcileRateTracking(now);
 const model=listModels().find(m=>m.id===modelId),id=JSON.stringify([model?.channelId??'',modelId]),t=rateTracking?.active[id];
 return {scope:'model:'+modelId,epoch:JSON.stringify(t)??'',active:!!t&&(routingEnabled()?routingAvailability(now).some(b=>b.modelId===modelId&&b.status!=='disabled'):directModelEnabled(model,listChannels())),history:availabilityRateHistory(rateHistory,id,now)};
}
export function resetModelRateHistory(modelId:string,now=Date.now()){
 const model=listModels().find(m=>m.id===modelId);if(!model)throw new Error('模型不存在');
 const key=JSON.stringify([model.channelId??'',modelId]),scope=modelHistoryScope(modelId,now);
 const models={...rateHistory.models};delete models[key];
 const nextHistory={...rateHistory,models},nextTracking={active:{...rateTracking!.active}};
 if(nextTracking.active[key])nextTracking.active[key]={...nextTracking.active[key],generation:randomUUID()};
 db.exec('BEGIN IMMEDIATE');
 try{clearAvailabilityArchive(scope.scope);clearHistoryAdjustments(scope.scope,scope.history,now);writeChannelObservationState('rate-history-v1',nextHistory);writeChannelObservationState('rate-tracking-v1',nextTracking);db.exec('COMMIT');}
 catch(e){db.exec('ROLLBACK');throw e;}
 rateHistory=nextHistory;rateTracking=nextTracking;snapshot=undefined;snapshotConfig='';
 db.prepare('DELETE FROM channel_observation_state WHERE name=?').run('snapshot-v3');
}
type AvailabilitySnapshot=ReturnType<typeof withRateHistory>;
let snapshot=readChannelObservationState<AvailabilitySnapshot>('snapshot-v3');
let snapshotRevision=-1,snapshotConfig='',refreshTimer:ReturnType<typeof setTimeout>|undefined,backfillTimer:ReturnType<typeof setTimeout>|undefined;
let sampleOnRefresh=false;
const configStamp=()=>JSON.stringify([routingVersion(),listModels().map(m=>[m.id,m.createdAt,m.updatedAt,m.order]),listChannels().map(c=>[c.id,c.createdAt,c.updatedAt,c.order]),listFamilies()]);
// Establish the current route membership before any later configuration event can re-enable a model.
reconcileRateTracking(Date.now());
onAvailabilityConfigChange(change=>{
 reconcileRateTracking(Date.now(),change);
 snapshot=undefined;snapshotConfig='';
 db.prepare('DELETE FROM channel_observation_state WHERE name=?').run('snapshot-v3');
});
/** The snapshot contains no request contents, user data, URLs or credentials. */
export function refreshChannelAvailability(now=Date.now(),sample=false) {
 const summary=buildChannelAvailability(now);
 // Do not freeze incomplete legacy backfill counts into a permanent rate history.
 if(sample&&readChannelObservationState<BackfillState>('legacy-v1')?.done){
  const until=Math.floor(now/600000)*600000;
  const records=rateHistory.lastInterval===until?[]:(db.prepare('SELECT data FROM channel_observations WHERE finished_at>=? AND finished_at<?').all(until-600000,until) as {data:string}[]).map(({data})=>{const o=JSON.parse(data);return {id:JSON.stringify([o.channelId,o.modelId]),startedAt:o.startedAt,finishedAt:o.finishedAt??o.startedAt,status:o.status};});
  const next=sampleAvailabilityInterval(rateHistory,summary.rows.filter(row=>row.enabled),records,now);
  if(next!==rateHistory){writeChannelObservationState('rate-history-v1',next);rateHistory=next;}
  for(const [key,value] of Object.entries(rateHistory.models))archiveAvailability('model:'+JSON.parse(key)[1],value.history,now);
 }
 snapshot=withRateHistory(summary);snapshotRevision=channelObservationRevision();snapshotConfig=configStamp();
 writeChannelObservationState('snapshot-v3',snapshot);return snapshot;
}
function scheduleAvailabilityRefresh(sample=false){
 sampleOnRefresh ||= sample;
 if(refreshTimer)return;
 refreshTimer=setTimeout(()=>{refreshTimer=undefined;const capture=sampleOnRefresh;sampleOnRefresh=false;try{refreshChannelAvailability(Date.now(),capture);}catch(e){console.error('[availability] summary refresh failed',e instanceof Error?e.message:String(e));}},25);refreshTimer.unref();
}
function scheduleLegacyBackfill(){
 if(backfillTimer||readChannelObservationState<BackfillState>('legacy-v1')?.done)return;
 backfillTimer=setTimeout(()=>{
  backfillTimer=undefined;
  try{const state=backfillChannelObservations();if(state.done)scheduleAvailabilityRefresh();else scheduleLegacyBackfill();}
  catch(e){console.error('[availability] legacy backfill failed',e instanceof Error?e.message:String(e));}
 },25);backfillTimer.unref();
}
export interface AvailabilityRange {since:number;until:number;label:string;}
export function parseAvailabilityRange(query:Record<string,unknown>,now=Date.now()):AvailabilityRange{
 const windows:Record<string,number>={'1h':3600000,'5h':5*3600000,'24h':86400000,'3d':3*86400000,'7d':7*86400000};
 const labels:Record<string,string>={'1h':'近1小时','5h':'近5小时','24h':'近24小时','3d':'近3天','7d':'近7天'};
 if(query.since!==undefined||query.until!==undefined){
  const since=typeof query.since==='string'?Date.parse(query.since):NaN,until=typeof query.until==='string'?Date.parse(query.until):NaN;
  if(!Number.isFinite(since)||!Number.isFinite(until)||since>=until||until>now||since<now-AV_RETENTION_MS)throw new Error('请选择近60天内有效的起止时间，结束时间不能晚于当前时间');
  return {since,until,label:'所选时段'};
 }
 const window=typeof query.window==='string'?query.window:'1h';if(!Object.hasOwn(windows,window))throw new Error('不支持的统计时长');
 return {since:now-windows[window],until:now,label:labels[window]};
}
function rangeCounts(rows:AvailabilitySnapshot['rows'],range:AvailabilityRange,now:number){
 const observations=channelObservationRows(range.since,now),counts=new Map<string,{requests:number;success:number;failed:number}>();
 for(const o of observations){
  if(o.startedAt<range.since||o.startedAt>range.until)continue;
  const key=JSON.stringify([o.channelId,o.modelId]),tracked=rateTracking?.active[key];if(!tracked||o.startedAt<tracked.since)continue;
  const n=counts.get(key)??{requests:0,success:0,failed:0};n.requests++;if(o.status==='success')n.success++;else if(o.status==='failed')n.failed++;counts.set(key,n);
 }
 return rows.map(row=>{const n=counts.get(row.id)??{requests:0,success:0,failed:0};return{...row,...n,successRate:measuredSuccessRate(n.success,n.failed)};});
}
export function channelAvailability(now=Date.now(),range?:AvailabilityRange) {
 scheduleLegacyBackfill();
 const configChanged=snapshotConfig!==configStamp();
 const changed=snapshotRevision!==channelObservationRevision();
 if(!snapshot||configChanged)refreshChannelAvailability(now);
 else if(changed||now-snapshot.until>=60000||snapshot.until>now)scheduleAvailabilityRefresh();
 return {...snapshot!,...(range?{rows:rangeCounts(snapshot!.rows,range,now),statsSince:range.since,statsUntil:range.until,statsLabel:range.label}:{}),refreshing:!!refreshTimer,backfilling:!readChannelObservationState<BackfillState>('legacy-v1')?.done};
}
/** Start after imports finish so logs and its compatibility migrations exist first. */
const initial=setTimeout(()=>{scheduleLegacyBackfill();scheduleAvailabilityRefresh(true);},1000);initial.unref();
const interval=setInterval(()=>{scheduleLegacyBackfill();scheduleAvailabilityRefresh(true);},AV_SAMPLE_MS);interval.unref();
export function stopChannelAvailabilityBackground(){clearTimeout(initial);clearInterval(interval);if(refreshTimer)clearTimeout(refreshTimer);if(backfillTimer)clearTimeout(backfillTimer);refreshTimer=undefined;backfillTimer=undefined;sampleOnRefresh=false;}
