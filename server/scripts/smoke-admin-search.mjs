import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.match(process.cwd(), /qiji-admin-search-/);
assert.ok(!fs.existsSync('.env'));
process.env.ADMIN_TOKEN='test-admin';
const sent=[];
globalThis.fetch=async(url,init)=>{
 if(String(url)==='https://image.test/v1/images/generations'&&init?.method==='POST'){
  sent.push(JSON.parse(init.body));return new Response(JSON.stringify({data:[{url:'https://image.test/result.png'}]}),{status:200});
 }
 throw new Error('No external requests allowed');
};
const {default:Fastify}=await import('fastify');
const models=await import('../src/store/models.ts');
const logs=await import('../src/store/logs.ts');
const observations=await import('../src/routeObservations.ts');
const app=Fastify();
await app.register((await import('../src/routes/admin.ts')).registerAdminRoutes);
let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const call=(url,method='GET',payload)=>app.inject({url,method,payload,headers:{authorization:'Bearer test-admin'}});
for(const [id,capability] of [['seedance 2.0','video'],['image-test','image'],['text-test','text'],['audio-test','audio']])models.createModel({id,label:id==='seedance 2.0'?'高速二':id,capability,protocol:'stub',params:[],enabled:true});
for(const [model,purpose] of [['seedance 2.0','video.generate'],['image-test','asset.scene.image'],['text-test','storyboard.unifiedShot'],['audio-test','audio.tts']])logs.startLog({req:{model,purpose,inputs:{text:'test'},params:{}},userName:'sandbox',cost:10});
const routed=logs.startLog({req:{model:'route:family-name-only',purpose:'video.generate',params:{}},userName:'sandbox',cost:10});
observations.beginRouteObservation(routed.id,{lineId:'family-name-only',channelId:'test',modelId:'seedance 2.0',modelName:'高速二',familyName:'独立家族'},900);
try{
 const query='?agentId=__all';
 eq((await call('/admin-api/logs'+query+'&model=eedan')).json().total,2);
 eq((await call('/admin-api/logs'+query+'&model='+encodeURIComponent('独立家族'))).json().total,0);
 eq((await call('/admin-api/logs'+query+'&family='+encodeURIComponent('独立家族'))).json().total,1);
 eq((await call('/admin-api/logs'+query+'&model=EEDAN&family='+encodeURIComponent('独立家族')+'&capability=video')).json().total,1);
 eq((await call('/admin-api/logs'+query+'&model=eedan&capability=image')).json().total,0);
 for(const cap of ['text','image','audio'])eq((await call('/admin-api/logs'+query+'&capability='+cap)).json().total,1);
 eq((await call('/admin-api/logs/export'+query+'&model=eedan')).json().items.length,2);
 eq((await call('/admin-api/logs/summary'+query+'&model=eedan')).json().credits,20);
 const facets=(await call('/admin-api/logs/facets'+query)).json();
 eq(facets.families.includes('独立家族'),true);eq(facets.models.includes('route:family-name-only'),false);eq(facets.models.includes('seedance 2.0'),true);
 const matrix={'16:9':{'2k':'2048 × 1152'}};
 const saved=await call('/admin-api/models/image-test','PUT',{imageSizeMap:matrix});eq(saved.statusCode,200);eq(saved.json().imageSizeMap,{'16:9':{'2k':'2048x1152'}});
 eq((await call('/admin-api/models/image-test','PUT',{imageSizeMap:{'16:9':{'2k':'bad'}}})).statusCode,400);
 eq(models.getModelDef('image-test').imageSizeMap,{'16:9':{'2k':'2048x1152'}});
 const {AISC_IMAGE_SIZES}=await import('../src/imageSizes.ts');
 models.createModel({id:'exact-aisc',label:'exact-aisc',capability:'image',protocol:'openai-image',baseUrl:'https://image.test',apiKey:'fake',saveToOss:false,imageSizeMap:AISC_IMAGE_SIZES,params:[{key:'resolution',label:'resolution',type:'enum',options:['1k','2k','4k']}],enabled:true});
 const {dispatchGenerate}=await import('../src/translators/index.ts');
 const {getTaskState}=await import('../src/store/tasks.ts');
 for(const [aspect,row] of Object.entries(AISC_IMAGE_SIZES))for(const [resolution,size] of Object.entries(row)){
  const result=await dispatchGenerate({model:'exact-aisc',purpose:'asset.scene.image',inputs:{text:'test'},params:{aspect_ratio:aspect,resolution,quality:'high'}});
  eq(result.kind,'async');
  for(let i=0;i<100&&getTaskState(result.taskId)?.status==='running';i++)await new Promise(r=>setTimeout(r,20));
  eq(getTaskState(result.taskId)?.status,'success');eq(sent.at(-1).size,size);
 }
 if(process.argv.includes('--serve')){await app.listen({port:8987,host:'127.0.0.1'});console.log('READY '+checks);await new Promise(resolve=>process.on('SIGTERM',resolve));}
 console.log('ADMIN_SEARCH '+checks+'/'+checks);
}finally{await app.close();await (await import('../src/store/db.ts')).flushPendingSaves();(await import('../src/store/sqlite.ts')).closeSqlite();}
