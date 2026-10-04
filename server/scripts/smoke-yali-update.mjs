import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
assert.ok(existsSync(new URL('../.yali-sandbox',import.meta.url)));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW2QAAAAASUVORK5CYII=','base64');
let calls=[];globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),...init});return init.method==='POST'?new Response(JSON.stringify(String(url).includes(':generateContent')?{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]}}]}:{data:[{b64_json:png.toString('base64')}]}),{status:200}):new Response(init.method==='HEAD'?null:png,{headers:{'content-type':'image/png'}})};
const before=JSON.parse(readFileSync(new URL('../before-models.json',import.meta.url),'utf8'));
const models=await import('../src/store/models.ts');await import('../src/store/families.ts');
const {translateYaliImage:translate}=await import('../src/translators/yali.ts');
const {imageMemberAccepts,imageUpstreamParams}=await import('../src/imageRouting.ts');
if(process.argv[2]==='manual-limit'){assert.equal(models.getModelDef('yali-v2-seedream-5-pro').matLimits.img,3);assert.equal(models.getModelDef('yali-v2-seedream-5-pro').imageMaterialMode,'direct');console.log('MANUAL_IMAGE_LIMIT_PERSISTS');process.exit(0);}
const fresh=models.listModels().filter(m=>m.id.startsWith('yali-v2-'));
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++};
assert.deepEqual(models.listModels().filter(m=>!m.id.startsWith('yali-v2-')),before);checks++;
check(fresh.length===6,'six models');
for(const m of fresh){check(m.channelId==='ch-yali-openai','channel preserved');check(m.routes.every(r=>r.upstreamModel===m.upstreamModel),'same upstream for price tiers');}
if(process.argv[2]==='seed'){console.log(`YALI_SEED ${checks}/${checks}`);process.exit(0);}
const req=(params={},images=[])=>({model:'test',capability:'image',purpose:'image.generate',promptOverride:'绘制测试图片',params,inputs:{images}});
const refs=n=>Array.from({length:n},(_,i)=>({url:`https://images.example/${i}.png`}));
for(const m of fresh){
 for(const resolution of m.params.find(p=>p.key==='resolution').options){
  calls=[];const records=[];
  const r=await translate(req({size:'16:9',resolution,quality:'high'}),{baseUrl:'https://api.yaliai.com/v1',apiKey:'fixture-secret',upstreamModel:m.upstreamModel},x=>records.push(x));
  check(r.ok,m.id+'/'+resolution);const post=calls.find(c=>c.method==='POST'),body=JSON.parse(post.body);
  check(!post.url.includes('/v1/v1'),'base normalized');check(!JSON.stringify(records).includes('fixture-secret'),'key masked');
  if(m.upstreamModel.startsWith('gemini'))check(body.generationConfig.imageConfig.imageSize===(resolution==='512'?'512':resolution.toUpperCase())&&body.generationConfig.imageConfig.aspectRatio==='16:9','native Gemini exact specs');
  else if(m.upstreamModel.startsWith('grok'))check(body.resolution===resolution&&body.aspect_ratio==='16:9'&&!body.quality&&!body.size,'Grok native fields');
  else check(body.size===m.imageSizeMap['16:9'][resolution]&&!body.quality&&!body.resolution&&body.n===1,'Seedream exact sizes');
 }
 const limit=20;calls=[];
 const up={baseUrl:'https://api.yaliai.com',apiKey:'fixture-secret',upstreamModel:m.upstreamModel};
 check((await translate(req({size:'1:1',resolution:'1k'},refs(limit)),up)).ok,'all reference images accepted');
 const post=calls.find(c=>c.method==='POST'),body=JSON.parse(post.body);
 if(m.upstreamModel.startsWith('gemini'))check(body.contents[0].parts.length===limit+1,'Gemini all images');
 else check(body.image.length===limit&&post.url.endsWith(m.upstreamModel.includes('seedream')?'/generations':'/edits'),'reference endpoint and no image loss');
 calls=[];check((await translate(req({size:'1:1',resolution:'1k'},refs(limit+1)),up)).ok&&calls.some(c=>c.method==='POST'),'more references reach upstream');
 for(const params of [{size:'1:1',resolution:'4k'}])if(m.upstreamModel.startsWith('grok')){calls=[];check(!(await translate(req(params),up)).ok&&!calls.length,'no Grok 4K downgrade');}
}
const pro=fresh.find(m=>m.id.endsWith('seedream-5-pro'));
for(const [ratio,table] of Object.entries(pro.imageSizeMap))for(const [resolution,size] of Object.entries(table)){
 calls=[];const r=await translate(req({size:ratio,resolution}),{baseUrl:'https://api.yaliai.com',apiKey:'fixture-secret',upstreamModel:pro.upstreamModel});
 check(r.ok&&JSON.parse(calls.find(c=>c.method==='POST').body).size===size,'Seedream table '+ratio+'/'+resolution);
}
check(imageMemberAccepts(pro,{aspect_ratio:'16:9',resolution:'2k'}),'Seedream route accepts 2K');
check(imageUpstreamParams(pro,{aspect_ratio:'16:9',resolution:'2k'}).size==='2816x1584','public route exact conversion');
check(imageMemberAccepts(pro,{aspect_ratio:'16:9',resolution:'1.5k'})&&imageUpstreamParams(pro,{aspect_ratio:'16:9',resolution:'1.5k'}).size==='2048x1152','Pro 1.5K remains its own tier');
const flash=fresh.find(m=>m.upstreamModel==='gemini-3.1-flash-image-preview');
check(imageMemberAccepts(flash,{aspect_ratio:'16:9',resolution:'512'}),'Flash native 512 routing');
check(!imageMemberAccepts(fresh.find(m=>m.upstreamModel==='grok-imagine-image'),{aspect_ratio:'16:9',resolution:'512'}),'Grok cannot inherit Flash tier');
for(const m of fresh){
 for(const imageMaterialMode of ['direct','url']){
  calls=[];
  const result=await translate(req({size:'1:1',resolution:'1k'},refs(2)),{baseUrl:'https://api.yaliai.com',apiKey:'fixture-secret',upstreamModel:m.upstreamModel,imageMaterialMode});
  check(result.ok,'transport succeeds '+imageMaterialMode);
  const post=calls.find(c=>c.method==='POST'),body=JSON.parse(post.body);
  if(imageMaterialMode==='direct'&&m.upstreamModel.startsWith('gemini'))check(body.contents[0].parts.filter(p=>p.inlineData).length===2,'Gemini direct bytes');
  else check(body.image.length===2&&body.image.every(u=>u.startsWith(imageMaterialMode==='direct'?'data:image/':'https://')),'wire reference transport '+imageMaterialMode);
 }
}
models.updateModel(pro.id,{imageMaterialMode:'direct'});
check(models.getModelDef(pro.id).imageMaterialMode==='direct','transport saved');
assert.throws(()=>models.updateModel(pro.id,{imageMaterialMode:'invalid'}));checks++;
const routing=await import('../src/autoRouting.ts');
models.updateModel(pro.id,{routes:pro.routes.map((r,i)=>({...r,cost:[10,25,40][i]}))});
const line={id:'image-price-test',name:'测试',familyId:pro.familyId,capability:'image',enabled:true,cost:99,members:[{modelId:pro.id,enabled:true,concurrencyWeight:1,priority:0,defaults:{}}]};
const tiers=routing.highestLinePrices(line);
assert.deepEqual(tiers.prices,[{when:{resolution:'1k'},cost:10},{when:{resolution:'1.5k'},cost:25},{when:{resolution:'2k'},cost:40}]);checks++;
const priced=routing.lineModel({...line,...tiers});
for(const [resolution,cost] of [['1k',10],['1.5k',25],['2k',40]])check(models.resolveModelCost(priced,{resolution,aspect_ratio:'16:9'})===cost,'public image tier cost '+resolution);
models.updateModel(pro.id,{routes:pro.routes.map(r=>({...r,cost:999}))});
check(models.resolveModelCost(priced,{resolution:'1.5k'})===25,'saved line price snapshot stays stable');
check(models.listModels().filter(m=>m.capability==='image').every(m=>m.matLimits?.img===undefined),'all image defaults unlimited');
check(routing.lineModel(line).matLimits.img===undefined,'image line no fallback nine');
models.updateModel(pro.id,{matLimits:{...pro.matLimits,img:3}});
const {checkMaterialLimits}=await import('../src/materialLimits.ts');
check(!!checkMaterialLimits('test',models.getModelDef(pro.id).matLimits,{images:refs(4)}),'explicit manual limit rejects');
console.log(`YALI_FULL ${checks}/${checks}`);
