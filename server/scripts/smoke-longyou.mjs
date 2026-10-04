import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
assert.ok(existsSync(new URL('../.qiji-longyou-sandbox', import.meta.url)), 'isolated sandbox required');
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++};
let calls=[],reply={task_id:'task_test',status:'queued'},http=200,network=false;
globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),...init});if(network)throw Error('network');return new Response(JSON.stringify(reply),{status:http})};
const models=await import('../src/store/models.ts'), channels=await import('../src/store/channels.ts'), modes=await import('../src/store/modes.ts');
const {isBuiltinProtocol}=await import('../src/store/protocols.ts');
const {resolveUpstream}=await import('../src/translators/upstream.ts');
const {buildCatalog}=await import('../src/catalog.ts');
const ids=['mini','fast','standard'].map(t=>'ly2-videos-'+t),phase=process.argv[2]||'seed';
if(phase==='tombstones'){
 for(const id of ids)check(!models.getModelDef(id),'deleted model remains absent');
 check(!channels.getChannel('ch-longyou-v2'),'deleted channel absent');check(!modes.listModes().some(m=>m.id==='longyou-v2'),'deleted mode absent');
}else{
 for(const id of ids){const m=models.getModelDef(id);check(m?.protocol==='longyou-video','protocol');check(m.upstreamModel===id.slice(4),'exact upstream name');check(!m.enabled&&m.shareScope==='none','closed seed');check(m.matLimits.aud===0&&m.matLimits.img===undefined&&m.matLimits.vid===undefined,'only documented material limits');check(!m.familyId,'unknown family not guessed');check(models.resolveModelCost(m,{duration:23})===230,'per second placeholder');check(resolveUpstream(m).baseUrl==='https://api.hjmie.cc.cd/v1','base URL');check(!buildCatalog().models.some(x=>x.id===id),'closed catalog');}
 check(channels.getChannel('ch-longyou-v2')?.apiKey==='','empty key');check(modes.listModes().some(m=>m.id==='longyou-v2'&&m.name==='龙幽'),'mode');check(isBuiltinProtocol('longyou-video'),'builtin protocol');
 const retained=new URL('../retained.json',import.meta.url);if(existsSync(retained)){assert.deepEqual(models.listModels().filter(m=>!ids.includes(m.id)),JSON.parse(readFileSync(retained,'utf8')));checks++;}
}
if(phase==='fixture'){
 const read=n=>JSON.parse(readFileSync(new URL('../data/'+n+'.json',import.meta.url),'utf8'));
 const write=(n,v)=>writeFileSync(new URL('../data/'+n+'.json',import.meta.url),JSON.stringify(v));
 const m=read('models');m.models=m.models.filter(x=>!ids.includes(x.id));m.models[0].cost=12345;m.models[0].label='preserved admin label';write('models',m);writeFileSync(new URL('../retained.json',import.meta.url),JSON.stringify(m.models));
 m.deletedSeedIds=[...new Set([...(m.deletedSeedIds||[]),'ly-videos-mini','ly-videos-fast','ly-videos-standard'])];write('models',m);
 const c=read('channels');c.channels=c.channels.filter(x=>x.id!=='ch-longyou-v2');c.deletedSeedIds=[...(c.deletedSeedIds||[]),'ch-longyou'];write('channels',c);
 const o=read('modes');o.modes=o.modes.filter(x=>x.id!=='longyou-v2');o.deletedSeedIds=[...(o.deletedSeedIds||[]),'longyou'];o.seedVersion=27;write('modes',o);
}
if(phase==='full'){
 const {submitLongyouVideo:submit,pollLongyouVideo:poll}=await import('../src/translators/longyou.ts');
 const up={baseUrl:'https://api.hjmie.cc.cd/v1',apiKey:'sk-longyou-sandbox-secret',upstreamModel:'videos-standard'};
 const req=(extra={})=>({modelId:ids[2],capability:'video',purpose:'video.generate',promptOverride:'主角@Image1 看向视频1',params:{duration:15,aspect_ratio:'16:9',resolution:'480p'},...extra});
 const refs=n=>Array.from({length:n},(_,i)=>({url:`https://assets.example.com/${i}.png`,name:'角色'+i}));
 const reset=(r={task_id:'task_test',status:'queued'},s=200)=>{calls=[];reply=r;http=s;network=false};
 let records=[];let r=await submit(req({inputs:{images:refs(12),videos:refs(2)}}),up,x=>records.push(x));
 check(r.ok&&r.taskId==='task_test','task accepted');const body=JSON.parse(calls[0].body);
 check(calls[0].url==='https://api.hjmie.cc.cd/v1/videos','no doubled v1');check(calls[0].headers.Authorization==='Bearer '+up.apiKey,'Bearer');
 check(body.model===up.upstreamModel&&body.duration===15&&body.ratio==='16:9'&&body.resolution==='480p','mapping');
 check(body.images.length===12&&body.videos.length===2&&!body.referenceImages&&!body.audios,'flat arrays preserved');check(body.prompt.includes('图片12')&&!body.prompt.includes('@Image'),'Chinese reference numbers');check(!JSON.stringify(records).includes(up.apiKey),'masked log');
 reset({id:'id-only'},202);check((await submit(req(),{...up,baseUrl:'https://api.hjmie.cc.cd/'})).ok&&calls[0].url.endsWith('/v1/videos'),'root base and id fallback');
 reset();await submit(req({params:{duration:'47',aspect_ratio:'13:7',resolution:'8k'}}),up);const explicit=JSON.parse(calls[0].body);check(explicit.duration===47&&explicit.ratio==='13:7'&&explicit.resolution==='8k','no clamping');
 const priced={...models.getModelDef(ids[2]),apiKey:up.apiKey,routes:[{when:{resolution:'480p'},upstreamModel:'videos-standard',costPerUnit:80,cost:1200},{when:{resolution:'720p'},upstreamModel:'videos-standard',costPerUnit:100,cost:1500}]};
 for(const [resolution,rate] of [['480p',80],['720p',100]])for(const duration of [4,15]){
  const request=req({params:{resolution,duration}}),resolved=resolveUpstream(priced,request);
  check(models.resolveModelCost(priced,request.params)===rate*duration,'resolution route price '+resolution+'/'+duration);
  reset();await submit(request,resolved);const sent=JSON.parse(calls[0].body);
  check(sent.model==='videos-standard'&&sent.resolution===resolution&&sent.duration===duration,'same model distinct resolution request');
 }
 reset();await submit(req({params:{}}),up);const defaults=JSON.parse(calls[0].body);check(defaults.duration===15&&!defaults.ratio&&!defaults.resolution,'missing values only');
 reset();await submit(req({inputs:{images:refs(2)},params:{firstFrameUrl:'https://assets.example.com/board.png'}}),up);check(JSON.parse(calls[0].body).images[2].endsWith('/board.png'),'storyboard append keeps numbering');
 for(const [label,q,u] of [
 ['no key',req(),{...up,apiKey:''}],['no model',req(),{...up,upstreamModel:''}],['empty',req({promptOverride:'{}',inputs:{images:refs(1)}}),up],
 ['audio',req({inputs:{audios:[{id:'unresolved'}]}}),up],['missing image',req({inputs:{images:[...refs(1),{id:'missing'}]}}),up],
 ['local',req({inputs:{images:[{url:'http://127.0.0.1/a.png'}]}}),up],['frames',req({params:{method:'frames'}}),up],
 ...[0,-1,2.5,'nope'].map(n=>['invalid duration '+n,req({params:{duration:n}}),up])
 ]){reset();check(!(await submit(q,u)).ok&&calls.length===0,label+' rejected before POST');}
 for(const [r,s] of [[{error:{message:'bad request'}},400],[{status:'FAILED',fail_reason:'review failed'},200],[{},200]]){reset(r,s);check(!(await submit(req(),up)).ok,'bad submit response');check(calls.length===1,'no resubmit');}
 for(const st of ['queued','QUEUED','in_progress','STORING','success','error','unknown','']){reset({status:st,video_url:'https://cdn.example.com/premature.mp4'});check(['queued','running'].includes((await poll(up,'a/b')).status),'URL never wins over '+st);check(calls[0].url.endsWith('/a%2Fb'),'encoded task path');}
 for(const st of ['completed','SUCCEEDED']){reset({status:st,video_url:'https://api.hjmie.cc.cd/v1/videos/a/content?video_token=test'});const p=await poll(up,'a');check(p.status==='completed'&&!p.resultHeaders,'completed token URL');}
 reset({status:'completed',metadata:{final_video_url:'https://cdn.example.com/v.mp4'}});const cdn=await poll(up,'a');check(cdn.status==='completed'&&!cdn.resultHeaders,'CDN no generation key');
 reset({status:'completed'});check((await poll(up,'a')).status==='failed','no URL fails');
 for(const st of ['failed','FAILED','cancelled']){reset({status:st,fail_reason:'review failed'});const p=await poll(up,'a');check(p.status==='failed'&&p.error==='review failed','failure reason '+st);}
 for(const status of [429,500,503]){reset({},status);check((await poll(up,'a')).status==='running','transient retry '+status);}
 reset();network=true;check((await poll(up,'a')).status==='running','network retry');reset({},404);check((await poll(up,'a')).status==='failed','404 explicit failure');
 check(!channels.getChannel('ch-longyou')&&!models.getModelDef('ly-videos-mini')&&!modes.listModes().some(x=>x.id==='longyou'),'retired IDs stay absent');
 models.updateModel(ids[2],{enabled:true,shareScope:'all'});check(!buildCatalog().models.some(x=>x.id===ids[2]),'raw video model cannot bypass routes');
 // Synthetic family binding only in the isolated test, not an upstream identity claim.
 models.updateModel(ids[2],{familyId:'fam-seedance'});
 const routing=await import('../src/autoRouting.ts');
 routing.saveRoutingConfig({...routing.routingConfig(),lines:[{id:'longyou-test',name:'测试线路',familyId:'fam-seedance',modelVersion:'2.0',enabled:true,cost:150,members:[{modelId:ids[2],enabled:true,priority:0,concurrencyWeight:1,failureThreshold:3,failureWindowSec:300,cooldownSec:300,failureRetainPercent:50,defaults:{}}]}]});
 const projected=buildCatalog().models.find(x=>x.id==='route:longyou-test');check(!!projected&&!('protocol'in projected)&&!('upstreamModel'in projected)&&!JSON.stringify(projected).includes('hjmie'),'public route projection');
 const {scrubChannelInfo}=await import('../src/errorScrub.ts');const clean=scrubChannelInfo('龙幽 longyou https://api.hjmie.cc.cd/v1/videos');check(clean.includes('龙幽')&&!clean.includes('hjmie')&&!clean.includes('longyou'),'mode retained provider scrubbed');
 const index=readFileSync(new URL('../src/translators/index.ts',import.meta.url),'utf8');check(index.includes('"longyou-video": { submit: submitLongyouVideo, poll: pollLongyouVideo }')&&index.includes('case "longyou-video":')&&index.includes('"longyou-video": 3000'),'driver dispatch and cadence');
 const {dispatchGenerate}=await import('../src/translators/index.ts');
 const {getTaskState}=await import('../src/store/tasks.ts');
 channels.updateChannel('ch-longyou-v2',{apiKey:up.apiKey});
 for(const terminal of ['completed','failed']){
  calls=[];
  globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),...init});return new Response(JSON.stringify(init.method==='POST'?{task_id:'task_dispatch_'+terminal,status:'queued'}:{status:terminal,video_url:'https://cdn.example.com/v.mp4',fail_reason:'fixture rejected'}),{status:200})};
  const task=await dispatchGenerate({...req(),model:ids[2]});check(task.kind==='async','real driver dispatch');
  const deadline=Date.now()+7000;let value;
  do{await new Promise(r=>setTimeout(r,100));value=getTaskState(task.taskId)}while(!['success','failed'].includes(value?.status)&&Date.now()<deadline);
  check(value.status===(terminal==='completed'?'success':'failed'),'unified task terminal '+terminal);
  check(calls.filter(c=>c.method==='POST').length===1,'only one submission');
  if(terminal==='completed')check(value.result.assets[0].meta.rehosted===false,'unconfigured OSS fallback is explicit');
 }
 for(const id of ids)models.deleteModel(id);modes.deleteMode('longyou-v2');channels.deleteChannel('ch-longyou-v2');
}
console.log(`LONGYOU_${phase.toUpperCase()} ${checks}/${checks}`);
