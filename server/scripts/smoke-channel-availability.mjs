import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
if(!import.meta.url.includes('qiji-availability-'))throw Error('Sandbox only');
globalThis.fetch=async()=>{throw Error('No real upstream allowed');};
const {db,closeSqlite}=await import('../src/store/sqlite.ts');
db.exec('CREATE TABLE channel_observations(id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,data TEXT NOT NULL)');
db.prepare('INSERT INTO channel_observations(id,started_at,data) VALUES(?,?,?)').run('migrate-terminal',1,JSON.stringify({id:'migrate-terminal',startedAt:1,status:'success',modelId:'old',modelName:'old',channelId:'old',capability:'image'}));
const {startLog,finishLog,attachUpstream}=await import('../src/store/logs.ts');
const {createModel,updateModel,deleteModel,getModelDef}=await import('../src/store/models.ts');
const {createChannel,updateChannel}=await import('../src/store/channels.ts');
const {createFamily}=await import('../src/store/families.ts');
const routing=await import('../src/autoRouting.ts');
function enableForStats(id){
 const m=getModelDef(id),familyId='av-fam-'+id;
 createFamily({id:familyId,name:m.label,capability:m.capability});updateModel(id,{familyId});
 const line={id:'stats-'+id,name:'统计',familyId,modelVersion:familyId,capability:m.capability,enabled:true,cost:1,
  members:[{modelId:id,enabled:true,priority:0,concurrencyWeight:1,failureThreshold:3,failureWindowSec:60,cooldownSec:60,failureRetainPercent:50,defaults:{}}]};
 routing.saveRoutingConfig({...routing.routingConfig(),lines:[...routing.routingConfig().lines.filter(l=>l.id!==line.id),line]});
}
createChannel({id:'av-channel',name:'测试渠道',enabled:true});
createModel({id:'av-gpt',label:'GPT测试',upstreamModel:'gpt-5.6',capability:'text',protocol:'openai-chat',channelId:'av-channel',enabled:true,params:[]});
createModel({id:'av-image',label:'测试图片',capability:'image',protocol:'openai-image',channelId:'av-channel',enabled:true,params:[]});
createModel({id:'av-audio',label:'测试音频',capability:'audio',protocol:'fixture-audio',channelId:'av-channel',enabled:false,params:[]});
enableForStats('av-gpt');
const {beginChannelObservation,finishChannelObservation,channelObservationRows,importChannelObservation,readChannelObservationState}=await import('../src/store/channelObservations.ts');
const {beginRouteObservation,finishRouteObservation}=await import('../src/routeObservations.ts');
const {channelAvailability,refreshChannelAvailability,backfillChannelObservations,stopChannelAvailabilityBackground,aggregateAvailability,availabilityFamily}=await import('../src/channelAvailability.ts');
const {sampleAvailabilityRates,availabilityRateHistory}=await import('../src/availabilityHistory.ts');
stopChannelAvailabilityBackground();
const {flushPendingSaves}=await import('../src/store/db.ts');
let checks=0;const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++};
eq(db.prepare('SELECT finished_at FROM channel_observations WHERE id=?').get('migrate-terminal').finished_at,1,'old schema terminal backfill precedes pending index');
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
const ag=aggregateAvailability(samples,now);eq(ag.requests,3,'rolling hour dedup');eq(ag.successRate,.5,'running excluded denominator');eq(ag.active,2,'old active counted');eq(ag.status,'available','latest terminal sets status');
eq(aggregateAvailability([],now).successRate,null,'no samples not100');eq(aggregateAvailability([],now).status,'unknown','no samples not ready');
eq(aggregateAvailability([{...base,id:'user',startedAt:now,status:'failed',failureKind:'user'}],now).status,'unknown','user rejection does not imply outage');
eq(aggregateAvailability([{...base,id:'channel',startedAt:now,status:'failed',failureKind:'channel'}],now).status,'unavailable','channel failure signals outage');
eq(aggregateAvailability([{...base,id:'channel',startedAt:now,status:'failed',failureKind:'unknown'}],now).status,'attention','unknown failure needs observation');
eq(aggregateAvailability(Array.from({length:80},(_,i)=>({...base,id:String(i),startedAt:now-i,status:'success'})),now).requests,80,'one-hour requests not capped by waveform');
eq(availabilityFamily({id:'gpt-5.6',label:'GPT',capability:'text'},[]).name,'GPT','text families');
eq(availabilityFamily({id:'a',label:'音频',capability:'audio'},[]).name,'其他','audio fallback');
const make=(id)=>{const l=startLog({req:{model:'av-gpt',purpose:'chat.reply',clientTaskId:id}});return l.id};
const direct=make('direct');beginChannelObservation({...base,id:direct},now-1000);finishLog(direct,{status:'success'});beginChannelObservation({...base,id:direct},now);finishChannelObservation(direct,false,'HTTP 503');
const old=make('old');beginChannelObservation({...base,id:old},now-7200000);
const legacy=make('legacy');attachUpstream(legacy,{request:{method:'POST',url:'https://fixture.invalid/v1/chat/completions'}});finishLog(legacy,{status:'failed',error:'HTTP 503'});
const routed=make('routed');beginRouteObservation(routed,{lineId:'line-a',channelId:'av-channel',modelId:'av-gpt'},900,now-500);beginChannelObservation({...base,id:routed},now-500);finishLog(routed,{status:'success'});
let progress=backfillChannelObservations(Date.now(),1);eq(progress.done,false,'legacy batch is bounded');
eq(readChannelObservationState('legacy-v1').cursor,progress.cursor,'cursor persisted before next batch');
while(!progress.done)progress=backfillChannelObservations(Date.now(),1);
let result=refreshChannelAvailability(Date.now()),row=result.rows.find(r=>r.modelId==='av-gpt');
eq(row.requests,3,'direct legacy routed each once');eq(row.active,1,'old running retained');eq(row.success,2,'finished hook preserves success');eq(row.failed,1,'legacy failure included');eq(row.successRate,2/3,'correct rate');eq(row.configuredWeights,[1],'route weight available');
eq(result.rows.find(r=>r.modelId==='av-audio').status,'disabled','unrouted audio not tracked');eq(result.rows.find(r=>r.modelId==='av-image').status,'disabled','model enabled field alone does not enable stats');
finishLog(old,{status:'failed',error:'服务端重启，任务中断'});eq(refreshChannelAvailability().rows.find(r=>r.modelId==='av-gpt').active,0,'terminal releases current count');
eq(channelObservationRows(now-7*86400000).find(r=>r.id===direct).status,'success','duplicate terminal ignored');
eq(channelObservationRows(now-7*86400000).some(r=>r.id===legacy),true,'legacy identity materialized');
db.prepare('DELETE FROM log_details WHERE id=?').run(legacy);eq(refreshChannelAvailability().rows.find(r=>r.modelId==='av-gpt').failed,1,'pruned raw receipts retain materialized observation');
eq(refreshChannelAvailability(Date.now()+3600001).rows.find(r=>r.modelId==='av-gpt').requests,0,'rolling window ages out without new requests');refreshChannelAvailability();
createModel({id:'av-bulk',label:'批量统计夹具',capability:'text',protocol:'openai-chat',channelId:'av-channel',params:[]});enableForStats('av-bulk');
const bulkAt=Date.now();
db.exec('BEGIN');
for(let i=0;i<10000;i++)importChannelObservation({...base,id:'bulk-'+i,modelId:'av-bulk',modelName:'批量统计夹具',capability:'text',startedAt:bulkAt,status:'success',finishedAt:bulkAt});
db.exec('COMMIT');
const summaryStart=performance.now();result=refreshChannelAvailability();const summaryMs=performance.now()-summaryStart;
eq(result.rows.find(r=>r.modelId==='av-bulk').requests,10000,'large fixture exact count');eq(result.rows.find(r=>r.modelId==='av-bulk').history.length,0,'no fabricated historical snapshots from old requests');
const prepare=db.prepare.bind(db);let detailQueries=0;
db.prepare=(sql)=>{if(/log_details/i.test(sql))detailQueries++;return prepare(sql);};
const cachedStart=performance.now();for(let i=0;i<100;i++)channelAvailability();const cached100Ms=performance.now()-cachedStart;
db.prepare=prepare;eq(detailQueries,0,'100 cached HTTP reads never inspect log_details');
eq(backfillChannelObservations().done,true,'completed legacy migration never rescans');
console.log(JSON.stringify({observations:10000,summaryMs,cached100Ms}));
const Fastify=(await import('fastify')).default;const {registerAdminRoutes}=await import('../src/routes/admin.ts');const app=Fastify();await app.register(registerAdminRoutes);
eq((await app.inject({url:'/admin-api/channel-availability'})).statusCode,401,'admin endpoint protected');
const response=await app.inject({url:'/admin-api/channel-availability',headers:{authorization:'Bearer admin-dev'}});eq(response.statusCode,200,'new API');eq(response.json().rows.find(r=>r.modelId==='av-gpt').requests,3,'API uses channel model metrics');
// Processing models retain their precise capability but share the Other category, including old logs.
const request=(url,method='GET',payload)=>app.inject({url,method,payload,headers:{authorization:'Bearer admin-dev'}});
const processing=[['video-enhance','video.upscale','视频超分'],['video-erase','video.desub','视频去字幕'],['image-enhance','image.upscale','图像超分']];
for(const [cap,purpose,name] of processing){
 createModel({id:'av-'+cap,label:name,capability:cap,protocol:'volc-mediakit',channelId:'av-channel',params:[],cost:10});
 enableForStats('av-'+cap);
 const log=startLog({req:{model:'av-'+cap,purpose},cost:10});
 beginChannelObservation({id:log.id,modelId:'av-'+cap,modelName:name,channelId:'av-channel',capability:cap},Date.now());finishLog(log.id,{status:'success'});
 const missing=startLog({req:{model:'av-deleted-'+cap,purpose},cost:10});finishLog(missing.id,{status:'success'});
}
const processingRows=refreshChannelAvailability().rows.filter(r=>r.capability==='other'&&r.modelId.startsWith('av-'));
eq(processingRows.length,3,'all three processing capabilities grouped under Other');
for(const [cap,,name] of processing){const row=processingRows.find(r=>r.modelId==='av-'+cap);eq(row.modelCapability,cap,'precise dispatch capability retained');eq(row.familyName,name,'processing family label');eq(row.success,1,'processing observations counted');}
eq((await request('/admin-api/logs?capability=other')).json().total,6,'Other filter includes current and deleted processing models');
eq((await request('/admin-api/logs/export?capability=other')).json().items.length,6,'Other export matches list');
eq((await request('/admin-api/logs/summary?capability=other')).json().credits,60,'Other summary matches list');
eq((await request('/admin-api/logs?capability=image')).json().items.some(l=>l.purpose==='image.upscale'),false,'image generation excludes upscale');
const familyResponse=await request('/admin-api/families','POST',{id:'av-processing',name:'测试超分家族',capability:'image-enhance'});
eq(familyResponse.statusCode,200,'create processing family');eq(familyResponse.json().capability,'image-enhance','processing family persists precise capability');
eq(routing.routingFamilyOptions(routing.routingConfig()).find(f=>f.id==='av-processing').capability,'image-enhance','empty processing family selectable for a new line');
const emptyLine={id:'av-processing-line',familyId:'av-processing',familyName:'测试超分家族',name:'超分',modelVersion:'av-processing',capability:'image-enhance',enabled:false,cost:10,members:[]};
const config=routing.saveRoutingConfig({...routing.routingConfig(),lines:[...routing.routingConfig().lines,emptyLine]});
eq(config.lines.find(l=>l.id===emptyLine.id).capability,'image-enhance','empty processing line can be saved');
eq(routing.withDefaultRouting(config).lines.filter(l=>l.familyId==='av-processing').length,1,'processing family does not gain irrelevant default tiers');
eq((await request('/admin-api/families/av-processing','PUT',{capability:'video-enhance'})).json().capability,'video-enhance','processing family capability editable');
eq((await request('/admin-api/families','POST',{id:'av-invalid-category',name:'无效',capability:'other'})).statusCode,400,'display category cannot replace dispatch capability');
routing.saveRoutingConfig({...routing.routingConfig(),lines:routing.routingConfig().lines.filter(l=>l.id!==emptyLine.id)});
// Independently controlled minute samples, including unequal request volumes and empty minutes.
const minute=60000,t=Date.UTC(2026,8,14,23,55),input=(rate,requests=100)=>[{id:'test',successRate:rate,requests}];
let history={models:{}};
for(let i=0;i<9;i++)history=sampleAvailabilityRates(history,input(i%2?0:1,i%2?1:100),t+i*minute);
eq(history.models.test.history.length,0,'nine samples do not publish a point');
eq(sampleAvailabilityRates(history,input(0),t+8*minute+1000),history,'same-minute repeat cannot advance group');
eq(sampleAvailabilityRates(history,input(0),t),history,'clock rollback cannot duplicate samples');
history=sampleAvailabilityRates(history,input(0,1),t+9*minute);
eq(history.models.test.history[0].successRate,.5,'ten rates averaged equally despite unequal request volumes');
eq(history.models.test.history[0].validSamples,10,'ten valid minutes across midnight');
eq(history.models.test.history[0].until-history.models.test.history[0].since,10*minute,'one snapshot covers ten sampling minutes');
for(const rate of [.9,.8,.6,.2,0,null]){
 let s={models:{}};for(let i=0;i<10;i++)s=sampleAvailabilityRates(s,input(rate,rate===null?0:1),t+i*minute);
 eq(s.models.test.history[0].successRate,rate,'threshold exact after averaging '+rate);
 eq(s.models.test.history[0].hasRequests,rate!==null,'empty blue vs genuine zero rate '+rate);
}
let mixed={models:{}};for(let i=0;i<10;i++)mixed=sampleAvailabilityRates(mixed,input(i===2?0:i===7?1:null),t+i*minute);
eq(mixed.models.test.history[0].successRate,.5,'empty/unfinished minutes excluded; real zero included');
eq(mixed.models.test.history[0].validSamples,2,'valid denominator exposed');
let activated={models:{}};for(let i=0;i<10;i++)activated=sampleAvailabilityRates(activated,[{...input(1)[0],trackingSince:t}],t+i*minute);
eq(activated.models.test.history[0].since,t,'first snapshot cannot start before route reactivation');
let unfinished={models:{}};for(let i=0;i<10;i++)unfinished=sampleAvailabilityRates(unfinished,input(null,1),t+i*minute);
eq(unfinished.models.test.history[0].hasRequests,true,'running-only distinguishes no terminal from no requests');
eq(unfinished.models.test.history[0].successRate,null,'running-only never becomes a failure');
let interrupted={models:{}};for(let i=0;i<9;i++)interrupted=sampleAvailabilityRates(interrupted,input(1),t+i*minute);
interrupted=sampleAvailabilityRates(interrupted,input(0),t+11*minute);
eq(interrupted.models.test.pending.samples,1,'missing minutes restart partial group without faking downtime');
eq(interrupted.models.test.history.length,0,'partial group is not a full snapshot');
let long={models:{}};for(let i=0;i<610;i++)long=sampleAvailabilityRates(long,input(1),t+i*minute);
eq(long.models.test.history.length,60,'last sixty points retained');
eq(long.models.test.history[0].until,t+19*minute,'oldest snapshot ages out after ten hours');
eq(availabilityRateHistory(long,'test',t+1210*minute),[],'history disappears after ten hours without samples');
const beforeHistory=structuredClone(history.models.test.history);
history=sampleAvailabilityRates(history,input(1),t+10*minute);
eq(history.models.test.history,beforeHistory,'published point is immutable as later rates change');
// Exercise the real background entry, SQLite persistence and the separate rolling-hour header.
createChannel({id:'av-life-channel',name:'启停测试渠道',enabled:true});
const lifeModel={id:'av-life',label:'启停测试',capability:'text',protocol:'openai-chat',channelId:'av-life-channel',enabled:false,params:[]};
createModel(lifeModel);enableForStats(lifeModel.id);
const lifeOld=Date.now();importChannelObservation({...base,id:'life-old-failed',modelId:lifeModel.id,channelId:lifeModel.channelId,startedAt:lifeOld,status:'failed',finishedAt:lifeOld});
importChannelObservation({...base,id:'ghost-observation',modelId:'deleted-model',startedAt:lifeOld,status:'success',finishedAt:lifeOld});
const sampleStart=Date.now();
const before=refreshChannelAvailability(sampleStart);const initialHourly=before.rows.find(r=>r.modelId==='av-gpt');
eq(before.historyWindowMs,36000000,'API waveform horizon is ten hours');
for(let i=0;i<9;i++)refreshChannelAvailability(sampleStart+i*minute,true);
eq(refreshChannelAvailability(sampleStart+8*minute).rows.find(r=>r.modelId==='av-gpt').history.length,0,'manual refresh cannot finish a nine-sample group');
const pointResult=refreshChannelAvailability(sampleStart+9*minute,true),pointRow=pointResult.rows.find(r=>r.modelId==='av-gpt');
eq(pointRow.history.length,1,'background tenth sample publishes point');
eq(pointRow.history[0].successRate,Number((2/3).toFixed(12)),'snapshot averages rolling hour rate');
eq([pointRow.success,pointRow.failed,pointRow.requests,pointRow.successRate],[initialHourly.success,initialHourly.failed,initialHourly.requests,initialHourly.successRate],'header remains the independent one-hour statistic');
for(let i=10;i<15;i++)refreshChannelAvailability(sampleStart+i*minute,true);
const persisted=readChannelObservationState('rate-history-v1'),rowKey=pointRow.id;
eq(persisted.models[rowKey].pending.samples,5,'unfinished second group saved for restart');
eq(persisted.models[rowKey].history.length,1,'completed group saved separately');
eq(readChannelObservationState('snapshot-v3').rows.find(r=>r.modelId==='av-gpt').history.length,1,'versioned cache contains only rate history');
// Lifecycle changes happen between timer ticks: cleanup must occur synchronously in the config path.
const lifeKey=JSON.stringify([lifeModel.channelId,lifeModel.id]);
eq(persisted.models[lifeKey].history.length,1,'route enablement overrides deprecated model enabled flag');
eq(persisted.models[lifeKey].pending.samples,5,'partial lifecycle fixture exists');
const realNow=Date.now;let lifeNow=sampleStart+15*minute;Date.now=()=>lifeNow;
const changeLines=fn=>routing.saveRoutingConfig({...routing.routingConfig(),lines:fn(routing.routingConfig().lines)});
try{
 changeLines(lines=>[...lines, {...structuredClone(lines.find(l=>l.id==='stats-av-life')),id:'stats-av-life-b'}]);
 changeLines(lines=>lines.map(l=>l.id==='stats-av-life'?{...l,members:l.members.map(m=>({...m,enabled:false}))}:l));
 eq(readChannelObservationState('rate-history-v1').models[lifeKey].history.length,1,'another enabled route preserves history');
 changeLines(lines=>lines.map(l=>l.id==='stats-av-life-b'?{...l,enabled:false}:l));
 eq(readChannelObservationState('rate-history-v1').models[lifeKey].history.length,1,'last route disabled preserves completed points');
 eq(!!readChannelObservationState('rate-tracking-v1').active[lifeKey],true,'last route disabled preserves tracking identity');
 let lifeRow=channelAvailability(lifeNow).rows.find(r=>r.modelId===lifeModel.id);
 eq([lifeRow.requests,lifeRow.successRate,lifeRow.history.length,lifeRow.enabled],[1,0,1,false],'disabled model retains historical stats');
 lifeNow+=minute;
 changeLines(lines=>lines.map(l=>l.id==='stats-av-life'?{...l,members:l.members.map(m=>({...m,enabled:true}))}:l));
 lifeRow=channelAvailability(lifeNow).rows.find(r=>r.modelId===lifeModel.id);
 eq(lifeRow.trackingSince<=lifeOld,true,'reactivation preserves statistical lifetime');
 eq([lifeRow.requests,lifeRow.successRate,lifeRow.history.length],[1,0,1],'one-hour failures and snapshots preserved');
 importChannelObservation({...base,id:'life-late-old',modelId:lifeModel.id,channelId:lifeModel.channelId,startedAt:lifeNow-minute,status:'failed',finishedAt:lifeNow});
 eq(refreshChannelAvailability(lifeNow).rows.find(r=>r.modelId===lifeModel.id).failed,2,'requests within the same lifetime remain included');
 lifeNow++;
 importChannelObservation({...base,id:'life-new-success',modelId:lifeModel.id,channelId:lifeModel.channelId,startedAt:lifeNow,status:'success',finishedAt:lifeNow});
 lifeRow=refreshChannelAvailability(lifeNow).rows.find(r=>r.modelId===lifeModel.id);
 eq([lifeRow.requests,lifeRow.success,lifeRow.failed,lifeRow.successRate],[3,1,2,1/3],'post-reactivation requests join existing lifetime');
 lifeNow++;updateChannel(lifeModel.channelId,{enabled:false});
 eq(!!readChannelObservationState('rate-tracking-v1').active[lifeKey],true,'channel off preserves tracked model');
 lifeNow++;updateChannel(lifeModel.channelId,{enabled:true});
 eq(channelAvailability(lifeNow).rows.find(r=>r.modelId===lifeModel.id).requests,3,'channel re-enable preserves statistics');
 lifeNow++;deleteModel(lifeModel.id);
 eq(channelAvailability(lifeNow).rows.some(r=>r.modelId===lifeModel.id||r.modelId==='deleted-model'),false,'deleted models cannot be resurrected by historical observations');
 lifeNow++;createModel({...lifeModel,familyId:'av-fam-av-life'});
 lifeRow=channelAvailability(lifeNow).rows.find(r=>r.modelId===lifeModel.id);
 eq([lifeRow.requests,lifeRow.history.length,lifeRow.trackingSince],[0,0,lifeNow],'recreated same ID starts a new statistical lifetime');
 eq(db.prepare("SELECT count(*) n FROM channel_observations WHERE id LIKE 'life-%'").get().n,3,'cleanup preserves auditable request observations');
 eq(readChannelObservationState('rate-history-v1').models[rowKey],persisted.models[rowKey],'lifecycle cleanup never clears another model');
}finally{Date.now=realNow;}
writeFileSync('availability-history-restart.json',JSON.stringify({rowKey,sampleStart,persisted:readChannelObservationState('rate-history-v1'),lifeKey,lifeSince:lifeNow}));
new Function(readFileSync('./src/admin/auto-routing.js','utf8'));checks++;
await app.close();await flushPendingSaves();stopChannelAvailabilityBackground();closeSqlite();
writeFileSync('availability-proof.json',JSON.stringify({checks,upstreamCalls:0,summaryMs,cached100Ms},null,2));console.log('AVAILABILITY '+checks+' passed; zero upstream');
