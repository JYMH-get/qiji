import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Exercise the actual JSX event handlers with deterministic hook state; no DOM/network/store persistence.
const h = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[], state: {} as any,
    upload: vi.fn(), remote: vi.fn(), local: vi.fn(), generate: vi.fn(), readers: [] as any[] }));
vi.mock("react", async original => ({ ...await original<any>(),
    useState: (initial: any) => { const i=h.cursor++; if (!(i in h.slots)) h.slots[i]=typeof initial==='function'?initial():initial;
        return [h.slots[i],(value:any)=>{h.slots[i]=typeof value==='function'?value(h.slots[i]):value;}]; },
    useRef: (initial:any) => {const i=h.cursor++; return h.slots[i]??(h.slots[i]={current:initial});},
    useMemo: (fn:()=>unknown)=>fn(),
    useEffect: (fn:()=>void,deps?:unknown[])=>{const i=h.cursor++,old=h.slots[i];if(!old||!deps||deps.some((d,j)=>d!==old[j])){h.effects.push(fn);h.slots[i]=deps;}},
}));
vi.mock("react-router",()=>({useNavigate:()=>vi.fn()}));
vi.mock("@/store/projectStore",()=>({useProjectStore:Object.assign((select:any)=>select(h.state),{getState:()=>h.state})}));
vi.mock("@/services/generationQueue",()=>({startGeneration:h.generate,retryGeneration:vi.fn(),recallPendingGeneration:vi.fn()}));
vi.mock("@/components/ModelPicker",()=>({default:()=>null,effectiveModelKey:()=>"image-model",useEffectiveModelKey:()=>"image-model"}));
vi.mock("@/store/catalogStore",()=>({useCatalogStore:Object.assign((s:any)=>s({catalog:{models:[]}}),{getState:()=>({catalog:{templates:[]}})})}));
vi.mock("@/hooks/useScrollSnapshot",()=>({useScrollSnapshot:()=>({})}));
vi.mock("@/store/lightboxStore",()=>({openLightbox:vi.fn()}));
vi.mock("@/components/PromptExpandButton",()=>({PromptExpandButton:()=>null}));
vi.mock("@/services/managedClient",()=>({managedClient:{uploadAsset:h.upload}}));
vi.mock("@/services/assetPersist",()=>({saveRemoteAsset:h.remote,saveUploadedLocal:h.local}));
vi.mock("@/services/assetCheck",()=>({runAssetCheck:vi.fn(),assetEntityTargets:vi.fn()}));
vi.mock("@/services/sharedPublish",()=>({sharedItemFromUri:vi.fn()}));
vi.mock("@/store/sharedPickStore",()=>({openSharedPick:vi.fn()}));
vi.mock("@/lib/confirmDialog",()=>({confirmDialog:vi.fn(async()=>true)}));
vi.mock("@/lib/presetSchemes",()=>({listPresetOptions:()=>[]}));
vi.mock("@/components/AssetDisplayImage",()=>({AssetDisplayImage:()=>null}));
import AssetWorkbench from "./AssetWorkbench";

