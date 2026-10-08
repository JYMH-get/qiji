import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Exercise the actual JSX event handlers with deterministic hook state; no DOM/network/store persistence.
const h = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, sessionKey: undefined as string | undefined, effects: [] as (() => void)[], layoutEffects: [] as (() => void)[], state: {} as any,
    upload: vi.fn(), remote: vi.fn(), local: vi.fn(), generate: vi.fn(), gallery: vi.fn(), portal: vi.fn((_children:any,_container:HTMLElement) => null), readers: [] as any[], listeners: new Set<() => void>() }));
vi.mock("react", async original => {
    const effect = (queue: (() => void)[], fn: () => void | (() => void), deps?: unknown[]) => {
        const i = h.cursor++, old = h.slots[i];
        if (!old || !deps || deps.some((d, j) => d !== old.deps?.[j])) {
            const slot = { kind: "effect", deps, cleanup: old?.cleanup };
            h.slots[i] = slot;
            queue.push(() => { slot.cleanup?.(); slot.cleanup = fn(); });
        }
    };
    return { ...await original<any>(),
    useState: (initial: any) => { const i=h.cursor++,slots=h.slots; if (!(i in slots)) slots[i]=typeof initial==='function'?initial():initial;
        return [slots[i],(value:any)=>{slots[i]=typeof value==='function'?value(slots[i]):value;}]; },
    useRef: (initial:any) => {const i=h.cursor++; return h.slots[i]??(h.slots[i]={current:initial});},
    useMemo: (fn:()=>unknown, deps?:unknown[])=>{const i=h.cursor++,old=h.slots[i];if(!old||!deps||deps.some((d,j)=>d!==old.deps?.[j]))h.slots[i]={deps,value:fn()};return h.slots[i].value;},
    useEffect: (fn:()=>void|(()=>void),deps?:unknown[])=>effect(h.effects,fn,deps),
    useLayoutEffect: (fn:()=>void|(()=>void),deps?:unknown[])=>effect(h.layoutEffects,fn,deps),
}; });
vi.mock("react-router",()=>({useNavigate:()=>vi.fn()}));
vi.mock("react-dom",()=>({createPortal:h.portal}));
vi.mock("@/store/projectStore",()=>({useProjectStore:Object.assign((select:any)=>select(h.state),{getState:()=>h.state,
    subscribe:(listener:()=>void)=>{h.listeners.add(listener);return()=>h.listeners.delete(listener);}})}));
