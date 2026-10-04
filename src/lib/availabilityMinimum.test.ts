import { describe, it, expect } from 'vitest';
import { measuredSuccessRate, sampleAvailabilityRates, sampleAvailabilityInterval, type AvailabilityRateState } from '../../server/src/availabilityHistory';
import { rateBand, snapshotDescription } from './routeAvailability';
describe('minimum completed requests',()=>{
 it('suppresses zero through nine results, including all failures',()=>{ for(let n=0;n<10;n++){expect(measuredSuccessRate(0,n)).toBeNull();expect(measuredSuccessRate(n,0)).toBeNull();} });
 it('calculates from ten completed requests',()=>{expect(measuredSuccessRate(0,10)).toBe(0);expect(measuredSuccessRate(8,2)).toBe(.8);expect(measuredSuccessRate(10,0)).toBe(1);});
 it('does not include insufficient samples in snapshot averages',()=>{
 let state:AvailabilityRateState={models:{}};
 for(let i=1;i<=10;i++)state=sampleAvailabilityRates(state,[{id:'m',requests:i<6?9:10,successRate:i<6?measuredSuccessRate(0,9):measuredSuccessRate(8,2)}],i*60000);
 expect(state.models.m.history[0].successRate).toBe(.8);expect(state.models.m.history[0].validSamples).toBe(5);
 });
 it('distinguishes insufficient snapshots from no requests',()=>{expect(rateBand(null,true).label).toBe('样本不足');expect(rateBand(null).label).toBe('样本不足');expect(snapshotDescription({since:0,until:600000,successRate:null,validSamples:0,hasRequests:true})).toContain('样本不足');});
});

describe('independent intervals',()=>{
 it('uses 80 percent for low samples without counting a failure again',()=>{
  const records=[{id:'m',startedAt:1,finishedAt:599999,status:'failed'}];
  const first=sampleAvailabilityInterval({models:{}},[{id:'m'}],records,600000);
  expect(first.models.m.history[0]).toMatchObject({successRate:.8,insufficientSamples:true,completedRequests:1});
  const second=sampleAvailabilityInterval(first,[{id:'m'}],records,1200000);
  expect(second.models.m.history[1]).toMatchObject({successRate:.8,insufficientSamples:true,completedRequests:0});
  expect(sampleAvailabilityInterval(second,[{id:'m'}],records,1200001)).toBe(second);
 });
 it('counts terminal boundary once and includes long-running tasks by completion',()=>{
  const records=Array.from({length:10},()=>({id:'m',startedAt:1,finishedAt:600000,status:'failed'}));
  let s=sampleAvailabilityInterval({models:{}},[{id:'m'}],records,600000);
  expect(s.models.m.history[0].completedRequests).toBe(0);
  s=sampleAvailabilityInterval(s,[{id:'m'}],records,1200000);
  expect(s.models.m.history[1]).toMatchObject({successRate:0,insufficientSamples:false,completedRequests:10});
 });
 it('does not backfill before tracking begins or fill missing ten-hour history',()=>{
  const s=sampleAvailabilityInterval({models:{}},[{id:'m',trackingSince:700000}],[],1200000);
  expect(s.models.m.history).toHaveLength(1);expect(s.models.m.history[0].since).toBe(700000);
 });
});
