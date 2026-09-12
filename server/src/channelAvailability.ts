import { IMAGE_ROUTE_FAMILIES } from './imageRouting.ts';
import { SEEDANCE_ROUTE_FAMILIES } from './contract.ts';
/** Channel/model availability. Scheduling bindings supply weight only, never request counts. */
import { db } from './store/sqlite.ts';
import { listModels, type ModelDef } from './store/models.ts';
import { listChannels } from './store/channels.ts';
import { listFamilies } from './store/families.ts';
import { routingAvailability, seedanceFamilyOf } from './autoRouting.ts';
import { routeFailureKind } from './routeObservations.ts';
import { channelObservationRows, type ChannelObservation } from './store/channelObservations.ts';

export const AV_CAPABILITIES=['image','video','text','audio'] as const;
const capabilityOf=(cap:string)=>cap==='video-enhance'||cap==='video-erase'?'video':cap;
export function availabilityFamily(m:Pick<ModelDef,'id'|'label'|'capability'|'upstreamModel'|'familyId'>,families:{id:string;name:string}[]) {
 const configured=(m.capability==='image'||m.capability==='video')?seedanceFamilyOf(m as ModelDef):m.familyId;
 if(configured)return {id:configured,name:[...families,...IMAGE_ROUTE_FAMILIES,...SEEDANCE_ROUTE_FAMILIES].find(f=>f.id===configured)?.name??'其他'};
 const text=m.upstreamModel||m.id;
 if(m.capability==='text'){
  const brands:[RegExp,string,string][]=[[/gpt|o[134](?:-|$)/i,'gpt','GPT'],[/gemini/i,'gemini','Gemini'],[/deepseek/i,'deepseek','DeepSeek'],[/claude/i,'claude','Claude'],[/qwen|千问/i,'qwen','Qwen'],[/doubao|豆包/i,'doubao','豆包'],[/glm|智谱/i,'glm','GLM']];
  const b=brands.find(([re])=>re.test(text));if(b)return{id:'text-'+b[1],name:b[2]};
 }
 return{id:capabilityOf(m.capability)+'-other',name:'其他'};
}
export function aggregateAvailability(observations:ChannelObservation[], now:number) {
 const unique=new Map(observations.filter(o=>o.startedAt<=now).map(o=>[o.id,o]));
 const recent=[...unique.values()].filter(o=>o.startedAt>=now-3600000);
 const success=recent.filter(o=>o.status==='success').length,failed=recent.filter(o=>o.status==='failed').length;
 const history=[...unique.values()].filter(o=>o.startedAt>=now-7*86400000).sort((a,b)=>b.startedAt-a.startedAt).slice(0,60).reverse();
 const last=[...unique.values()].filter(o=>o.status!=='running'&&o.failureKind!=='user').sort((a,b)=>(b.finishedAt??b.startedAt)-(a.finishedAt??a.startedAt))[0];
 return {requests:recent.length,success,failed,successRate:success+failed?success/(success+failed):null,
  active:[...unique.values()].filter(o=>o.status==='running').length,
  status:last?.status==='success'?'available':last?.failureKind==='channel'?'unavailable':last?'attention':'unknown',
  history:history.map(o=>({at:o.startedAt,status:o.status,failureKind:o.failureKind,durationMs:o.finishedAt==null?null:Math.max(0,o.finishedAt-o.startedAt)}))};
}
export function channelAvailability(now=Date.now()) {
 const models=listModels().filter(m=>!m.hidden&&!['echo','stub'].includes(m.protocol)&&AV_CAPABILITIES.includes(capabilityOf(m.capability) as any));
 const channels=listChannels(),families=listFamilies(),bindings=routingAvailability(now);
 const observations=channelObservationRows(now-7*86400000,now),seen=new Set(observations.map(o=>o.id));
 // Old rows with an upstream receipt or routing identity remain visible; one request id is counted once.
 const legacy=db.prepare(`SELECT l.id,l.meta,r.data AS routing,
 json_extract(d.detail,'$.routing.modelId') AS routed_model,json_extract(d.detail,'$.routing.channelId') AS routed_channel,
 json_type(d.detail,'$.upstreamRequest') AS sent,json_type(d.detail,'$.upstreamResponse') AS received
 FROM logs l LEFT JOIN route_observations r ON r.id=l.id LEFT JOIN log_details d ON d.id=l.id
 WHERE l.started_at<=? AND (l.started_at>=? OR json_extract(l.meta,'$.status')='running')`).all(new Date(now).toISOString(),new Date(now-7*86400000).toISOString()) as any[];
 for(const row of legacy){
  if(seen.has(row.id)||(!row.routing&&!row.sent&&!row.received))continue;
  const l=JSON.parse(row.meta),r=row.routing?JSON.parse(row.routing):undefined;
  const m=models.find(m=>m.id===(r?.modelId??row.routed_model??l.model));if(!m)continue;
  observations.push({id:l.id,modelId:m.id,modelName:m.label,channelId:r?.channelId??row.routed_channel??m.channelId??'',capability:m.capability,familyId:m.familyId,
   startedAt:Date.parse(l.startedAt),finishedAt:l.finishedAt?Date.parse(l.finishedAt):undefined,status:l.status,failureKind:r?.failureKind??(l.status==='failed'?routeFailureKind(l.error):undefined)});seen.add(row.id);
 }
 const rows=new Map<string,any>();
 const add=(m:Pick<ModelDef,'id'|'label'|'capability'|'familyId'|'upstreamModel'>,channelId:string,enabled:boolean)=>{
  const key=JSON.stringify([channelId,m.id]);if(rows.has(key))return key;
  const family=availabilityFamily(m,families),weights=bindings.filter(b=>b.modelId===m.id&&b.channelId===channelId);
  const distinct=(field:'concurrencyWeight'|'effectiveWeight')=>[...new Set(weights.map(w=>w[field]))].sort((a,b)=>a-b);
  rows.set(key,{id:key,modelId:m.id,modelName:m.label,channelId,channelName:channels.find(c=>c.id===channelId)?.name??(channelId||'默认网关'),
   capability:capabilityOf(m.capability),familyId:family.id,familyName:family.name,enabled,configuredWeights:distinct('concurrencyWeight'),effectiveWeights:distinct('effectiveWeight'),samples:[]});return key;
 };
 for(const m of models)add(m,m.channelId??'',m.enabled&&(m.channelId?!!channels.find(c=>c.id===m.channelId)?.enabled:true));
 for(const o of observations){
  if(!AV_CAPABILITIES.includes(capabilityOf(o.capability) as any))continue;
  const m=models.find(m=>m.id===o.modelId);
  const key=add(m??{id:o.modelId,label:o.modelName,capability:o.capability as any,familyId:o.familyId},o.channelId,!!m?.enabled&&(o.channelId?!!channels.find(c=>c.id===o.channelId)?.enabled:true));
  rows.get(key).samples.push(o);
 }
 return{since:now-3600000,until:now,historyDays:7,rows:[...rows.values()].map(({samples,...row})=>{
  const stat=aggregateAvailability(samples,now);return{...row,...stat,status:row.enabled?stat.status:'disabled'};
 })};
}
