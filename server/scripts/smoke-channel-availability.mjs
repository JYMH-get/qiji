import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
if(!import.meta.url.includes('qiji-availability-'))throw Error('Sandbox only');
globalThis.fetch=async()=>{throw Error('No real upstream allowed');};
const {startLog,finishLog,attachUpstream}=await import('../src/store/logs.ts');
const {createModel}=await import('../src/store/models.ts');
const {createChannel}=await import('../src/store/channels.ts');
const {beginChannelObservation,finishChannelObservation,channelObservationRows}=await import('../src/store/channelObservations.ts');
const {beginRouteObservation,finishRouteObservation}=await import('../src/routeObservations.ts');
const {channelAvailability,aggregateAvailability,availabilityFamily}=await import('../src/channelAvailability.ts');
const {db,closeSqlite}=await import('../src/store/sqlite.ts');
const {flushPendingSaves}=await import('../src/store/db.ts');
let checks=0;const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++};
const now=Date.now();
const base={modelId:'av-gpt',modelName:'GPT测试',channelId:'av-channel',capability:'text'};
const samples=[
 {...base,id:'same',startedAt:now-100,status:'success',finishedAt:now},
 {...base,id:'same',startedAt:now-100,status:'success',finishedAt:now},
 {...base,id:'failed',startedAt:now-200,status:'failed',finishedAt:now-5,failureKind:'channel'},
 {...base,id:'old-running',startedAt:now-7200000,status:'running'},
 {...base,id:'running',startedAt:now-50,status:'running'},
 {...base,id:'old-done',startedAt:now-3600001,status:'success',finishedAt:now-10}
];
const ag=aggregateAvailability(samples,now);eq(ag.requests,3,'rolling hour dedup');eq(ag.successRate,.5,'running excluded denominator');eq(ag.active,2,'old active counted');eq(ag.history.length,5,'history unique');eq(ag.status,'available','latest terminal sets status');
eq(aggregateAvailability([],now).successRate,null,'no samples not100');eq(aggregateAvailability([],now).status,'unknown','no samples not ready');
eq(aggregateAvailability([{...base,id:'user',startedAt:now,status:'failed',failureKind:'user'}],now).status,'unknown','user rejection does not imply outage');
eq(aggregateAvailability([{...base,id:'channel',startedAt:now,status:'failed',failureKind:'channel'}],now).status,'unavailable','channel failure signals outage');
eq(aggregateAvailability([{...base,id:'channel',startedAt:now,status:'failed',failureKind:'unknown'}],now).status,'attention','unknown failure needs observation');
eq(aggregateAvailability(Array.from({length:80},(_,i)=>({...base,id:String(i),startedAt:now-i,status:'success'})),now).history.length,60,'last60 cap');
eq(availabilityFamily({id:'gpt-5.6',label:'GPT',capability:'text'},[]).name,'GPT','text families');
eq(availabilityFamily({id:'a',label:'音频',capability:'audio'},[]).name,'其他','audio fallback');
createChannel({id:'av-channel',name:'测试渠道',enabled:true});
createModel({id:'av-gpt',label:'GPT测试',upstreamModel:'gpt-5.6',capability:'text',protocol:'openai-chat',channelId:'av-channel',enabled:true,params:[]});
createModel({id:'av-image',label:'测试图片',capability:'image',protocol:'openai-image',channelId:'av-channel',enabled:true,params:[]});
createModel({id:'av-audio',label:'测试音频',capability:'audio',protocol:'fixture-audio',channelId:'av-channel',enabled:false,params:[]});
const make=(id)=>{const l=startLog({req:{model:'av-gpt',purpose:'chat.reply',clientTaskId:id}});return l.id};
const direct=make('direct');beginChannelObservation({...base,id:direct},now-1000);finishLog(direct,{status:'success'});beginChannelObservation({...base,id:direct},now);finishChannelObservation(direct,false,'HTTP 503');
const old=make('old');beginChannelObservation({...base,id:old},now-7200000);
const legacy=make('legacy');attachUpstream(legacy,{request:{method:'POST',url:'https://fixture.invalid/v1/chat/completions'}});finishLog(legacy,{status:'failed',error:'HTTP 503'});
const routed=make('routed');beginRouteObservation(routed,{lineId:'line-a',channelId:'av-channel',modelId:'av-gpt'},900,now-500);beginChannelObservation({...base,id:routed},now-500);finishLog(routed,{status:'success'});
let result=channelAvailability(Date.now()),row=result.rows.find(r=>r.modelId==='av-gpt');
eq(row.requests,3,'direct legacy routed each once');eq(row.active,1,'old running retained');eq(row.success,2,'finished hook preserves success');eq(row.failed,1,'legacy failure included');eq(row.successRate,2/3,'correct rate');eq(row.configuredWeights,[],'unrouted model weight absent');
eq(result.rows.find(r=>r.modelId==='av-audio').status,'disabled','disabled status');eq(result.rows.find(r=>r.modelId==='av-image').status,'unknown','enabled unused unknown');
finishLog(old,{status:'failed',error:'服务端重启，任务中断'});eq(channelAvailability().rows.find(r=>r.modelId==='av-gpt').active,0,'terminal releases current count');
eq(channelObservationRows(now-7*86400000).find(r=>r.id===direct).status,'success','duplicate terminal ignored');
const Fastify=(await import('fastify')).default;const {registerAdminRoutes}=await import('../src/routes/admin.ts');const app=Fastify();await app.register(registerAdminRoutes);
eq((await app.inject({url:'/admin-api/channel-availability'})).statusCode,401,'admin endpoint protected');
const response=await app.inject({url:'/admin-api/channel-availability',headers:{authorization:'Bearer admin-dev'}});eq(response.statusCode,200,'new API');eq(response.json().rows.find(r=>r.modelId==='av-gpt').requests,3,'API uses channel model metrics');
new Function(readFileSync('./src/admin/auto-routing.js','utf8'));checks++;
await app.close();await flushPendingSaves();closeSqlite();
writeFileSync('availability-proof.json',JSON.stringify({checks,upstreamCalls:0},null,2));console.log('AVAILABILITY '+checks+' passed; zero upstream');
