// Run only in an isolated source mirror, with no production data or .env.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { S3Client } from '@aws-sdk/client-s3';
assert.match(process.cwd(), /qiji-result-storage-/);
Object.assign(process.env, { ADMIN_TOKEN: 'test-admin', OSS_ENDPOINT: 'https://oss.invalid', OSS_BUCKET: 'test', OSS_PUBLIC_BASE: 'https://cdn.invalid', OSS_ACCESS_KEY_ID: 'fake', OSS_SECRET_ACCESS_KEY: 'fake' });
let puts = 0;
S3Client.prototype.send = async function(command) {
  assert.equal(command.constructor.name, 'PutObjectCommand');
  puts++; return { ETag: 'fake-etag' };
};
const downloads = [], submits = [];
const privateDownloads = [];
const privateKey = 'private-result-fixture-key';
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('https://private.invalid/')) {
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${privateKey}`);
    if (init.method === 'POST') return Response.json({ task_id: JSON.parse(init.body).model });
    if (url.endsWith('/content')) {
      privateDownloads.push(url);
      if (url.includes('private-denied')) return new Response('denied', { status: 401 });
      return new Response(Buffer.from('private result bytes'), { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (url.includes('/images/tasks/')) return Response.json({ status: 'COMPLETED', result_url: url + '/content' });
    return Response.json({ status: 'completed' });
  }
  if (url === 'https://up.invalid/v1/videos' && init.method === 'POST') {
    const body = JSON.parse(init.body); submits.push(body.model);
    return Response.json({ id: body.model });
  }
  if (url.startsWith('https://up.invalid/v1/videos/')) return Response.json({ status: 'completed', video_url: `https://result.invalid/${url.split('/').at(-1)}.mp4` });
  if (url === 'https://up.invalid/v1/images/generations') {
    const body = JSON.parse(init.body);
    return Response.json({ data: [body.model.includes('bytes') ? { b64_json: Buffer.from(body.model).toString('base64') } : { url: `https://result.invalid/${body.model}.png` }] });
  }
  if (url.startsWith('https://result.invalid/')) { downloads.push(url); return new Response(Buffer.from(url), { headers: { 'content-type': url.endsWith('.mp4') ? 'video/mp4' : 'image/png' } }); }
  throw Error('Unexpected network: ' + url);
};
const models = await import('../src/store/models.ts');
const tasks = await import('../src/store/tasks.ts');
const assets = await import('../src/store/assets.ts');
const {dispatchGenerate, resumeVideoPolling} = await import('../src/translators/index.ts');
const {withResultStorage} = await import('../src/translators/resultStorage.ts');
const {readImageResult} = await import('../src/translators/openai.ts');
const make = (id, capability, saveToOss) => models.createModel({ id, label:id, capability, protocol:capability === 'video' ? 'openai-video' : 'openai-image', baseUrl:'https://up.invalid', apiKey:'fake', params:[], enabled:true, ...(saveToOss === undefined ? {} : {saveToOss}) });
const request = id => ({model:id,purpose:id.startsWith('v')?'video.generate':'asset.character',clientTaskId:'client-'+id,inputs:{text:'test'},params:{prompt:'test',duration:5}});
async function waitTask(id) {
  for(let i=0;i<130;i++){const t=tasks.getTaskState(id);if(t?.status==='success')return t.result.assets[0];if(t?.status==='failed')throw Error(t.error);await new Promise(r=>setTimeout(r,100));}
  throw Error('Task timeout '+id);
}
let checks=0;
function check(fn){fn();checks++;}
make('image-default','image');make('image-no','image',false);make('image-bytes-no','image',false);
check(()=>assert.equal(models.getModelDef('image-default').saveToOss,true));
check(()=>assert.throws(()=>models.updateModel('image-no',{saveToOss:'false'}),/布尔值/));
const Fastify=(await import('fastify')).default;
const app=Fastify();await app.register((await import('../src/routes/admin.ts')).registerAdminRoutes);
const headers={authorization:'Bearer test-admin'};
let res=await app.inject({method:'PUT',url:'/admin-api/models/image-no',headers,payload:{saveToOss:true}});
check(()=>assert.equal(res.statusCode,200));check(()=>assert.equal(res.json().saveToOss,true));
res=await app.inject({method:'PUT',url:'/admin-api/models/image-no',headers,payload:{saveToOss:false}});
check(()=>assert.equal(res.json().saveToOss,false));
res=await app.inject({method:'PUT',url:'/admin-api/models/image-no',headers,payload:{saveToOss:'false'}});
check(()=>assert.equal(res.statusCode,400));check(()=>assert.equal(models.getModelDef('image-no').saveToOss,false));
check(()=>assert.equal(JSON.parse(fs.readFileSync('data/models.json')).models.find(m=>m.id==='image-no').saveToOss,false));
const results=await Promise.all(['image-default','image-no','image-bytes-no'].map(async id=>{const t=await dispatchGenerate(request(id));return waitTask(t.taskId)}));
check(()=>assert.match(results[0].url,/^https:\/\/test\.oss\.invalid\//));
check(()=>assert.equal(results[1].url,'https://result.invalid/image-no.png'));
check(()=>assert.equal(results[1].meta.saveToOss,false));
check(()=>assert.ok(!downloads.some(u=>u.includes('image-no'))));
check(()=>assert.equal(results[2].meta.saveToOss,false));
check(()=>assert.equal(assets.getAsset(results[2].id).ossKey,undefined));
check(()=>assert.equal(puts,1));
await assets.retryPendingOssUploads();check(()=>assert.equal(puts,1));
models.createModel({id:'stub-no',label:'stub',capability:'image',protocol:'stub',params:[],saveToOss:false});
const stub=await dispatchGenerate(request('stub-no'));
const stubResult=await waitTask(stub.taskId);
check(()=>assert.equal(stubResult.meta.saveToOss,false));check(()=>assert.equal(puts,1));
// AsyncLocalStorage must keep simultaneous requests with different choices isolated.
const [direct,stored]=await Promise.all([withResultStorage(false,()=>readImageResult({data:[{url:'https://result.invalid/context-no.png'}]})),withResultStorage(true,()=>readImageResult({data:[{url:'https://result.invalid/context-yes.png'}]}))]);
check(()=>assert.ok(direct.ok&&'url' in direct));check(()=>assert.ok(stored.ok&&'data' in stored));
make('video-no','video',false);make('video-yes','video',true);
const no=await dispatchGenerate(request('video-no')),yes=await dispatchGenerate(request('video-yes'));
await new Promise(r=>setTimeout(r,30));
check(()=>assert.equal(tasks.listPendingTasks().find(t=>t.taskId===no.taskId).resume.saveToOss,false));
models.updateModel('video-no',{saveToOss:true});models.updateModel('video-yes',{saveToOss:false});
const [vn,vy]=await Promise.all([waitTask(no.taskId),waitTask(yes.taskId)]);
check(()=>assert.equal(vn.url,'https://result.invalid/video-no.mp4'));
check(()=>assert.equal(vn.meta.saveToOss,false));
check(()=>assert.match(vy.url,/^https:\/\/test\.oss\.invalid\//));
check(()=>assert.ok(!downloads.some(u=>u.includes('video-no'))));
check(()=>assert.equal(puts,2));
check(()=>assert.equal(tasks.rewriteTaskRawResult(no.taskId,'test',{id:vy.id,url:vy.url}).ok,false));
// Reconstruct persisted resume state: no submit occurs and its original storage choice wins.
const resumed=tasks.createRunningTask('video','resume-client');
tasks.setTaskResume(resumed.taskId,{kind:'video',protocol:'openai-video',model:'video-no',upstreamTaskId:'resume-no',capability:'video',saveToOss:false});
check(()=>assert.equal(resumeVideoPolling(resumed),true));
const vr=await waitTask(resumed.taskId);
check(()=>assert.equal(vr.meta.saveToOss,false));check(()=>assert.equal(vr.url,'https://result.invalid/resume-no.mp4'));
check(()=>assert.equal(submits.length,2));check(()=>assert.equal(puts,2));
// Authenticated results cannot be handed to the client as a bare upstream URL.
// Exercise the actual drivers, task route URL fill, and existing public /raw endpoint.
const clientApi=Fastify();await clientApi.register((await import('../src/routes.ts')).registerRoutes);
const users=await import('../src/store/users.ts');
const logs=await import('../src/store/logs.ts');
const {settle}=await import('../src/store/credits.ts');
const owner=users.createUser({name:'private result owner',credits:100});
const other=users.createUser({name:'other result user',credits:100});
const privateModel=(id,capability,protocol)=>models.createModel({id,label:id,capability,protocol,baseUrl:'https://private.invalid',apiKey:privateKey,params:[],enabled:true,saveToOss:false});
privateModel('private-video-no','video','xingguang-video');
privateModel('private-image-no','image','jmz-image');
privateModel('private-denied','video','xingguang-video');
const privateDispatch=async(id,logId)=>{
  const out=await assets.runWithAssetOwner({userId:owner.id},()=>dispatchGenerate({...request(id),purpose:id.includes('image')?'asset.character':'video.generate',promptOverride:'test'},logId));
  tasks.setTaskOwner(out.taskId,owner.id);return out;
};
const pv=await privateDispatch('private-video-no'),pi=await privateDispatch('private-image-no');
const failedLog=logs.startLog({req:{model:'private-denied',purpose:'video.generate',inputs:{},params:{}},userId:owner.id,cost:7});
check(()=>assert.equal(settle({reason:'generate',ref:failedLog.id,payerId:owner.id,statsUserId:owner.id,userAmount:7,agents:[]}).ok,true));
const denied=await privateDispatch('private-denied',failedLog.id);tasks.setTaskBilling(denied.taskId,owner.id,7);
// A recovered task retains its capability; use the same private-result driver to cover audio delivery too.
const pa=tasks.createRunningTask('audio','private-audio-client');
tasks.setTaskOwner(pa.taskId,owner.id);
tasks.setTaskResume(pa.taskId,{kind:'video',protocol:'xingguang-video',model:'private-video-no',upstreamTaskId:'private-audio',purpose:'audio.tts',capability:'audio',saveToOss:false});
check(()=>assert.equal(assets.runWithAssetOwner({userId:owner.id},()=>resumeVideoPolling(pa)),true));
const privateAssets=await Promise.all([waitTask(pv.taskId),waitTask(pi.taskId),waitTask(pa.taskId)]);
for (const [index,task] of [pv,pi,pa].entries()) {
  const asset=privateAssets[index],meta=assets.getAsset(asset.id);
  check(()=>assert.equal(asset.meta.saveToOss,false));
  check(()=>assert.equal(meta.userId,owner.id));
  check(()=>assert.equal(meta.ossKey,undefined));
  check(()=>assert.equal(meta.contentType,['video/mp4','image/png','audio/mpeg'][index]));
  const response=await clientApi.inject({method:'GET',url:'/v1/tasks/'+task.taskId,headers:{authorization:'Bearer '+owner.accessKey}});
  check(()=>assert.equal(response.statusCode,200));
  check(()=>assert.ok(!response.body.includes(privateKey)&&!response.body.includes('private.invalid')&&!response.body.includes('Authorization')));
  const rawUrl=response.json().result.assets[0].url;
  check(()=>assert.match(rawUrl,/\/v1\/assets\/[^/]+\/raw$/));
  const raw=await clientApi.inject({method:'GET',url:new URL(rawUrl).pathname});
  check(()=>assert.equal(raw.statusCode,200));
  check(()=>assert.equal(raw.body,'private result bytes'));
  const forbidden=await clientApi.inject({method:'GET',url:'/v1/tasks/'+task.taskId,headers:{authorization:'Bearer '+other.accessKey}});
  check(()=>assert.equal(forbidden.statusCode,404));
  check(()=>assert.equal(tasks.rewriteTaskRawResult(task.taskId,owner.id,{id:vy.id,url:vy.url}).ok,false));
}
const deniedState=tasks.getTaskState(denied.taskId);
check(()=>assert.equal(deniedState.status,'failed'));
check(()=>assert.match(deniedState.error,/HTTP 401/));
check(()=>assert.equal(deniedState.result,undefined));
check(()=>assert.equal(logs.getLog(failedLog.id).status,'failed'));
check(()=>assert.equal(users.getUser(owner.id).credits,100));
check(()=>assert.equal(privateDownloads.length,4));
await assets.retryPendingOssUploads();check(()=>assert.equal(puts,2));
await clientApi.close();
await app.close();await (await import('../src/store/db.ts')).flushPendingSaves();
const savedTasks=fs.readFileSync('data/tasks.json','utf8');
check(()=>assert.ok(!savedTasks.includes(privateKey)));
fs.writeFileSync('private-result-ids.json',JSON.stringify(privateAssets.map(a=>a.id)));
console.log(JSON.stringify({checks,puts,downloads:downloads.length,submits:submits.length,realNetworkCalls:0}));
