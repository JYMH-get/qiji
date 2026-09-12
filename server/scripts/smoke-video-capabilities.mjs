import assert from 'node:assert/strict';
import {existsSync,writeFileSync} from 'node:fs';
assert.ok(existsSync(new URL('../.qiji-routing-sandbox',import.meta.url)),'Isolated sandbox required');
let networkAttempts=0;
globalThis.fetch=async()=>{networkAttempts++;throw Error('No upstream requests permitted')};
const routing=await import('../src/autoRouting.ts'),models=await import('../src/store/models.ts'),channels=await import('../src/store/channels.ts');
const observations=await import('../src/routeObservations.ts');
const {buildCatalog}=await import('../src/catalog.ts');
const {flushPendingSaves}=await import('../src/store/db.ts');
const {closeSqlite}=await import('../src/store/sqlite.ts');
let count=0;const eq=(a,b,label)=>{assert.deepEqual(a,b,label);count++;};
const params=(res,durations=['5','10','15'],ratios=['16:9','9:16'])=>[{key:'duration',label:'时长',type:'enum',options:durations,default:'5'},{key:'resolution',label:'分辨率',type:'enum',options:res,default:res.includes('720p')?'720p':res[0]},{key:'aspect_ratio',label:'宽高比',type:'enum',options:ratios,default:ratios[0]}];
const ids=['007-sd2.0','seedance-2.0'];
for(const id of ['ch-007','ch-jianmeng'])channels.updateChannel(id,{enabled:true,baseUrl:'https://unused.routing.test',apiKey:''});
models.updateModel(ids[0],{enabled:true,shareScope:'all',params:params(['720p']),methods:['omni'],costField:'duration',costPerUnit:50,cost:750,matLimits:{img:1,vid:0,aud:0}});
models.updateModel(ids[1],{enabled:true,shareScope:'all',params:params(['480p','720p']),methods:['omni','frames'],costField:'duration',costPerUnit:38,cost:570,routes:[{when:{resolution:'480p'},upstreamModel:'fixture-480p',costPerUnit:31},{when:{resolution:'720p'},upstreamModel:'fixture-720p',costPerUnit:38}],matLimits:{img:9,vid:3,aud:3}});
const member=id=>({modelId:id,enabled:true,vipEnabled:false,priority:0,concurrencyWeight:1,failureThreshold:3,failureWindowSec:300,cooldownSec:300,failureRetainPercent:50,defaults:{}});
const line={id:'capability-test',name:'能力验证',familyId:'fam-seedance',modelVersion:'2.0',enabled:true,cost:999,prices:[{when:{duration:'5',resolution:'4k'},cost:999}],members:ids.map(member)};
const save=()=>routing.saveRoutingConfig({...routing.routingConfig(),enabled:true,lines:[structuredClone(line)]});
const req=(resolution='720p',extra={})=>({model:'route:'+line.id,purpose:'video.generate',promptOverride:'A flower moving in the wind',inputs:{images:[{url:'https://unused.routing.test/image.png'}]},params:{duration:5,resolution,aspect_ratio:'16:9',method:'omni',...extra}});
const resolutions=()=>routing.publicModelDef('route:'+line.id).params.find(p=>p.key==='resolution').options;
const pending=[],runPrefix='hold-'+Date.now()+'-';
try {
 save();
 eq(new Set(resolutions()),new Set(['480p','720p']),'union exposes both actual resolutions, never pricing-only 4k');
 eq(routing.prepareRoutingRequest(req('480p')),undefined,'480p accepted when only stable supports it');
 const batches=[];
 for(const [n,res] of [[10,'720p'],[10,'480p'],[10,'720p'],[10,'720p']]){
  const selected=[];
  for(let i=0;i<n;i++){const result=routing.selectRoute(req(res)),id=runPrefix+pending.length;observations.beginRouteObservation(id,result.ticket,900);pending.push(id);selected.push(result.ticket.modelId);eq(result.request.params.resolution,res,'resolution forwarded unchanged');}
  batches.push(ids.map(id=>selected.filter(x=>x===id).length));
 }
 eq(batches,[[5,5],[0,10],[10,0],[5,5]],'10x720,10x480,20x720 produce exact catch-up sequence');
 eq(observations.routeActiveCounts(line.id),{'ch-007':20,'ch-jianmeng':20},'all resolutions share the same per-channel occupancy');
 for(const id of pending)observations.finishRouteObservation(id,true);
 eq(Object.values(observations.routeActiveCounts(line.id)).reduce((a,b)=>a+b,0),0,'finished tasks release occupancy');
 eq(routing.selectRoute(req('720p',{method:'frames'})).ticket.modelId,ids[1],'method capability filters before balancing');
 const many=req();many.inputs.images.push({url:'https://unused.routing.test/b.png'});eq(routing.selectRoute(many).ticket.modelId,ids[1],'material caps filter before balancing');
 const noRef=req();noRef.inputs={};eq(routing.selectRoute(noRef).ticket.modelId,ids[1],'007 reference requirement does not reject other capable channels');
 line.members[1].enabled=false;save();eq(resolutions(),['720p'],'single 007 only exposes 720p with four-resolution price table');
 eq(!!routing.prepareRoutingRequest(req('480p')),true,'unsupported resolution rejected before dispatch');
 eq(!!routing.prepareRoutingRequest(req('4k')),true,'pricing-only 4k rejected');
 line.members[1].enabled=true;save();channels.updateChannel('ch-jianmeng',{enabled:false});eq(resolutions(),['720p'],'globally disabled channel contributes no video options');channels.updateChannel('ch-jianmeng',{enabled:true});
 models.updateModel(ids[1],{shareScope:'none'});eq(buildCatalog().models.find(m=>m.id==='route:'+line.id).params.find(p=>p.key==='resolution').options,['720p'],'catalog uses account-visible candidates');models.updateModel(ids[1],{shareScope:'all'});
 models.updateModel(ids[0],{params:params(['720p'],['5'],['16:9'])});models.updateModel(ids[1],{params:params(['480p'],['10'],['9:16'])});save();
 eq(!!routing.prepareRoutingRequest(req('480p',{duration:5})),true,'independent unions cannot invent a supported parameter combination');
 eq(routing.selectRoute(req('480p',{duration:10,aspect_ratio:'9:16'})).ticket.modelId,ids[1],'disjoint valid combinations route to capable channel');
 const prices=routing.highestLinePrices(line).prices;
 eq(prices.map(p=>[p.when.duration,p.when.resolution,p.cost]),[['5','720p',250],['10','480p',310]],'price helper ignores models that cannot generate the tier');
 const {registerRoutes}=await import('../src/routes.ts'),users=await import('../src/store/users.ts');
 const {default:fastify}=await import('fastify');const app=fastify();await registerRoutes(app);
 try{const user=users.createUser({name:'能力路由沙盒',credits:1000,features:{assetMode:true}});
  const rejected=await app.inject({method:'POST',url:'/v1/generate',headers:{authorization:'Bearer '+user.accessKey},payload:req('480p',{duration:5})});
  eq(rejected.statusCode,400,'unsupported complete combination rejected at real generation endpoint');
  eq(rejected.json().error.message.includes('参数与素材组合'),true,'endpoint reaches capability guard');eq(user.credits,1000,'unsupported combination is rejected before charging');
 }finally{await app.close();}
 eq(networkAttempts,0,'no real or unexpected upstream requests');
 writeFileSync(new URL('../video-capabilities-proof.json',import.meta.url),JSON.stringify({checks:count,batches,networkRequests:networkAttempts},null,2));
 console.log(`VIDEO_CAPABILITIES ${count}/${count}; batches=${JSON.stringify(batches)}; real upstream calls=0`);
}finally{for(const id of pending)observations.finishRouteObservation(id,true);await flushPendingSaves();closeSqlite();}
