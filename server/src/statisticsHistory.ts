import { measuredSuccessRate, type AvailabilityRatePoint } from './availabilityHistory.ts';

export interface ProjectedHistoryRecord {startedAt:number;finishedAt:number;status:string;ruleId?:string;}
/** Recalculate only the display of recorded intervals. Raw snapshots and manual edits stay intact. */
export function statisticsHistory(points:AvailabilityRatePoint[],records:ProjectedHistoryRecord[],trackingSince=0):AvailabilityRatePoint[]{
 return points.map(point=>{
  const matching=records.filter(r=>r.startedAt>=trackingSince&&r.finishedAt>=point.since&&r.finishedAt<point.until);
  if(!matching.some(r=>r.ruleId))return point;
  let success=0,failed=0,excluded=0;
  for(const r of matching){if(r.status==='success')success++;else if(r.status==='failed')failed++;else if(r.status==='excluded')excluded++;}
  const rate=measuredSuccessRate(success,failed);
  return {...point,successRate:rate??.8,validSamples:rate===null?0:1,hasRequests:matching.length>0,completedRequests:success+failed,insufficientSamples:rate===null,method:'interval',excluded,rulesApplied:true};
 });
}