vi.mock("@/services/generationQueue",()=>({startGeneration:h.generate,retryGeneration:vi.fn(),recallPendingGeneration:vi.fn()}));
vi.mock("@/components/ModelPicker",()=>({default:()=>null,effectiveModelKey:()=>"image-model",useEffectiveModelKey:()=>"image-model"}));
vi.mock("@/store/catalogStore",()=>({useCatalogStore:Object.assign((s:any)=>s({catalog:{models:[]}}),{getState:()=>({catalog:{templates:[]}})})}));
vi.mock("@/hooks/useScrollSnapshot",()=>({useScrollSnapshot:()=>({})}));
vi.mock("@/store/lightboxStore",()=>({openLightbox:vi.fn(),openLightboxGallery:h.gallery}));
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
function draw(overrides: Partial<Parameters<typeof AssetWorkbench>[0]> = {}) {
    let tree:any;
    for(let n=0;n<2;n++) {
        h.cursor=0;tree=AssetWorkbench({...props,...overrides});
        if (h.sessionKey !== tree.key) { unmount();h.slots=[];h.effects=[];h.layoutEffects=[];h.cursor=0;h.sessionKey=tree.key; }
        if(typeof tree.type==='function')tree=tree.type(tree.props);
        for(const fn of h.layoutEffects.splice(0))fn();for(const fn of h.effects.splice(0))fn();
    }
    return tree;
}
function unmount(){for(const slot of h.slots)if(slot?.kind==='effect'){slot.cleanup?.();slot.cleanup=undefined;}}
function all(tree:any):any[]{if(!tree||typeof tree!=='object')return [];if(Array.isArray(tree))return tree.flatMap(all);return [tree,...all(tree.props?.children)];}
const find=(tree:any,predicate:(node:any)=>boolean)=>{const node=all(tree).find(predicate);expect(node,'UI touchpoint exists').toBeTruthy();return node;};
const fileEvent=(name='voice.wav')=>({target:{files:[{name,type:name.endsWith('.wav')?'audio/wav':'image/png'}],value:'chosen'}});
const tick=async()=>{await new Promise(r=>setTimeout(r,0));};
function select(id:string){find(draw(),n=>n.key===id&&n.props.onClick).props.onClick();return draw();}
function voiceUpload(){find(draw(),n=>n.type==='input'&&n.props.accept==='audio/*').props.onChange(fileEvent());}
function refUpload(){find(draw(),n=>n.props.title==='添加垫图').props.onClick();const input=all(draw()).filter(n=>n.type==='input'&&n.props.accept==='image/*').find(n=>!('disabled' in n.props));expect(input).toBeTruthy();input.props.onChange(fileEvent('ref.png'));}
beforeEach(()=>{
    vi.clearAllMocks();h.slots=[];h.cursor=0;h.sessionKey=undefined;h.effects=[];h.layoutEffects=[];h.readers=[];h.listeners.clear();
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

describe('RTC 嵌入资产生成工作台',()=>{
    const target = (assetId='b',formKey='base') => ({embeddedTarget:{assetId,formKey}});
    const generate = (tree:any) => find(tree,n=>n.props.title==='可重复提交，每次生成会在右侧历史区新增一个占位');

    it('无图资产直接提供目标提示词与生成入口，隐藏重复列表且不读取或回写资产页快照',()=>{
        Object.defineProperty(h.state,'uiSnapshot',{get(){throw new Error('嵌入工作台不得读取资产页快照');}});
        const tree=draw(target());
        expect(tree.props['aria-label']).toBe('资产生成工作台');
        expect(all(tree).some(n=>n.props.placeholder==='搜索名称...')).toBe(false);
        expect(JSON.stringify(tree)).not.toContain('造型 / 分体');
        expect(find(tree,n=>n.type==='textarea').props.value).toBe('prompt-b');
        find(tree,n=>n.type==='textarea').props.onChange({target:{value:'嵌入编辑'}});
        generate(draw(target())).props.onClick();
        expect(h.generate).toHaveBeenCalledWith(expect.objectContaining({cat:'characters',assetId:'b',variantId:null,prompt:'嵌入编辑'}));
        expect(h.state.setUiSnapshot).not.toHaveBeenCalled();
    });

    it('指定造型使用自己的提示词、参考图与生成历史，设主图不写基础形象',()=>{
        h.state.characters[0]={...h.state.characters[0],image:'base.png',images:['base.png'],variants:[{id:'costume',label:'战斗造型',prompt:'costume prompt',image:'costume.png',images:['costume.png','costume-2.png']}]};
        h.state.pendingGens=[{id:'base-fail',cat:'characters',assetId:'a',variantId:null,status:'failed',error:'基础图失败'},
            {id:'form-fail',cat:'characters',assetId:'a',variantId:'costume',status:'failed',error:'造型失败'}];
        const tree=draw(target('a','costume'));
        generate(tree).props.onClick();
        expect(h.generate).toHaveBeenCalledWith(expect.objectContaining({assetId:'a',variantId:'costume',prompt:'costume prompt',input:{images:[{url:'base.png'}]}}));
        expect(all(tree).some(n=>n.key==='base-fail')).toBe(false);
        expect(all(tree).some(n=>n.key==='form-fail')).toBe(true);
        const history=find(tree,n=>n.props['aria-label']==='生成历史');
        expect(find(history,n=>n.props.children==='生成历史（3）')).toBeTruthy();
        find(tree,n=>n.props.title==='单击设为主图 / 双击查看大图').props.onClick();
        expect(h.state.setAssetMainImage).toHaveBeenCalledWith('characters','a','costume','costume-2.png');
        find(tree,n=>n.type==='textarea').props.onChange({target:{value:'新版造型'}});
        expect(h.state.updateAssetVariant).toHaveBeenCalledWith('characters','a','costume',{prompt:'新版造型'});
        expect(h.state.updateAsset).not.toHaveBeenCalled();
    });

    it.each([['missing','base'],['a','deleted-form']])('目标 %s/%s 不存在时不回退其他资产或基础形象', (assetId,formKey)=>{
        const tree=draw(target(assetId,formKey));
        expect(all(tree).some(n=>n.props.title==='可重复提交，每次生成会在右侧历史区新增一个占位')).toBe(false);
        expect(all(tree).some(n=>n.type==='textarea')).toBe(false);
        expect(h.generate).not.toHaveBeenCalled();expect(h.state.setUiSnapshot).not.toHaveBeenCalled();
    });

    it('切资产或造型重置查看态和垫图，图片上传仍回填原目标',async()=>{
        h.state.characters[0].variants=[{id:'costume',label:'造型',prompt:'form prompt',images:[]}];
        h.state.assetRefImages['characters:a:base']=[{id:'a-ref',uri:'ref-a.png'}];
        h.state.assetRefImages['characters:a:costume']=[{id:'form-ref',uri:'ref-form.png'}];
        h.state.assetRefImages['characters:b:base']=[{id:'b-ref',uri:'ref-b.png'}];
        h.state.pendingGens=[{id:'a-fail',cat:'characters',assetId:'a',variantId:null,status:'failed',error:'旧目标错误'}];
        const pending=deferred<any>();h.upload.mockReturnValue(pending.promise);
        let tree=draw(target('a'));
        find(tree,n=>n.key==='a-fail').props.onClick();
        expect(JSON.stringify(draw(target('a')))).toContain('旧目标错误');
        find(tree,n=>n.type==='input'&&n.props.accept==='image/*'&&'disabled' in n.props).props.onChange(fileEvent('a.png'));
        tree=draw(target('a','costume'));
        expect(JSON.stringify(tree)).not.toContain('旧目标错误');
        expect(all(tree).filter(n=>n.props.uri).map(n=>n.props.uri)).toContain('ref-form.png');
        expect(all(tree).some(n=>n.props.uri==='ref-a.png')).toBe(false);
        tree=draw(target('b'));
        expect(all(tree).some(n=>n.props.uri==='ref-b.png')).toBe(true);
        expect(find(tree,n=>n.type==='input'&&n.props.accept==='image/*'&&'disabled' in n.props).props.disabled).toBe(false);
        pending.resolve({id:'image-a',url:'https://fixture.invalid/a.png'});await tick();
        expect(h.state.addAssetImage).toHaveBeenCalledWith('characters','a',null,'https://fixture.invalid/a.png',true);
        generate(draw(target('b'))).props.onClick();
        expect(h.generate).toHaveBeenLastCalledWith(expect.objectContaining({assetId:'b',variantId:null,input:{images:[{url:'ref-b.png'}]}}));
    });

    it('换项目后旧生成回调不能提交同 ID 新资产',()=>{
        const oldGenerate=generate(draw(target('a'))).props.onClick;
        h.state={...h.state,projectInstanceId:'project-B'};
        draw(target('a'));oldGenerate();
        expect(h.generate).not.toHaveBeenCalled();
    });

    it('右栏容器未就绪时只显示预览，就绪后编辑与生成整体移到该容器',()=>{
        let tree=draw({...target(),embeddedEditorPortal:null});
        expect(all(tree).some(n=>n.type==='textarea')).toBe(false);
        expect(h.portal).not.toHaveBeenCalled();
        expect(JSON.stringify(tree)).toContain('图片展示');
        expect(find(tree,n=>n.props['aria-label']==='生成历史')).toBeTruthy();
        const container={} as HTMLElement;
        tree=draw({...target(),embeddedEditorPortal:container});
        const [editor, destination]=h.portal.mock.calls[h.portal.mock.calls.length-1] as [any,HTMLElement];
        expect(destination).toBe(container);
        expect(editor.props['aria-label']).toBe('资产生成设置');
        expect(editor.props.style).toMatchObject({width:'100%',overflowY:'auto'});
        expect(find(editor,n=>n.type==='textarea').props.style.minHeight).toBeGreaterThanOrEqual(160);
        expect(JSON.stringify(editor)).toContain('垫图素材');
        expect(JSON.stringify(editor)).toContain('上传音色');
        expect(JSON.stringify(editor)).toContain('出图模型');
        expect(all(tree).some(n=>n.type==='textarea')).toBe(false);
        generate(editor).props.onClick();
        expect(h.generate).toHaveBeenCalledOnce();
        expect(h.generate).toHaveBeenCalledWith(expect.objectContaining({assetId:'b',variantId:null,prompt:'prompt-b'}));
    });

    it('右栏隐藏后重新挂载仍使用同一会话，保留图片参数与垫图选择状态',()=>{
        draw({...target(),embeddedEditorPortal:{} as HTMLElement});
        const key=h.sessionKey;
        let editor=h.portal.mock.calls[h.portal.mock.calls.length-1]?.[0] as any;
        find(editor,n=>n.type==='select'&&n.props.value==='high').props.onChange({target:{value:'low'}});
        find(editor,n=>n.props.title==='添加垫图').props.onClick();
        draw({...target(),embeddedEditorPortal:null});
        draw({...target(),embeddedEditorPortal:{} as HTMLElement});
        editor=h.portal.mock.calls[h.portal.mock.calls.length-1]?.[0] as any;
        expect(h.sessionKey).toBe(key);
        expect(find(editor,n=>n.type==='select'&&n.props.value==='low')).toBeTruthy();
        expect(all(editor).some(n=>n.type==='input'&&n.props.accept==='image/*'&&!('disabled' in n.props))).toBe(true);
        generate(editor).props.onClick();
        expect(h.generate).toHaveBeenCalledWith(expect.objectContaining({params:expect.objectContaining({quality:'low'})}));
    });

    it('普通资产页忽略嵌入容器，继续原位展示列表和编辑区',()=>{
        const tree=draw({embeddedEditorPortal:{} as HTMLElement});
        expect(h.portal).not.toHaveBeenCalled();
        expect(find(tree,n=>n.props.placeholder==='搜索名称...')).toBeTruthy();
        expect(JSON.stringify(tree)).toContain('造型 / 分体');
        expect(find(tree,n=>n.type==='textarea')).toBeTruthy();
    });

    it('宿主图片参数更新时费用预估与实际提交同步，右栏不再提供独立模型或参数选择',()=>{
        const container={} as HTMLElement;
        const first={aspect:'9:16',resolution:'4k',quality:'medium',extra:'原样保留'};
        draw({...target(),embeddedEditorPortal:container,embeddedImageParams:first});
        let editor=h.portal.mock.calls[h.portal.mock.calls.length-1][0] as any;
        expect(all(editor).some(n=>n.props.cap==='image'||n.type==='select')).toBe(false);
        expect(JSON.stringify(editor)).not.toContain('出图要求');
        let button=generate(editor);
        expect(find(button,n=>n.props.modelKey==='image-model').props.params).toBe(first);
        button.props.onClick();
        expect(h.generate).toHaveBeenLastCalledWith(expect.objectContaining({modelKey:'image-model',params:{...first,idPrefix:'C',assetName:'b'}}));
        const next={aspect:'16:9',resolution:'2k',quality:'high',extra:'新参数'};
        draw({...target(),embeddedEditorPortal:container,embeddedImageParams:next});
        editor=h.portal.mock.calls[h.portal.mock.calls.length-1][0] as any;
        button=generate(editor);
        expect(find(button,n=>n.props.modelKey==='image-model').props.params).toBe(next);
        button.props.onClick();
        expect(h.generate).toHaveBeenLastCalledWith(expect.objectContaining({params:{...next,idPrefix:'C',assetName:'b'}}));
    });

    it('普通资产页忽略宿主参数，保留自己的出图选择与实际提交参数',()=>{
        const tree=draw({embeddedImageParams:{aspect:'9:16',resolution:'4k',quality:'low'}});
        expect(all(tree).some(n=>n.props.cap==='image'&&n.props.label==='出图模型')).toBe(true);
        expect(all(tree).some(n=>n.type==='select')).toBe(true);
        generate(tree).props.onClick();
        expect(h.generate).toHaveBeenLastCalledWith(expect.objectContaining({params:expect.objectContaining({aspect:'16:9',resolution:'2k',quality:'high'})}));
    });
});
afterEach(()=>{unmount();vi.unstubAllGlobals();});
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
    it('垫图双击打开本列表，灯箱重排保留新增素材并同步提示词编号',()=>{
        h.state.characters[0].prompt='正文 @Image1 对应 @Image2';
        h.state.assetRefImages['characters:a:base']=[{id:'ra',uri:'same.png',name:'甲'},{id:'rb',uri:'same.png',name:'乙'}];
        find(draw(),n=>n.key==='ra'&&n.props.onDoubleClick).props.onDoubleClick();
        const [source,activeId]=h.gallery.mock.calls[h.gallery.mock.calls.length-1];
        expect(activeId).toBe('ra');expect(source.getItems().map((item:any)=>item.id)).toEqual(['ra','rb']);
        // 真正的垫图区 drop 先增加新素材，灯箱必须重排最新的列表。
        find(draw(),n=>n.props.onDrop).props.onDrop({preventDefault(){},dataTransfer:{getData:()=>JSON.stringify({uri:'new.png',name:'新增'}),files:[]}});
        source.reorder('rb','ra');draw();
        expect(h.state.assetRefImages['characters:a:base'].map((ref:any)=>ref.name)).toEqual(['乙','甲','新增']);
        expect(h.state.characters[0].prompt).toBe('正文 @Image2 对应 @Image1');
        expect(source.getItems().map((item:any)=>item.name)).toEqual(['乙','甲','新增']);
    });
    it('灯箱在生成时禁排，切目标与卸载后来源失效且不能回写',()=>{
        const refs=[{id:'ra',uri:'a.png'},{id:'rb',uri:'b.png'}];
        h.state.assetRefImages['characters:a:base']=refs;
        h.state.assetRefImages['characters:b:base']=refs;
        const open=()=>{find(draw(),n=>n.key==='ra'&&n.props.onDoubleClick).props.onDoubleClick();return h.gallery.mock.calls[h.gallery.mock.calls.length-1][0];};
        const source=open();const listener=vi.fn(),stop=source.subscribe(listener);
        h.state.pendingGens=[{cat:'characters',assetId:'a',variantId:null,status:'running'}];
        expect(source.canReorder()).toBe(false);source.reorder('rb','ra');
        expect(h.state.setAssetRefImages).not.toHaveBeenCalled();
        h.state.pendingGens=[];select('b');
        expect(source.getItems()).toBeNull();expect(listener).toHaveBeenCalled();stop();
        const next=open();const stopped=vi.fn(),detach=next.subscribe(stopped);unmount();
        expect(next.getItems()).toBeNull();expect(next.canReorder()).toBe(false);expect(stopped).toHaveBeenCalled();
        next.reorder('rb','ra');expect(h.state.setAssetRefImages).not.toHaveBeenCalled();detach();
        expect(h.listeners.size).toBe(0);
    });
    it('提供上传音色/替换音色，并移除恒禁用生成入口',()=>{
        const text=JSON.stringify(draw());expect(text).toContain('上传音色');expect(text).not.toContain('TTS 音色生成暂未实现');
        h.state.characters[0].voiceUri='old.wav';expect(JSON.stringify(draw())).toContain('替换音色');
    });
});
