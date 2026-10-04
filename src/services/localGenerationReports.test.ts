import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import type {ModelAdapter} from './adapters/types';
const mock=vi.hoisted(()=>({start:vi.fn(),finish:vi.fn(),state:{serverUrl:'https://qiji.invalid',user:{id:'u1'} as {id:string}|null}}));
vi.mock('./managedClient',()=>({managedClient:{startLocalGenerationReport:mock.start,finishLocalGenerationReport:mock.finish}}));
vi.mock('@/store/connectionStore',()=>({useConnectionStore:{getState:()=>mock.state}}));
let wrap:typeof import('./localGenerationReports')['withLocalGenerationReport'];
beforeEach(async()=>{
  vi.useFakeTimers();vi.resetModules();
  const storage=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),clear:()=>storage.clear()});
  vi.stubGlobal('window',{setInterval,addEventListener:vi.fn()});
  mock.state.user={id:'u1'};
  mock.start.mockReset().mockResolvedValue({id:'log-1'});mock.finish.mockReset().mockResolvedValue({ok:true});
  wrap=(await import('./localGenerationReports')).withLocalGenerationReport;
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture() {
  const submit=vi.fn().mockResolvedValue({taskId:'dreamina|upstream-1'});
  const poll=vi.fn().mockResolvedValue({status:'failed',progress:100,error:'upstream failed'});
  const adapter=wrap({key:'dreamina-seedance-2',submit,poll} as unknown as ModelAdapter,()=>5);
  return {submit,poll,adapter};
}
const drain=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
describe('local generation reporting',()=>{
  it('acknowledges server precharge before dispatch and reports the original task id',async()=>{
    const {adapter,submit,poll}=fixture();const r=await adapter.submit({prompt:'hello'},{duration:100});
    expect(mock.start).toHaveBeenCalledWith(expect.objectContaining({params:{duration:5},variables:{prompt:'hello'}}));
    expect(mock.start.mock.invocationCallOrder[0]).toBeLessThan(submit.mock.invocationCallOrder[0]);
    await adapter.poll(r.taskId);await drain();
    expect(poll).toHaveBeenCalledWith('dreamina|upstream-1');
    expect(mock.finish).toHaveBeenCalledWith('log-1',{status:'failed',taskId:'dreamina|upstream-1',error:'upstream failed'});
    await adapter.poll(r.taskId);expect(mock.finish).toHaveBeenCalledTimes(1);
  });
  it('precharge rejection never dispatches',async()=>{
    mock.start.mockRejectedValue(Object.assign(new Error('insufficient'),{status:402}));const {adapter,submit}=fixture();
    await expect(adapter.submit({prompt:'x'},{})).rejects.toThrow('insufficient');expect(submit).not.toHaveBeenCalled();expect(mock.finish).not.toHaveBeenCalled();
  });
  it('submission failure is reported for refund',async()=>{
    const {adapter,submit}=fixture();submit.mockRejectedValue(new Error('CLI rejected'));
    await expect(adapter.submit({prompt:'x'},{})).rejects.toThrow('CLI rejected');await drain();
    expect(mock.finish).toHaveBeenCalledWith('log-1',{status:'failed',error:'CLI rejected'});
  });
  it('lost connection does not invent an upstream failure',async()=>{
    const {adapter,poll}=fixture();poll.mockResolvedValue({status:'lost',progress:100});const r=await adapter.submit({},{});
    await adapter.poll(r.taskId);expect(mock.finish).not.toHaveBeenCalled();
  });
  it('durably retries failed result uploads after reconnect',async()=>{
    mock.finish.mockRejectedValueOnce(new Error('offline'));const {adapter}=fixture();const r=await adapter.submit({},{});
    await adapter.poll(r.taskId);await drain();expect(JSON.parse(localStorage.getItem('Qiji:local-generation-report-outbox:v1')!)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);expect(mock.finish).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem('Qiji:local-generation-report-outbox:v1')!)).toEqual([]);
  });
  it('new session can complete a persisted task; another user cannot',async()=>{
    const f=fixture();const r=await f.adapter.submit({},{});
    mock.state.user={id:'u2'};expect((await f.adapter.poll(r.taskId)).status).toBe('lost');expect(f.poll).not.toHaveBeenCalled();
    mock.state.user={id:'u1'};const fresh=fixture();await fresh.adapter.poll(r.taskId);await drain();expect(mock.finish).toHaveBeenCalledTimes(1);
  });
  it('reports success without reading or uploading the video result',async()=>{
    const createElement=vi.fn(()=>{throw new Error('must not inspect media');});
    vi.stubGlobal('document',{createElement});
    const {adapter,poll}=fixture();poll.mockResolvedValue({status:'success',progress:100,resultUri:'https://video.invalid/a.mp4'});
    const r=await adapter.submit({},{});const result=await adapter.poll(r.taskId);await drain();
    expect(result.resultUri).toBe('https://video.invalid/a.mp4');
    expect(createElement).not.toHaveBeenCalled();
    expect(mock.finish).toHaveBeenCalledWith('log-1',{status:'success',taskId:'dreamina|upstream-1'});
  });
  it('uncertain admission response is resolved without sending to upstream',async()=>{
    mock.start.mockRejectedValueOnce(Object.assign(new Error('timeout'),{status:0}));const {adapter,submit}=fixture();
    await expect(adapter.submit({},{})).rejects.toThrow('timeout');await drain();
    expect(submit).not.toHaveBeenCalled();expect(mock.start).toHaveBeenCalledTimes(2);
    expect(mock.start.mock.calls[0][0].clientTaskId).toBe(mock.start.mock.calls[1][0].clientTaskId);
    expect(mock.finish).toHaveBeenCalledWith('log-1',expect.objectContaining({status:'failed'}));
  });
});
