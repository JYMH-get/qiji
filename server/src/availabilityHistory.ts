export const MIN_SUCCESS_RATE_REQUESTS = 10;
export const measuredSuccessRate = (success:number, failed:number):number|null => success + failed >= MIN_SUCCESS_RATE_REQUESTS ? success / (success + failed) : null;
/** Ten minute snapshots of the existing rolling-hour rate; never request-weighted. */
export const AV_SAMPLE_MS = 60_000;
export const AV_SAMPLES_PER_POINT = 10;
export const AV_HISTORY_POINTS = 60;
export const AV_HISTORY_MS = AV_SAMPLE_MS * AV_SAMPLES_PER_POINT * AV_HISTORY_POINTS;

export interface AvailabilityRatePoint {
 since:number; until:number; successRate:number|null; validSamples:number; hasRequests:boolean;
 insufficientSamples?:boolean; completedRequests?:number; method?:'interval';
 excluded?:number; rulesApplied?:boolean;
}
interface PendingRate {
 since:number; until:number; samples:number; sum:number; validSamples:number; hasRequests:boolean;
}
export interface AvailabilityRateState {
 lastMinute?:number;
 lastInterval?:number;
 models:Record<string,{history:AvailabilityRatePoint[];pending?:PendingRate}>;
}

/** Finalized requests belong to exactly one non-overlapping ten-minute interval. */
export function sampleAvailabilityInterval(state:AvailabilityRateState, rows:{id:string;trackingSince?:number|null}[], records:{id:string;startedAt:number;finishedAt:number;status:string}[], now:number):AvailabilityRateState {
 const until=Math.floor(now/600_000)*600_000, since=until-600_000;
 if(state.lastInterval!==undefined&&state.lastInterval>=until)return state;
 const models:AvailabilityRateState['models']={};
 for(const [id,value] of Object.entries(state.models))models[id]={history:value.history.filter(p=>p.until>now-AV_HISTORY_MS&&p.until<=now)};
 for(const row of rows){
  if((row.trackingSince??0)>=until)continue;
  const matching=records.filter(r=>r.id===row.id&&r.startedAt>=(row.trackingSince??0)&&r.finishedAt>=Math.max(since,row.trackingSince??0)&&r.finishedAt<until);
  const success=matching.filter(r=>r.status==='success').length,failed=matching.filter(r=>r.status==='failed').length;
  const rate=measuredSuccessRate(success,failed);
  const point:AvailabilityRatePoint={since:Math.max(since,row.trackingSince??0),until,successRate:rate??.8,validSamples:rate===null?0:1,
   hasRequests:matching.length>0,insufficientSamples:rate===null,completedRequests:success+failed,method:'interval'};
  models[row.id]={history:[...(models[row.id]?.history??[]).filter(p=>p.until!==until),point].slice(-AV_HISTORY_POINTS)};
 }
 return {lastMinute:Math.floor(now/AV_SAMPLE_MS),lastInterval:until,models};
}
interface RateSample { id:string; requests:number; successRate:number|null; trackingSince?:number|null; }

/** Called only by the background sampler. Repeated reads within a minute cannot advance it. */
export function sampleAvailabilityRates(state:AvailabilityRateState,rows:RateSample[],now:number,preserveInactive=false):AvailabilityRateState {
 const minute=Math.floor(now/AV_SAMPLE_MS);
 if(state.lastMinute!==undefined&&minute<=state.lastMinute)return state;
 const models:AvailabilityRateState['models']={};
 if(preserveInactive)for(const [id,previous] of Object.entries(state.models))models[id]={history:previous.history.filter(p=>p.until>now-AV_HISTORY_MS&&p.until<=now)};
 for(const row of rows){
  const previous=state.models[row.id];
  const history=(previous?.history??[]).filter(p=>p.until>now-AV_HISTORY_MS&&p.until<=now);
  // Downtime is missing measurement, not a zero-request blue point. Start a fresh group after a gap.
  const old=previous?.pending;
  const pending:PendingRate=old&&Math.floor(old.until/AV_SAMPLE_MS)===minute-1
   ? {...old} : {since:Math.max(now-AV_SAMPLE_MS,row.trackingSince??0),until:now,samples:0,sum:0,validSamples:0,hasRequests:false};
  pending.until=now;pending.samples++;pending.hasRequests ||= row.requests>0;
  if(row.successRate!==null){pending.sum+=row.successRate;pending.validSamples++;}
  if(pending.samples===AV_SAMPLES_PER_POINT){
   history.push({since:pending.since,until:now,successRate:pending.validSamples?Number((pending.sum/pending.validSamples).toFixed(12)):null,
    validSamples:pending.validSamples,hasRequests:pending.hasRequests});
   models[row.id]={history:history.slice(-AV_HISTORY_POINTS)};
  }else models[row.id]={history,pending};
 }
 return {lastMinute:minute,models};
}

export function availabilityRateHistory(state:AvailabilityRateState,id:string,now:number) {
 return (state.models[id]?.history??[]).filter(p=>p.until>now-AV_HISTORY_MS&&p.until<=now);
}