function deferred<T>() {let resolve!:(v:T)=>void, reject!:(e:Error)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
const props = {cat:'characters' as const,unit:'角色',imagePurpose:'asset.character.image' as const,textField:'features' as const,showVoice:true};
function draw() {let tree:any;for(let n=0;n<2;n++){h.cursor=0;tree=AssetWorkbench(props);if(typeof tree.type==='function')tree=tree.type(tree.props);for(const fn of h.effects.splice(0))fn();}return tree;}
function all(tree:any):any[]{if(!tree||typeof tree!=='object')return [];if(Array.isArray(tree))return tree.flatMap(all);return [tree,...all(tree.props?.children)];}
const find=(tree:any,predicate:(node:any)=>boolean)=>{const node=all(tree).find(predicate);expect(node,'UI touchpoint exists').toBeTruthy();return node;};
const fileEvent=(name='voice.wav')=>({target:{files:[{name,type:name.endsWith('.wav')?'audio/wav':'image/png'}],value:'chosen'}});
const tick=async()=>{await new Promise(r=>setTimeout(r,0));};
function select(id:string){find(draw(),n=>n.key===id&&n.props.onClick).props.onClick();return draw();}
function voiceUpload(){find(draw(),n=>n.type==='input'&&n.props.accept==='audio/*').props.onChange(fileEvent());}
function refUpload(){find(draw(),n=>n.props.title==='添加垫图').props.onClick();const input=all(draw()).filter(n=>n.type==='input'&&n.props.accept==='image/*').find(n=>!('disabled' in n.props));expect(input).toBeTruthy();input.props.onChange(fileEvent('ref.png'));}
beforeEach(()=>{
    vi.clearAllMocks();h.slots=[];h.cursor=0;h.effects=[];h.readers=[];
    const a=(id:string)=>({id,name:id,prompt:`prompt-${id}`,images:[],variants:[]});
    h.state={projectInstanceId:'project-A',savePath:'A.Qiji',characters:[a('a'),a('b')],crowds:[],scenes:[],organisms:[],items:[],pendingGens:[],genMeta:{},assetBlobs:{},assetRefImages:{},mediaSettings:{},
        uiSnapshot:{assetPages:{characters:{selectedId:'a'}}},setUiSnapshot:vi.fn(),save:vi.fn(async()=>{}),blobByUri:()=>undefined,
        registerAssetBlob:vi.fn((blob:any)=>{h.state.assetBlobs[blob.id]=blob;}),
        updateAsset:vi.fn((_cat:string,id:string,patch:any)=>{h.state.characters=h.state.characters.map((a:any)=>a.id===id?{...a,...patch}:a);}),
        updateAssetVariant:vi.fn(),setAssetRefImages:vi.fn((key:string,refs:any)=>{h.state.assetRefImages[key]=refs;}),
        addAssetImage:vi.fn(),addAsset:vi.fn(),removeAsset:vi.fn(),addAssetVariant:vi.fn(),removeAssetVariant:vi.fn(),setAssetMainImage:vi.fn(),removePendingGen:vi.fn()};
    h.remote.mockResolvedValue(null);h.local.mockResolvedValue(null);
    vi.stubGlobal('alert',vi.fn());vi.stubGlobal('FileReader',class {result='data:image/png;base64,preview';onload?:()=>void;constructor(){h.readers.push(this);}readAsDataURL(){} });
});
afterEach(()=>vi.unstubAllGlobals());
describe('资产工作台目标归属',()=>{
    it('切资产后音色仍绑定原角色，失败保留原音色',async()=>{
        const pending=deferred<any>();h.upload.mockReturnValue(pending.promise);voiceUpload();select('b');pending.resolve({id:'audio-1',url:'https://fixture.invalid/audio.wav'});await tick();
        expect(h.state.characters.find((a:any)=>a.id==='a').voiceAssetId).toBe('audio-1');expect(h.state.characters.find((a:any)=>a.id==='b').voiceUri).toBeUndefined();
        select('a');h.upload.mockRejectedValue(new Error('offline'));voiceUpload();await tick();expect(h.state.characters[0].voiceAssetId).toBe('audio-1');
    });
    it.each(['upload','download'])('音色%s中切到同ID新项目，不登记映射或绑定',async stage=>{
        const pending=deferred<any>();if(stage==='upload')h.upload.mockReturnValue(pending.promise);else {h.upload.mockResolvedValue({id:'audio-1',url:'https://fixture.invalid/audio.wav'});h.remote.mockReturnValue(pending.promise);}
        voiceUpload();await tick();h.state={...h.state,projectInstanceId:'project-B',savePath:'B.Qiji',assetBlobs:{}};
        pending.resolve(stage==='upload'?{id:'audio-1',url:'https://fixture.invalid/audio.wav'}:{id:'audio-1',localUri:'asset://a.wav'});await tick();
        expect(h.state.updateAsset).not.toHaveBeenCalled();expect(h.state.registerAssetBlob).not.toHaveBeenCalled();
    });
    it('替换音色期间移除绑定，迟到上传不得重新绑回',async()=>{
        h.state.characters[0].voiceUri='old.wav';const pending=deferred<any>();h.upload.mockReturnValue(pending.promise);voiceUpload();
        find(draw(),n=>n.props.title==='解除绑定').props.onClick();pending.resolve({id:'audio-1',url:'new.wav'});await tick();expect(h.state.characters[0].voiceUri).toBeUndefined();
    });
    it('当前造型图片上传中切项目，不写新项目历史',async()=>{
        const pending=deferred<any>();h.upload.mockReturnValue(pending.promise);
        find(draw(),n=>n.type==='input'&&n.props.accept==='image/*'&&'disabled' in n.props).props.onChange(fileEvent('image.png'));
        h.state={...h.state,projectInstanceId:'project-B'};pending.resolve({id:'image-1',url:'https://fixture.invalid/a.png'});await tick();
        expect(h.state.addAssetImage).not.toHaveBeenCalled();expect(h.state.registerAssetBlob).not.toHaveBeenCalled();
    });
    it('垫图读取/上传中切资产，原资产记忆不混入新资产的垫图',async()=>{
        const bRefs=[{id:'b-ref',uri:'b.png'}];h.state.assetRefImages['characters:b:base']=bRefs;
        const pending=deferred<any>();h.upload.mockReturnValue(pending.promise);refUpload();select('b');h.readers[0].onload?.();
        pending.resolve({id:'ref-asset',url:'https://fixture.invalid/ref.png'});await tick();
        expect(h.state.assetRefImages['characters:a:base']).toEqual([expect.objectContaining({url:'https://fixture.invalid/ref.png'})]);
        expect(h.state.assetRefImages['characters:b:base']).toEqual(bRefs);
        select('a');expect(all(draw()).some(n=>n.props?.uri==='https://fixture.invalid/ref.png')).toBe(true);
    });
    it('上传先完成、FileReader后到，不复活上传中预览或写入base64',async()=>{
        h.upload.mockResolvedValue({id:'ref-asset',url:'https://fixture.invalid/ref.png'});refUpload();await tick();h.readers[0].onload?.();draw();
        const refs=h.state.assetRefImages['characters:a:base'];expect(refs).toHaveLength(1);expect(refs[0].uri).toBe('https://fixture.invalid/ref.png');
    });
    it('垫图失败保留可见失败项，生成不能悄悄省略参考图',async()=>{
        h.upload.mockRejectedValue(new Error('offline'));refUpload();h.readers[0].onload?.();await tick();
        find(draw(),n=>n.props.title==='可重复提交，每次生成会在右侧历史区新增一个占位').props.onClick();
        expect(h.generate).not.toHaveBeenCalled();expect(alert).toHaveBeenCalledWith(expect.stringContaining('垫图'));
    });
    it('批量基础生成分别使用各自垫图',()=>{
        h.state.assetRefImages={'characters:a:base':[{id:'ra',uri:'a.png'}],'characters:b:base':[{id:'rb',uri:'b.png'}]};
        find(draw(),n=>n.props.title==='仅生成未生成与失败的基础形象').props.onClick();
        expect(h.generate.mock.calls.map(([spec])=>spec.input.images[0].url)).toEqual(['a.png','b.png']);
    });
    it('放大编辑器的旧保存回调不能写同ID新项目',()=>{
        const modal=find(draw(),n=>n.props.title==='编辑出图提示词');h.state={...h.state,projectInstanceId:'project-B'};modal.props.onSave('old project text');expect(h.state.updateAsset).not.toHaveBeenCalled();
    });
    it('提供上传音色/替换音色，并移除恒禁用生成入口',()=>{
        const text=JSON.stringify(draw());expect(text).toContain('上传音色');expect(text).not.toContain('TTS 音色生成暂未实现');
        h.state.characters[0].voiceUri='old.wav';expect(JSON.stringify(draw())).toContain('替换音色');
    });
});
