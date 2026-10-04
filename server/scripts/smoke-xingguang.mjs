import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.ok(fs.existsSync(new URL('../.qiji-xingguang-sandbox', import.meta.url)));
let calls=[], reply={id:'task-xg',status:'queued'}, http=200, network=false;
globalThis.fetch=async (url,init)=>{calls.push({url:String(url),...init});if(network)throw Error('offline');return new Response(JSON.stringify(reply),{status:http});};
const {listModels}=await import('../src/store/models.ts');
const {getChannel}=await import('../src/store/channels.ts');
const {getMode}=await import('../src/store/modes.ts');
const {getFamily}=await import('../src/store/families.ts');
const {isBuiltinProtocol}=await import('../src/store/protocols.ts');
const {resolveUpstream}=await import('../src/translators/upstream.ts');
const models=listModels().filter(m=>m.channelId==='ch-xingguang');
assert.equal(models.length,1);
assert.equal(models[0].id,'xg-13');
assert.equal(getChannel('ch-xingguang').name,'星光');assert.equal(getMode('xingguang').name,'星光');
assert.ok(isBuiltinProtocol('xingguang-video'));
assert.equal(models[0].upstreamModel,'seedance2.0-933');
for(const m of models){
  assert.equal(m.protocol,'xingguang-video'); assert.equal(m.enabled,false);
  assert.equal(m.matLimits,undefined);assert.ok(getFamily(m.familyId));
  assert.equal(resolveUpstream(m).baseUrl,'https://xingapi.top/v1');
}
assert.equal(models[0].familyId,'fam-seedance');
assert.equal(models[0].params.find(p=>p.key==='duration').default,'10');
assert.deepEqual(models[0].params.find(p=>p.key==='resolution').options,['720p']);
const {resolveModelCost}=await import('../src/store/models.ts');
const routeReq={model:'xg-13',purpose:'video.generate',params:{duration:12,resolution:'720p'}};
assert.equal(resolveUpstream(models[0],routeReq).upstreamModel,'seedance2.0-933');
assert.equal(resolveModelCost(models[0],routeReq.params),120);
const retained=new URL('../retained.json',import.meta.url);
if(fs.existsSync(retained))assert.deepEqual(listModels().filter(m=>m.channelId!=='ch-xingguang'),JSON.parse(fs.readFileSync(retained)));
const html=fs.readFileSync(new URL('../src/admin/index.html',import.meta.url),'utf8');
for(const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new Function(m[1]);
assert.ok(html.includes('"xingguang-video"'));
const index=fs.readFileSync(new URL('../src/translators/index.ts',import.meta.url),'utf8');
assert.ok(index.includes('"xingguang-video": { submit: submitXingguangVideo, poll: pollXingguangVideo }'));
assert.ok(index.includes('case "xingguang-video":'));assert.ok(index.includes('"xingguang-video": 3000'));
if(process.argv[2]==='seed')console.log('PASS: one generic model, 720p redirect, 10-15s enum, per-second pricing, retained models and admin syntax');
else {
  const {submitXingguangVideo:submit,pollXingguangVideo:poll}=await import('../src/translators/xingguang.ts');
  const up={baseUrl:'https://xingapi.top/v1/',apiKey:'fake-xg-secret',upstreamModel:'seedance2.0-933'};
  const req={model:'xg-13',purpose:'video.generate',promptOverride:'人物动作',params:{duration:37,aspect_ratio:'7:5',resolution:'1440p',watermark:false,extra:{keep:1},firstFrameUrl:'https://ref.example/story.png'},inputs:{images:Array.from({length:12},(_,i)=>({url:`https://ref.example/${i}.png`,name:'图'+i})),videos:[{url:'https://ref.example/v.mp4'}],audios:[{url:'https://ref.example/a.mp3'}]}};
  const before=structuredClone(req),logs=[];
  assert.deepEqual(await submit(req,up,x=>logs.push(x)),{ok:true,taskId:'task-xg'});
  const sent=JSON.parse(calls.at(-1).body);
  assert.equal(calls.at(-1).url,'https://xingapi.top/v1/videos/generations');
  assert.equal(calls.at(-1).headers.Authorization,'Bearer '+up.apiKey);
  assert.equal(sent.duration,37);assert.equal(sent.ratio,'7:5');assert.equal(sent.resolution,'1440p');
  assert.equal(sent.images.length,13);assert.equal(sent.images[0],req.inputs.images[0].url);assert.equal(sent.images[12],req.params.firstFrameUrl);
  assert.deepEqual(sent.videos,['https://ref.example/v.mp4']);assert.deepEqual(sent.audios,['https://ref.example/a.mp3']);
  assert.ok(sent.prompt.includes('@Image13'));assert.ok(sent.prompt.includes('@Video1'));assert.ok(sent.prompt.includes('@Audio1'));
  assert.equal(sent.watermark,false);assert.deepEqual(sent.extra,{keep:1});assert.equal(sent.firstFrameUrl,undefined);
  assert.deepEqual(req,before);assert.ok(!JSON.stringify(logs).includes(up.apiKey));
  await submit({...req,params:routeReq.params}, {...resolveUpstream(models[0],routeReq),apiKey:up.apiKey});
  assert.equal(JSON.parse(calls.at(-1).body).model,'seedance2.0-933');
  assert.equal(JSON.parse(calls.at(-1).body).resolution,'720p');
  assert.equal(JSON.parse(calls.at(-1).body).duration,12);
  // 配置多个分辨率时，同一个逻辑模型按档位选上游并保留请求规格，费用与同一规则一致。
  const multi={...models[0],routes:[{when:{resolution:'480p'},upstreamModel:'same-family-480',costPerUnit:7,cost:105},{when:{resolution:'720p'},upstreamModel:'same-family-720',costPerUnit:10,cost:150}]};
  for(const [resolution,model,cost] of [['480p','same-family-480',84],['720p','same-family-720',120]]){
    const r={...req,params:{resolution,duration:12}};
    await submit(r,{...resolveUpstream(multi,r),apiKey:up.apiKey});
    const body=JSON.parse(calls.at(-1).body);assert.equal(body.model,model);assert.equal(body.resolution,resolution);assert.equal(resolveModelCost(multi,r.params),cost);
  }
  const {compactXingguangModels,XINGGUANG_RETIRED_IDS}=await import('../src/store/xingguangModels.ts');
  const custom=structuredClone(models[0]); custom.label='用户命名';custom.costPerUnit=23;custom.cost=345;
  custom.routes=[{when:{resolution:'1080p'},upstreamModel:'custom-upstream',costPerUnit:27,cost:405}];
  custom.params.find(p=>p.key==='resolution').options=['1080p'];custom.params.find(p=>p.key==='resolution').default='1080p';
  const customBefore=structuredClone(custom),fixture={models:[custom,...XINGGUANG_RETIRED_IDS.map(id=>({...custom,id}))]};
  assert.equal(compactXingguangModels(fixture),true);assert.equal(fixture.models.length,1);assert.deepEqual(fixture.models[0],customBefore);
  assert.deepEqual(fixture.deletedSeedIds,XINGGUANG_RETIRED_IDS);const once=structuredClone(fixture);
  assert.equal(compactXingguangModels(fixture),false);assert.deepEqual(fixture,once);
  await submit({...req,params:{}},{...up,baseUrl:'https://xingapi.top'});assert.equal(calls.at(-1).url,'https://xingapi.top/v1/videos/generations');
  assert.equal(JSON.parse(calls.at(-1).body).duration,10);assert.equal(JSON.parse(calls.at(-1).body).resolution,undefined);
  for(const bad of [ {...req,promptOverride:'',inputs:{}}, {...req,inputs:{images:[{url:'data:image/png;base64,QQ=='}]}}, {...req,inputs:{audios:[{url:'http://localhost/a'}]}}, {...req,params:{ratio:'1:1',aspect_ratio:'16:9'}}, {...req,params:{lastFrameUrl:'https://ref.example/tail.png'}}, {...req,params:{images:['https://ref.example/extra.png']}} ]){
    const count=calls.length;assert.equal((await submit(bad,up)).ok,false);assert.equal(calls.length,count);
  }
  for(const badUp of [{...up,apiKey:''},{...up,upstreamModel:''}]){const count=calls.length;assert.equal((await submit(req,badUp)).ok,false);assert.equal(calls.length,count);}
  reply={task_id:123};assert.deepEqual(await submit(req,up),{ok:true,taskId:'123'});
  reply={data:{id:'nested'}};assert.deepEqual(await submit(req,up),{ok:true,taskId:'nested'});
  reply={error:{message:'余额不足'}};assert.equal((await submit(req,up)).error,'余额不足');
  reply={};assert.equal((await submit(req,up)).ok,false);
  network=true;const count=calls.length;assert.equal((await submit(req,up)).ok,false);assert.equal(calls.length,count+1);network=false;
  for(const status of ['queued','pending','running','processing','in_progress','future-state']){reply={status,video_url:'https://cdn.example/out.mp4'};assert.equal((await poll(up,'a/b')).status,['queued','pending'].includes(status)?'queued':'running');}
  assert.ok(calls.at(-1).url.endsWith('/a%2Fb'));
  for(const status of ['success','completed','succeeded','done','finished']){
    reply={status};const r=await poll(up,'a/b');assert.equal(r.status,'completed');assert.equal(r.videoUrl,'https://xingapi.top/v1/videos/a%2Fb/content');assert.equal(r.resultHeaders.Authorization,'Bearer '+up.apiKey);
  }
  reply={data:{status:'done',url:'https://cdn.example/out.mp4'}};assert.equal((await poll(up,'x')).resultHeaders,undefined);
  reply={status:'done',url:'http://xingapi.top/out.mp4'};assert.equal((await poll(up,'x')).resultHeaders,undefined);
  for(const status of ['failed','error','cancelled','canceled']){reply={status,message:'审核不通过'};assert.equal((await poll(up,'x')).error,'审核不通过');}
  reply={status:'done'};for(const status of [429,500,503]){http=status;assert.equal((await poll(up,'x')).status,'running');}
  http=401;assert.equal((await poll(up,'x')).status,'failed');http=200;network=true;assert.equal((await poll(up,'x')).status,'running');network=false;
  const {scrubChannelInfo}=await import('../src/errorScrub.ts');
  const scrubbed=scrubChannelInfo('星光 XingAPI https://xingapi.top failure');
  assert.ok(scrubbed.includes('星光'));assert.ok(!scrubbed.includes('xingapi.top'));assert.ok(!scrubbed.includes('XingAPI'));
  const {buildCatalog}=await import('../src/catalog.ts');
  assert.ok(!buildCatalog().models.some(m=>m.id.startsWith('xg-')));
  console.log('PASS: submit, all media, exact params, guards, no retry, poll status families, content fallback, download auth, error scrub and catalog closed; zero live upstream calls');
}
