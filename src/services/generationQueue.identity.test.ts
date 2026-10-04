import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({state:{} as any,run:vi.fn(),download:vi.fn(),track:vi.fn(),stored:new Map<string,string>(),writer:true}));
vi.mock('@/store/projectStore',()=>({useProjectStore:{getState:()=>h.state}}));
vi.mock('./purposeRunner',()=>({runPurpose:h.run}));
vi.mock('./taskCenter',()=>({trackTask:h.track}));
vi.mock('./assetPersist',()=>({saveRemoteAsset:h.download,uploadBlobToOss:vi.fn(async b=>b)}));
vi.mock('./managedClient',()=>({managedClient:{rehost:vi.fn()}}));
vi.mock('@/lib/presetSchemes',()=>({resolvePresets:(p:string)=>p}));
vi.mock('./windowSync',()=>({isProjectWriter:()=>h.writer}));
import {startGeneration,startShotGeneration,retryGeneration,resumePendingGenerations} from './generationQueue';
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const result={status:'success',resultUri:'https://fixture.invalid/result.png',assetId:'image-id',taskId:'task-1',adapterKey:'m',modelKey:'m'};
const blob={id:'image-id',localUri:'asset://old-project/result.png'};
const spec={cat:'characters' as const,assetId:'a',variantId:null,purpose:'asset.character.image' as const,prompt:'original',label:'A'};
beforeEach(()=>{
 vi.clearAllMocks();h.writer=true;h.stored.clear();vi.stubGlobal('localStorage',{getItem:(k:string)=>h.stored.get(k)??null,setItem:(k:string,v:string)=>h.stored.set(k,v),removeItem:(k:string)=>h.stored.delete(k)});
 h.state={projectInstanceId:'project-A',savePath:'A.Qiji',pendingGens:[],characters:[{id:'a',image:'old.png'}],assetBlobs:{},visualStyle:'',
  addPendingGen:vi.fn((p:any)=>h.state.pendingGens.push(p)),updatePendingGen:vi.fn((id:string,patch:any)=>{h.state.pendingGens=h.state.pendingGens.map((p:any)=>p.id===id?{...p,...patch}:p);}),
  removePendingGen:vi.fn((id:string)=>{h.state.pendingGens=h.state.pendingGens.filter((p:any)=>p.id!==id);}),
  registerAssetBlob:vi.fn((b:any)=>{h.state.assetBlobs[b.id]=b;}),addGenMeta:vi.fn(),addAssetImage:vi.fn(),save:vi.fn(async()=>{})};
 h.download.mockResolvedValue(blob);
});
afterEach(()=>vi.unstubAllGlobals());
function start(){const upstream=deferred<any>();h.run.mockReturnValueOnce(upstream.promise);startGeneration(spec);return {upstream,id:h.state.pendingGens.at(-1).id,callbacks:h.run.mock.calls[h.run.mock.calls.length - 1]![1]};}
const tick=async()=>{await new Promise(r=>setTimeout(r,0));};
describe('资产/分镜任务项目归属与受理凭据',()=>{
 it('下载期间切项目不登记映射，原项目重开可按原任务找回',async()=>{
  const pending=start();pending.callbacks.onTaskId('task-1','m');const original=h.state.pendingGens.map((p:any)=>({...p}));
  const download=deferred<any>();h.download.mockReturnValueOnce(download.promise);pending.upstream.resolve(result);await vi.waitFor(()=>expect(h.download).toHaveBeenCalledOnce());
  h.state={...h.state,projectInstanceId:'project-B',savePath:'B.Qiji',pendingGens:[],assetBlobs:{}};download.resolve(blob);await tick();
  expect(h.state.registerAssetBlob).not.toHaveBeenCalled();expect(h.state.addAssetImage).not.toHaveBeenCalled();expect(original[0].taskId).toBe('task-1');
  h.state={...h.state,projectInstanceId:'project-A-reopen',savePath:'A.Qiji',pendingGens:original};resumePendingGenerations();
  h.track.mock.calls[h.track.mock.calls.length - 1]![0].onUpdate(100,'success',result.resultUri,undefined,'image-id');await vi.waitFor(()=>expect(h.state.addAssetImage).toHaveBeenCalledOnce());
  expect(h.state.pendingGens).toHaveLength(0);expect(h.run).toHaveBeenCalledOnce();
 });
 it('导入副本复用pendingId，旧请求回包不写副本或认领原项目回执',async()=>{
  const pending=start();const copy=h.state.pendingGens.map((p:any)=>({...p}));h.state={...h.state,projectInstanceId:'copy',savePath:'copy.Qiji',pendingGens:copy};
  pending.callbacks.onTaskId('task-original','m');pending.upstream.resolve(result);await tick();resumePendingGenerations();
  expect(h.state.registerAssetBlob).not.toHaveBeenCalled();expect(h.state.addAssetImage).not.toHaveBeenCalled();expect(h.state.pendingGens[0].taskId).toBeUndefined();expect(h.track).not.toHaveBeenCalled();
 });
 it('受理回执在另一项目期间到达，重启模块后回原项目仍能找回',async()=>{
  const pending=start();const original=h.state.pendingGens.map((p:any)=>({...p}));h.state={...h.state,projectInstanceId:'project-B',savePath:'B.Qiji',pendingGens:[]};
  pending.callbacks.onTaskId('late-task','m');expect([...h.stored.values()].some(v=>v.includes('late-task'))).toBe(true);expect(h.state.updatePendingGen).not.toHaveBeenCalled();
  vi.resetModules();const reloaded=await import('./generationQueue');h.state={...h.state,projectInstanceId:'project-A-restart',savePath:'A.Qiji',pendingGens:original};reloaded.resumePendingGenerations();
  expect(h.state.pendingGens[0]).toMatchObject({taskId:'late-task',adapterKey:'m',status:'running'});expect(h.track.mock.calls[h.track.mock.calls.length - 1]![0].taskId).toBe('late-task');expect(h.run).toHaveBeenCalledOnce();
 });
 it('受理前同路径重开，迟到凭据唤起原任务，不把它判为永久丢失',async()=>{
  const pending=start();h.state={...h.state,projectInstanceId:'project-A-reopen',pendingGens:h.state.pendingGens.map((p:any)=>({...p}))};resumePendingGenerations();
  expect(h.state.pendingGens[0].status).toBe('running');pending.callbacks.onTaskId('late-task','m');await tick();
  expect(h.state.pendingGens[0]).toMatchObject({taskId:'late-task',status:'running'});expect(h.track).not.toHaveBeenCalled();
  pending.upstream.resolve({...result,taskId:'late-task'});await vi.waitFor(()=>expect(h.state.addAssetImage).toHaveBeenCalledOnce());
 });
 it('迟到受理保留原轮询，同路径重开仍由原请求交付结果',async()=>{
  const accepted=deferred<void>(),completed=deferred<any>(),originalUpdate=vi.fn(()=>completed.resolve({...result,taskId:'late-task'}));
  h.run.mockImplementationOnce(async(_purpose,inputs)=>{await accepted.promise;inputs.onTaskId('late-task','m');h.track({taskId:'late-task',adapterKey:'m',onUpdate:originalUpdate});return completed.promise;});
  startGeneration(spec);h.state={...h.state,projectInstanceId:'project-A-reopen',pendingGens:h.state.pendingGens.map((p:any)=>({...p}))};resumePendingGenerations();
  accepted.resolve();await tick();const last=h.track.mock.calls[h.track.mock.calls.length-1][0];expect(last.onUpdate).toBe(originalUpdate);expect(h.track).toHaveBeenCalledOnce();
  last.onUpdate(100,'success',result.resultUri,undefined,'image-id');await vi.waitFor(()=>expect(h.state.addAssetImage).toHaveBeenCalledOnce());expect(h.state.pendingGens).toHaveLength(0);
 });
 it('主动重试后旧受理和终态迟到，不能顶掉新请求',async()=>{
  const old=start();h.run.mockReturnValueOnce(deferred<any>().promise);retryGeneration(old.id);const newer=h.run.mock.calls[h.run.mock.calls.length - 1]![1];newer.onTaskId('new-task','m');
  old.callbacks.onTaskId('old-task','m');old.upstream.resolve(result);await tick();expect(h.state.pendingGens[0].taskId).toBe('new-task');expect(h.state.addAssetImage).not.toHaveBeenCalled();
  expect([...h.stored.values()].some(v=>v.includes('old-task'))).toBe(false);
 });
 it('同路径重开后主动重试，旧实例的迟到受理不能覆盖新凭据',async()=>{
  const old=start();h.state={...h.state,projectInstanceId:'project-A-reopen'};h.run.mockReturnValueOnce(deferred<any>().promise);retryGeneration(old.id);
  h.run.mock.calls[h.run.mock.calls.length - 1]![1].onTaskId('new-task','m');old.callbacks.onTaskId('old-task','m');old.upstream.resolve(result);await tick();
  expect(h.state.pendingGens[0].taskId).toBe('new-task');expect([...h.stored.values()].some(v=>v.includes('old-task'))).toBe(false);expect(h.state.addAssetImage).not.toHaveBeenCalled();
 });
 it('项目落盘失败仍保留受理凭据，不能将内存移除视为保存成功',async()=>{
  const pending=start();pending.callbacks.onTaskId('task-1','m');h.state.save.mockImplementation(async()=>{h.state.isDirty=true;});pending.upstream.resolve(result);
  await vi.waitFor(()=>expect(h.state.addAssetImage).toHaveBeenCalledOnce());await tick();expect(h.state.pendingGens).toHaveLength(0);
  expect([...h.stored.values()].some(v=>v.includes('task-1'))).toBe(true);
 });
 it('非写者保存转发并清dirty也必须保留独立受理凭据',async()=>{
  h.writer=false;const pending=start();pending.callbacks.onTaskId('follower-task','m');h.state.save.mockImplementation(async()=>{h.state.isDirty=false;});
  pending.upstream.resolve({...result,taskId:'follower-task'});await vi.waitFor(()=>expect(h.state.addAssetImage).toHaveBeenCalledOnce());await tick();
  expect(h.state.isDirty).toBe(false);expect(h.state.pendingGens).toHaveLength(0);expect([...h.stored.values()].some(v=>v.includes('follower-task'))).toBe(true);
 });
 it('文本分支也在成功落盘后清理独立受理凭据',async()=>{
  h.state.episodes=[{id:'e',shots:[{id:'s',materials:[]}]}];h.state.updateShot=vi.fn();const upstream=deferred<any>();h.run.mockReturnValueOnce(upstream.promise);
  startShotGeneration({episodeId:'e',shotId:'s',field:'storyboardPrompt',purpose:'storyboard.singleShot',prompt:'p',label:'S'});
  h.run.mock.calls[h.run.mock.calls.length - 1]![1].onTaskId('text-task','m');upstream.resolve({...result,taskId:'text-task',resultUri:'text result'});
  await vi.waitFor(()=>expect(h.state.updateShot).toHaveBeenCalledOnce());expect(h.state.pendingGens).toHaveLength(0);expect([...h.stored.values()].some(v=>v.includes('text-task'))).toBe(false);expect(h.download).not.toHaveBeenCalled();
 });
 it('生成失败保留旧主图，并保留可重试记录和真实错误',async()=>{
  const pending=start();pending.callbacks.onTaskId('task-1','m');pending.upstream.resolve({status:'failed',error:'upstream rejected'});await tick();
  expect(h.state.characters[0].image).toBe('old.png');expect(h.state.addAssetImage).not.toHaveBeenCalled();expect(h.state.pendingGens[0]).toMatchObject({status:'failed',error:'upstream rejected',taskId:'task-1'});
 });
 it('同项目成功只交付原资产，写回后移除pending',async()=>{
  const pending=start();pending.callbacks.onTaskId('task-1','m');pending.upstream.resolve(result);await vi.waitFor(()=>expect(h.state.addAssetImage).toHaveBeenCalledOnce());
  expect(h.state.addAssetImage).toHaveBeenCalledWith('characters','a',null,blob.localUri,true);expect(h.state.pendingGens).toHaveLength(0);
 });
});
