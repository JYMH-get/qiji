import {beforeEach,afterEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({state:{} as any,invoke:vi.fn(),write:vi.fn(),copy:vi.fn(),register:vi.fn()}));
vi.mock('@/store/projectStore',()=>({useProjectStore:{getState:()=>h.state}}));
vi.mock('@tauri-apps/api/path',()=>({dirname:async(p:string)=>p.slice(0,p.lastIndexOf('/')),join:async(...p:string[])=>p.join('/')}));
vi.mock('@tauri-apps/api/core',()=>({invoke:h.invoke,convertFileSrc:(p:string)=>'asset://'+p}));
vi.mock('@tauri-apps/plugin-fs',()=>({exists:async()=>true,mkdir:vi.fn(),copyFile:h.copy,writeFile:h.write,remove:vi.fn(async()=>{})}));
vi.mock('./thumbGen',()=>({ensureThumb:vi.fn()}));
import {saveRemoteAsset,saveUploadedLocal} from './assetPersist';
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});vi.stubGlobal('fetch',vi.fn(()=>{throw Error('network forbidden');}));h.state={savePath:'D:/A/project.Qiji',projectInstanceId:'A',registerAssetBlob:h.register};h.invoke.mockImplementation(async(cmd:string)=>cmd==='download_url'?{path:'D:/temp/audio',content_type:'audio/wav'}:undefined);});
afterEach(()=>vi.unstubAllGlobals());
it('读取上传文件字节时切项目，不使用新项目目录或登记',async()=>{
 const bytes=deferred<ArrayBuffer>();const work=saveUploadedLocal({arrayBuffer:()=>bytes.promise,type:'audio/wav'} as Blob,'audio-1','https://fixture.invalid/a.wav','a.wav',{shouldContinue:()=>h.state.projectInstanceId==='A'});
 h.state={...h.state,projectInstanceId:'B',savePath:'D:/B/project.Qiji'};bytes.resolve(new ArrayBuffer(2));expect(await work).toBeNull();expect(h.write).not.toHaveBeenCalled();expect(h.register).not.toHaveBeenCalled();
});
it('远端下载中切项目，不复制下载文件或注册映射',async()=>{
 const download=deferred<any>();h.invoke.mockReturnValueOnce(download.promise);const work=saveRemoteAsset('audio-1','https://fixture.invalid/a.wav',{shouldContinue:()=>h.state.projectInstanceId==='A'});
 await vi.waitFor(()=>expect(h.invoke).toHaveBeenCalledWith('download_url',expect.anything()));h.state.projectInstanceId='B';download.resolve({path:'D:/temp/audio',content_type:'audio/wav'});
 expect(await work).toBeNull();expect(h.copy).not.toHaveBeenCalled();expect(h.invoke.mock.calls.some(([cmd])=>cmd==='register_asset')).toBe(false);
});
it('本地文件写入期间切项目，写完也不把映射登记到新项目',async()=>{
 const write=deferred<void>();h.write.mockReturnValueOnce(write.promise);const work=saveUploadedLocal(new Blob(['audio'],{type:'audio/wav'}),'audio-1','https://fixture.invalid/a.wav','a.wav',{shouldContinue:()=>h.state.projectInstanceId==='A'});
 await vi.waitFor(()=>expect(h.write).toHaveBeenCalledOnce());expect(h.write.mock.calls[0][0]).toBe('D:/A/assets/audio-1.wav');h.state.projectInstanceId='B';write.resolve();
 expect(await work).toBeNull();expect(h.register).not.toHaveBeenCalled();expect(h.invoke.mock.calls.some(([cmd])=>cmd==='register_asset')).toBe(false);
});
it('正常上传仍将原件和映射落入原项目',async()=>{
 const blob=await saveUploadedLocal(new Blob(['audio'],{type:'audio/wav'}),'audio-1','https://fixture.invalid/a.wav','a.wav',{shouldContinue:()=>true});
 expect(blob?.localPath).toBe('D:/A/assets/audio-1.wav');expect(h.register).toHaveBeenCalledWith(blob);expect(fetch).not.toHaveBeenCalled();
});
