import {describe,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({ps:{} as any,rtc:{} as any,psListeners:[] as any[],rtcListeners:[] as any[]}));
vi.mock('@/store/projectStore',()=>({useProjectStore:{getState:()=>h.ps,subscribe:(f:any)=>{h.psListeners.push(f);return ()=>{h.psListeners=h.psListeners.filter(x=>x!==f)}}},resolveEpisodeKey:(id:any)=>id}));
vi.mock('@/store/rtcStore',()=>({useRtcStore:{getState:()=>h.rtc,subscribe:(f:any)=>{h.rtcListeners.push(f);return ()=>{h.rtcListeners=h.rtcListeners.filter(x=>x!==f)}}}}));
vi.mock('@/rtc/panel/freeGenActions',()=>({resumeFreeGens:()=>{}}));
vi.mock('@/rtc/panel/rtcQueueStore',()=>({useRtcQueueStore:{getState:()=>({setInfo:()=>{}})}}));
import {scanPlaceholders,initRtcGenWatch,isPlaceholderArmed} from '@/rtc/panel/placeholderSwap';
import {liveSegment,landMedia} from '@/rtc/panel/rtcGenSink';
const doc=(segments:any[])=>({tracks:[{id:'track',segments}]});
const placeholder=()=>({id:'seg-A',kind:'placeholder',genKind:'video',status:'running',taskRef:'pending-A',targetStartUs:0,targetDurationUs:5000000});
const notify=()=>[...h.psListeners].forEach(f=>f(h.ps));
function init(){
 h.ps={projectInstanceId:'project',rtcEpisodeId:'ep-B',episodes:[{id:'ep-A',shots:[{id:'shot-A',videoUris:[]}]}],rtcDocs:{'ep-A':doc([placeholder()]),'ep-B':doc([])},pendingGens:[{id:'pending-A',status:'running',shot:{episodeId:'ep-A',shotId:'shot-A',field:'video'}}],setRtcEpisodeDoc:(key:string,value:any)=>{h.ps.rtcDocs={...h.ps.rtcDocs,[key]:value};notify()},blobByUri:()=>undefined};
 h.rtc={doc:h.ps.rtcDocs['ep-B'],commit:(fn:any)=>{h.rtc.doc=fn(h.rtc.doc)},patchSilent:(fn:any)=>{h.rtc.doc=fn(h.rtc.doc)}};
}
describe('delivery audit reproduction only - zero network',()=>{
 it('reopen on B, task from A finishes before visiting A: history has output but placeholder fails',()=>{
 init();initRtcGenWatch();
 expect(isPlaceholderArmed('seg-A')).toBe(false);
 // The generation queue resumes all project pending tasks, writes history then removes the pending record.
 h.ps.episodes[0].shots[0].videoUris=['https://mock.invalid/completed-A.mp4'];h.ps.pendingGens=[];notify();
 h.ps.rtcEpisodeId='ep-A';h.rtc.doc=h.ps.rtcDocs['ep-A'];scanPlaceholders();
 const s=liveSegment('seg-A');
 expect(s?.kind).toBe('placeholder');expect(s?.status).toBe('failed');
 expect(s?.error).toContain('结果没能自动落位');
 expect(h.ps.episodes[0].shots[0].videoUris).toHaveLength(1);
 });
 it('sink does not resolve or land a placeholder stored in a compound child document',()=>{
 init();h.rtc.doc={...doc([]),subDocs:{sub:{tracks:doc([placeholder()]).tracks}}};h.ps.rtcDocs={};
 expect(liveSegment('seg-A')).toBeNull();
 landMedia('seg-A',{media:'video',uri:'https://mock.invalid/result.mp4',owner:'project'});
 expect(h.rtc.doc.subDocs.sub.tracks[0].segments[0].kind).toBe('placeholder');
 });
});
