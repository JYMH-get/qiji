import assert from 'node:assert/strict';
import fs from 'node:fs';
if(!import.meta.url.includes('qiji-line-availability-'))throw Error('Sandbox only');
globalThis.fetch=async()=>{throw Error('No external network in this sandbox');};
let now=Math.floor(Date.now()/600000)*600000;Date.now=()=>now;
const {db,closeSqlite}=await import('../src/store/sqlite.ts');
await import('../src/store/logs.ts');
const models=await import('../src/store/models.ts'),channels=await import('../src/store/channels.ts'),families=await import('../src/store/families.ts');
const routing=await import('../src/autoRouting.ts');
channels.createChannel({id:'fixture-channel',name:'Secret upstream',apiKey:'must-not-leak',baseUrl:'https://fixture.invalid',enabled:true});
channels.createChannel({id:'fixture-channel-b',name:'Secret upstream B',apiKey:'must-not-leak',baseUrl:'https://fixture.invalid',enabled:true});
families.createFamily({id:'fixture-family',name:'测试模型',capability:'text'});
for(const id of ['fixture-a','fixture-b'])models.createModel({id,label:id,capability:'text',protocol:'openai-chat',familyId:'fixture-family',channelId:id==='fixture-a'?'fixture-channel':'fixture-channel-b',enabled:true,cost:9999,params:[]});
families.createFamily({id:'fixture-audio-family',name:'音频测试',capability:'audio'});models.createModel({id:'fixture-audio',label:'audio',capability:'audio',protocol:'fixture-audio',familyId:'fixture-audio-family',channelId:'fixture-channel',cost:9999,params:[]});
const member=id=>({modelId:id,enabled:true,priority:0,concurrencyWeight:1,failureThreshold:3,failureWindowSec:60,cooldownSec:60,failureRetainPercent:50,defaults:{}});
const line={id:'fixture-line',name:'优惠',familyId:'fixture-family',modelVersion:'fixture-family',capability:'text',enabled:true,cost:12,members:[member('fixture-a'),member('fixture-b')]};
routing.saveRoutingConfig({...routing.routingConfig(),lines:[line,{...line,id:'fixture-empty',name:'稳定'},{...line,id:'fixture-audio-line',name:'音频线路',familyId:'fixture-audio-family',modelVersion:'fixture-audio-family',capability:'audio',members:[member('fixture-audio')]}]});
const stats=await import('../src/lineAvailability.ts'),modelStats=await import('../src/channelAvailability.ts'),edits=await import('../src/availabilityAdjustments.ts');
stats.stopLineAvailabilityBackground();modelStats.stopChannelAvailabilityBackground();
const {readChannelObservationState}=await import('../src/store/channelObservations.ts');
const {buildCatalog}=await import('../src/catalog.ts');
const users=await import('../src/store/users.ts');
const {default:Fastify}=await import('fastify');const app=Fastify();
await app.register((await import('../src/routes.ts')).registerRoutes);await app.register((await import('../src/routes/admin.ts')).registerAdminRoutes);await app.ready();
stats.stopLineAvailabilityBackground();modelStats.stopChannelAvailabilityBackground();
const user=users.createUser({name:'fixture-user',credits:1000});
users.applyMembershipGrant(user.id,{planName:'fixture',days:1,discountPercent:50});
const headers={authorization:'Bearer '+user.accessKey,'x-device-id':'fixture'},admin={authorization:'Bearer admin-dev'};
let checks=0;const eq=(actual,expected,msg)=>{assert.deepEqual(actual,expected,msg);checks++;};
const req=()=>app.inject({url:'/v1/route-availability',headers});
const path='/admin-api/models/fixture-a/rate-history';
const getEdit=async(target='line:fixture-line')=>{const res=await app.inject({url:path+'?target='+encodeURIComponent(target),headers:admin});eq(res.statusCode,200,'read edit view');return res.json();};
const putEdit=(view,changes)=>app.inject({method:'PUT',url:path,headers:admin,payload:{target:view.key,epoch:view.epoch,edits:changes}});
let logId=0;
function log(status,lineId='fixture-line',start=now-1000,finish=now){
 const id='fixture-log-'+(++logId),startedAt=new Date(start).toISOString();
 const meta={id,model:'route:'+lineId,startedAt,status,finishedAt:status==='running'?undefined:new Date(finish).toISOString(),capability:'text'};
 db.prepare('INSERT INTO logs(id,day,started_at,owner,meta) VALUES(?,?,?,?,?)').run(id,startedAt.slice(0,10),startedAt,'',JSON.stringify(meta));return id;
}
try{
 const observations=await import('../src/store/channelObservations.ts');
 observations.writeChannelObservationState('legacy-v1',{done:true});
 const initial=now;
 log('failed','fixture-line',now-7200000,now-1);
 observations.importChannelObservation({id:'interval-failure',modelId:'fixture-a',modelName:'Fixture',channelId:'fixture-channel',capability:'text',startedAt:now-7200000,finishedAt:now-1,status:'failed'});
 stats.refreshLineAvailability(now,true);modelStats.refreshChannelAvailability(now,true);
 const linePoint=()=>stats.lineHistoryScope('fixture-line',now).history.at(-1);
 const modelPoint=()=>modelStats.modelHistoryScope('fixture-a',now).history.at(-1);
 eq(linePoint().completedRequests,1,'long request counted by completion');eq(modelPoint().completedRequests,1,'model uses terminal interval');
 eq(linePoint().successRate,.8,'low count uses 80 percent');eq(modelPoint().insufficientSamples,true,'model flags placeholder');
 now+=600000;stats.refreshLineAvailability(now,true);modelStats.refreshChannelAvailability(now,true);
 eq(linePoint().completedRequests,0,'failure not repeated in next line point');eq(modelPoint().completedRequests,0,'failure not repeated in next model point');eq(linePoint().successRate,.8,'empty uses same 80 percent');
 for(let i=0;i<10;i++){log('failed','fixture-line',initial,now+1);observations.importChannelObservation({id:'fail-'+i,modelId:'fixture-a',modelName:'Fixture',channelId:'fixture-channel',capability:'text',startedAt:initial,finishedAt:now+1,status:'failed'});}
 now+=600000;stats.refreshLineAvailability(now,true);modelStats.refreshChannelAvailability(now,true);
 eq(linePoint().successRate,0,'ten line failures produce measured zero');eq(modelPoint().successRate,0,'ten model failures produce measured zero');eq(linePoint().insufficientSamples,false,'ten is sufficient');
 const response=(await req()).json();eq(response.rows.find(r=>r.id==='route:fixture-line').history.at(-2).insufficientSamples,true,'public API preserves blue placeholder flag');
 console.log('Interval availability: '+checks+' checks passed');
}finally{stats.stopLineAvailabilityBackground();modelStats.stopChannelAvailabilityBackground();await app.close();closeSqlite();}
