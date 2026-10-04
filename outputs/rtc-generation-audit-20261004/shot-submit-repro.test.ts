import {beforeEach,describe,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({state:{} as any,resolve:null as any,upload:vi.fn(),submits:[] as any[],swap:vi.fn()}));
vi.mock('@/store/projectStore',()=>({useProjectStore:{getState:()=>h.state}}));
vi.mock('@/store/connectionStore',()=>({getDualModeFeature:()=>true}));
vi.mock('@/store/catalogStore',()=>({useCatalogStore:{getState:()=>({model:()=>undefined})}}));
vi.mock('@/services/materialPolicy',()=>({supportsOfficialMaterials:()=>false}));
vi.mock('@/services/generationQueue',()=>({startShotGeneration:(spec:any)=>{h.submits.push({owner:h.state.projectInstanceId,spec});return 'pending-1'}}));
vi.mock('@/components/ModelPicker',()=>({effectiveModelKey:()=> 'model-1'}));
vi.mock('@/lib/publicUrl',()=>({ensurePublicUrl:h.upload}));
vi.mock('@/lib/shotMaterials',()=>({mediaOf:(m:any)=>m.media||'image'}));
vi.mock('@/lib/shotMaterialOps',()=>({identityIndexesForMaterials:()=>[],isIdentityShotMaterial:()=>false}));
vi.mock('@/lib/assetVars',()=>({buildAssetListVars:()=>({})}));
vi.mock('@/lib/inferContext',()=>({buildNeighborVars:()=>({})}));
vi.mock('@/lib/presetSchemes',()=>({resolvePresets:(s:string)=>s,countUnifiedShots:()=>1,gridPresetForShotCount:()=>'',presetBody:()=>'',hasGridInstruction:()=>true}));
vi.mock('@/lib/modelOptions',()=>({imageResolutionOptionsForKey:()=>[],modelMethodsForKey:()=>['reference'],videoReqOptionsForKey:()=>({durations:[],resolutions:[],aspects:[]})}));
vi.mock('@/lib/smartInferPrompts',()=>({SMART_INFER_SINGLE_TPL:'single',SMART_INFER_UNIFIED_SINGLE_TPL:'unified'}));
vi.mock('@/rtc/panel/placeholderSwap',()=>({armPlaceholderSwap:h.swap}));
import {genShotVideo,genShotStoryboard} from '@/rtc/panel/shotGenActions';
const makeState=()=>({projectInstanceId:'A',mediaSettings:{imgVideoSameSource:true,genWithAsset:true},episodes:[{id:'ep',shots:[{id:'shot',title:'A-shot',unifiedPrompt:'A prompt',materials:[{id:'mat',uri:'local://A.png',media:'image',name:'A ref'}]}]}],blobByUri:()=>undefined});
beforeEach(()=>{h.state=makeState();h.submits=[];h.upload.mockReset();h.swap.mockReset();globalThis.alert=vi.fn() as any;});
describe('audit reproduction only - zero network',()=>{
 for(const [name,fn] of [['video',genShotVideo],['storyboard',genShotStoryboard]] as const){
 it(name+' started in A is submitted under B after material await',async()=>{
 h.upload.mockImplementation(()=>new Promise(r=>{h.resolve=r}));
 const pending=fn('ep','shot',{swapSegId:'same-seg'});
 h.state={...makeState(),projectInstanceId:'B',episodes:[]};
 h.resolve('https://mock.invalid/A.png');
 expect(await pending).toBe(true);
 expect(h.submits).toHaveLength(1);
 expect(h.submits[0].owner).toBe('B');
 expect(h.submits[0].spec.prompt).toBe('A prompt');
 expect(h.submits[0].spec.episodeId).toBe('ep');
 });}
 it('two clicks while material upload waits submit two paid jobs for the same shot and placeholder',async()=>{
 const resolvers:any[]=[];h.upload.mockImplementation(()=>new Promise(r=>resolvers.push(r)));
 const first=genShotVideo('ep','shot',{swapSegId:'same-seg'});
 const second=genShotVideo('ep','shot',{swapSegId:'same-seg'});
 expect(resolvers).toHaveLength(2);
 resolvers.forEach(r=>r('https://mock.invalid/A.png'));
 expect(await Promise.all([first,second])).toEqual([true,true]);
 expect(h.submits).toHaveLength(2);expect(h.swap).toHaveBeenCalledTimes(2);
 });
 it('selected storyboard upload failure silently submits without first frame',async()=>{
 h.state.mediaSettings.genWithStory=true;h.state.mediaSettings.genWithAsset=false;
 h.state.episodes[0].shots[0].storyboardUri='local://missing-story.png';
 h.upload.mockResolvedValue('');
 expect(await genShotVideo('ep','shot')).toBe(true);
 expect(h.submits).toHaveLength(1);
 expect(h.submits[0].spec.params.firstFrameUrl).toBeUndefined();
 expect(globalThis.alert).not.toHaveBeenCalled();
 });
});

