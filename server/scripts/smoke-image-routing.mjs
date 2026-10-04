import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
assert.ok(existsSync('.qiji-routing-sandbox'),'sandbox required');
let checks=0, outcome='success';const posts=[];
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const ok=(a,label)=>{assert.ok(a,label);checks++;};
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
globalThis.fetch=async(url,init={})=>{
 if(String(url).startsWith('data:image/'))return new Response(Buffer.from(pixel,'base64'),{headers:{'content-type':'image/png'}});
 const u=new URL(String(url));assert.ok(u.hostname.endsWith('.image-routing.test'),'no real upstream');
 if(init.method==='POST'){
  const body=JSON.parse(init.body);posts.push({host:u.hostname,body});
  if(outcome!=='success')return new Response(JSON.stringify({error:{message:outcome==='user'?'审核错误：内容不合规':'internal server error'}}),{status:outcome==='user'?400:503});
  if(body.model?.startsWith('midjourney'))return new Response(JSON.stringify({task_id:'mj-routing-test'}),{status:200});
  return new Response(JSON.stringify({data:[{b64_json:pixel}],candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:pixel}}]}}]}),{status:200});
 }
 if(u.pathname.startsWith('/v1/images/tasks/'))return new Response(JSON.stringify({status:'completed',data:[{url:'https://asset.image-routing.test/result.png'}]}),{status:200});
 if(u.pathname==='/result.png')return new Response(Buffer.from(pixel,'base64'),{headers:{'content-type':'image/png'}});
 throw new Error('Unexpected network '+u.pathname);
};
const routing=await import('../src/autoRouting.ts');
const images=await import('../src/imageRouting.ts');
const channels=await import('../src/store/channels.ts');
const models=await import('../src/store/models.ts');
const {buildCatalog}=await import('../src/catalog.ts');
const {config}=await import('../src/config.ts');config.adminToken='image-routing-admin';config.role='source';
const {default:Fastify}=await import('fastify');const app=Fastify();
await app.register((await import('../src/routes.ts')).registerRoutes);
await app.register((await import('../src/routes/admin.ts')).registerAdminRoutes);
const users=await import('../src/store/users.ts'),tasks=await import('../src/store/tasks.ts');
const observation=await import('../src/routeObservations.ts');
const admin={authorization:'Bearer '+config.adminToken};
try {
 if(process.argv[2]==='restart'){
  const c=routing.routingConfig();eq(c.lines.filter(l=>l.capability==='image').length,22,'default and custom image lines persist');
  eq(routing.withImageRouting(c),c,'extension is idempotent');
  ok(buildCatalog().models.some(m=>m.capability==='image'&&m.id.startsWith('route:')),'public image lines survive');
  eq(c.lines.filter(l=>l.familyId.includes('2-0-')).length,6,'Fast and Mini lines survive restart');
  ok(c.lines.some(l=>l.id==='image-activity-test'&&l.name==='图片活动'),'custom image line survives restart');
  eq(routing.withSeedanceVariantRouting(c),c,'variant extension preserves saved routes after restart');
 }else{
  for(const ch of channels.listChannels())channels.updateChannel(ch.id,{baseUrl:'https://'+ch.id+'.image-routing.test',apiKey:'test-only',enabled:true});
  models.updateModel('gpt-image-2',{imageSizeMap:(await import('../src/imageSizes.ts')).AISC_IMAGE_SIZES});
  const original=routing.routingConfig();const extended=routing.withImageRouting(original);
  eq(extended.lines.filter(l=>l.capability==='image').length,21,'seven distinct image families with three lines each');
  eq(extended.lines.filter(l=>l.capability!=='image'),original.lines,'video configuration preserved');
  routing.saveRoutingConfig(extended);
  eq(routing.withImageRouting(routing.routingConfig()),routing.routingConfig(),'image family initialization is idempotent');
  const catalog=buildCatalog(), pub=catalog.models.filter(m=>m.capability==='image');
  eq(pub.length,6,'six enabled image families; disabled original Banana stays hidden');
  ok(pub.every(m=>m.id.startsWith('route:')),'physical image model IDs hidden');
  ok(!JSON.stringify(pub).match(/ch-jmh|ch-skylee|upstreamModel/),'image catalog hides providers');
  ok(pub.every(m=>m.params.some(p=>p.key==='aspect_ratio')&&m.params.some(p=>p.key==='resolution')&&!m.params.some(p=>p.key==='size')),'image catalog exposes only public ratio and resolution fields');
  eq(images.imageFamilyOf(models.getModelDef('banana pro')),'fam-nano-banana-pro','Pro has own family');
  eq(images.imageFamilyOf(models.getModelDef('banana-2')),'fam-nano-banana-2','Banana 2 has own family');
  eq(new Set(['sky-midjourney-v7','sky-midjourney-v8.1','sky-midjourney-v8.2'].map(id=>images.imageFamilyOf(models.getModelDef(id)))).size,3,'MJ versions independent');
  const invalid=routing.routingConfig();invalid.lines.find(l=>l.familyId==='fam-nano-banana-pro').members=[{...invalid.lines.find(l=>l.id==='image-nano-banana-2-promo').members[0]}];
  assert.throws(()=>routing.saveRoutingConfig(invalid));checks++;
  const gpt=pub.find(m=>m.familyId==='fam-gpt-image-2');eq(gpt.cost,10,'uniform image price is highest configured candidate');
  const request=(model=gpt.id,params={aspect_ratio:'16:9',resolution:'2k',quality:'high'})=>({model,purpose:'image.generate',clientTaskId:'image-test-'+Math.random(),promptOverride:'A blue square',params,inputs:{}});
  const defaults=request(gpt.id,{});eq(routing.prepareRoutingRequest(defaults),undefined,'image defaults accepted');
  eq(defaults.params,{},'preflight does not add defaults to the original image request');
  eq(routing.routingRequestParams(defaults).aspect_ratio,'16:9','capability view reads the default ratio');
  eq(routing.routingRequestParams(defaults).resolution,'2k','pricing view reads the default resolution');
  assert.throws(()=>images.imageUpstreamParams(models.getModelDef('sky-gpt-image-2-low'),request().params),/禁止替换/,'wrong ratio or resolution cannot substitute for 16:9 2K');checks++;
  for(let i=0;i<6;i++){
   const selected=routing.selectRoute(request());ok(images.imageMemberAccepts(models.getModelDef(selected.ticket.modelId),selected.request.params),'every selected candidate can convert the public ratio and resolution');
  }
  const u=users.createUser({name:'图片路由验收',credits:1000}),headers={authorization:'Bearer '+u.accessKey};
  const call=(method,url,payload,h=headers)=>app.inject({method,url,payload,headers:h});
  const done=async id=>{for(let i=0;i<1200;i++){const r=tasks.getTaskState(id);if(['success','failed'].includes(r?.status))return r;await new Promise(r=>setTimeout(r,10));}throw new Error('image task did not finish');};
  for(const req of [request('gpt-image-2'),request(gpt.id,{aspect_ratio:'16:9',resolution:'8k'}),request(gpt.id,{aspect_ratio:'16:9',resolution:'2k',size:'2048x1152'}),request(gpt.id,{aspect_ratio:'16:9',resolution:'2k',watermark:true}),request('route:image-gpt-image-2-budget')])eq((await call('POST','/v1/generate',req)).statusCode,400,'invalid/unopened/raw image request rejected');
  eq(u.credits,1000,'rejections not billed');eq(posts.length,0,'rejections never call upstream');
  // Controlled members exercise Sky GPT, OpenAI and Gemini real translators, not a mock dispatcher.
  const cfg=routing.routingConfig();const line=cfg.lines.find(l=>l.id==='image-gpt-image-2-promo');
  line.members=line.members.filter(m=>m.modelId==='sky-gpt-image-2-low');routing.saveRoutingConfig(cfg);
  let response=await call('POST','/v1/generate',request(gpt.id));eq(response.statusCode,200,'Sky landscape request accepted');
  let task=await done(response.json().taskId);eq(task.status,'success','Sky image pipeline succeeds');
  eq(posts.at(-1).body.size,'1536x1024','Sky receives configured landscape size instead of auto/square');
  const cfgOpenAi=routing.routingConfig();const openAiLine=cfgOpenAi.lines.find(l=>l.id==='image-gpt-image-2-promo');
  openAiLine.members=extended.lines.find(l=>l.id==='image-gpt-image-2-promo').members.filter(m=>m.modelId==='gpt-image-2');routing.saveRoutingConfig(cfgOpenAi);
  response=await call('POST','/v1/generate',request(gpt.id,{aspect_ratio:'1:1',resolution:'2k',quality:'high'}));eq(response.statusCode,200,'image request accepted');
  task=await done(response.json().taskId);eq(task.status,'success','OpenAI image pipeline succeeds');eq(task.result.assets[0].meta.model,gpt.id,'image result keeps public model');
  eq(posts.at(-1).body.size,'2048x2048','OpenAI receives exact pixel size');eq(u.credits,980,'line price charged');
  response=await call('POST','/v1/generate',request('route:image-nano-banana-pro-promo'));
  task=await done(response.json().taskId);eq(task.status,'success','Gemini image pipeline succeeds');
  eq(posts.at(-1).body.generationConfig.imageConfig,{aspectRatio:'16:9',imageSize:'2K'},'Gemini receives native fields for same public image size');
  response=await call('POST','/v1/generate',request('route:image-mj-v8-2-promo'));
  task=await done(response.json().taskId);eq(task.status,'success','MJ submit/poll/asset pipeline succeeds');
  eq(posts.at(-1).body.size,'16:9','MJ receives its native ratio field');
  eq(task.result.assets[0].meta.model,'route:image-mj-v8-2-promo','async image result keeps public model');
  const userLogs=(await call('GET','/v1/logs')).json().items;
  eq(userLogs[0].modelLabel,'Midjourney V8.2 · 优惠','image user history shows family and line');
  const adminLogs=(await call('GET','/admin-api/logs',undefined,admin)).json().items;
  eq(adminLogs.find(l=>l.id===userLogs[0].id).modelLabel,'Midjourney V8.2 · '+models.getModelDef('sky-midjourney-v8.2').label,'image admin history shows actual selected model');
  eq(u.credits,920,'image families bill their own uniform prices');
  const before=u.credits;outcome='user';response=await call('POST','/v1/generate',request(gpt.id,{aspect_ratio:'1:1',resolution:'2k',quality:'high'}));
  eq((await done(response.json().taskId)).status,'failed','review rejected');eq(u.credits,before,'review failure refunded');
  eq(routing.routingHealth()['image-gpt-image-2-promo/ch_mqra5xti3'].failed,0,'review does not damage channel health');
  ok(observation.routingHourlyStats().rows.some(r=>r.lineId==='image-gpt-image-2-promo'&&r.userFailures===1),'image failures feed passive table');
  const available=(await call('GET','/admin-api/auto-routing/availability',undefined,admin)).json();
  ok(available.channels.some(c=>c.familyName==='Nano Banana Pro'),'availability labels image families correctly');
  const adminData=(await call('GET','/admin-api/auto-routing',undefined,admin)).json();ok(adminData.families.some(f=>f.id==='fam-seedance-2-0-fast')&&adminData.families.some(f=>f.id==='fam-minimax'),'default and other registered families have routing pages');
  const beforeToggle=routing.routingConfig();const imageLineId='image-gpt-image-2-promo';
  const disabled=routing.routingConfig();disabled.lines.find(l=>l.id===imageLineId).members.forEach(r=>{r.enabled=false;r.vipEnabled=true;});routing.saveRoutingConfig(disabled);
  ok(!buildCatalog().models.some(m=>m.id==='route:'+imageLineId),'all-disabled image line hidden despite reserved VIP enabled');
  const postCount=posts.length,credits=u.credits;
  eq((await call('POST','/v1/generate',request('route:'+imageLineId))).statusCode,400,'all-disabled image direct call refused');
  eq(posts.length,postCount,'disabled image sends no upstream request');eq(u.credits,credits,'disabled image does not charge');
  const restored=routing.routingConfig();restored.lines=beforeToggle.lines;routing.saveRoutingConfig(restored);
  ok(buildCatalog().models.some(m=>m.id==='route:'+imageLineId),'image line reappears when enabled');
  const additions=routing.withSeedanceVariantRouting(routing.routingConfig());
  additions.lines.push({...structuredClone(additions.lines.find(l=>l.id===imageLineId)),id:'image-activity-test',name:'图片活动',cost:7});
  const imageSave=await call('PUT','/admin-api/auto-routing',additions,admin);eq(imageSave.statusCode,200,'admin API saves custom image and variant routes');
  ok(buildCatalog().models.some(m=>m.id==='route:image-activity-test'&&m.label==='GPT Image 2 · 图片活动'),'custom image line appears with family and activity name');
  writeFileSync('image-routing-initial.json',JSON.stringify(extended,null,2));
 }
 console.log(`IMAGE_ROUTING ${process.argv[2]||'full'} ${checks}/${checks}`);
}finally{await app.close();await (await import('../src/store/db.ts')).flushPendingSaves();(await import('../src/store/sqlite.ts')).closeSqlite();}
