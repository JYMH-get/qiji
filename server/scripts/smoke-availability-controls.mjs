import assert from 'node:assert/strict';
import fs from 'node:fs';
if(!import.meta.url.includes('qiji-line-availability-'))throw Error('Sandbox only');
globalThis.fetch=async()=>{throw Error('No upstream allowed');};
const fixture=JSON.parse(fs.readFileSync('data/line-restart.json','utf8'));
let now=fixture.now;Date.now=()=>now;
const {db,closeSqlite}=await import('../src/store/sqlite.ts');
await import('../src/store/logs.ts');
const models=await import('../src/store/models.ts'),routing=await import('../src/autoRouting.ts');
const modelStats=await import('../src/channelAvailability.ts'),lineStats=await import('../src/lineAvailability.ts');
const obs=await import('../src/store/channelObservations.ts'),edits=await import('../src/availabilityAdjustments.ts');
const archive=await import('../src/availabilityArchive.ts');
obs.writeChannelObservationState('legacy-v1',{done:true});
modelStats.stopChannelAvailabilityBackground();lineStats.stopLineAvailabilityBackground();
const app=(await import('fastify')).default();await app.register((await import('../src/routes/admin.ts')).registerAdminRoutes);await app.ready();
modelStats.stopChannelAvailabilityBackground();lineStats.stopLineAvailabilityBackground();
const admin={authorization:'Bearer admin-dev'},modelId='fixture-a',key=JSON.stringify(['fixture-channel',modelId]);
let checks=0;const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const getStats=(query='window=1h')=>app.inject({url:'/admin-api/channel-availability?'+query,headers:admin});
const scope=()=>modelStats.modelHistoryScope(modelId,now);
const path='/admin-api/models/'+modelId+'/rate-history';
const count=(table,scopeName)=>db.prepare('SELECT COUNT(*) n FROM '+table+' WHERE scope=?').get(scopeName).n;
const hour=3600000,day=24*hour;
try{
 const data=[['half',.5,'success'],['three',3,'failed'],['twelve',12,'success'],['forty-eight',48,'failed'],['five-days',120,'success'],['running',.25,'running']];
 for(const [id,hours,status] of data)obs.importChannelObservation({id:'control-'+id,modelId,modelName:modelId,channelId:'fixture-channel',capability:'text',startedAt:now-hours*hour,status,...(status==='running'?{}:{finishedAt:now-1000})});
 for(let i=0;i<10;i++){now+=60000;modelStats.refreshChannelAvailability(now,true);}
 const initialHistory=scope().history;eq(initialHistory.length,1,'ten fresh minute samples create a point');
 const workingBefore=JSON.stringify(obs.readChannelObservationState('rate-history-v1'));
 for(const [window,success,failed,requests] of [['1h',1,0,2],['5h',1,1,3],['24h',2,1,4],['3d',2,2,5],['7d',3,2,6]]){
  const res=await getStats('window='+window);eq(res.statusCode,200,'range '+window);const row=res.json().rows.find(r=>r.modelId===modelId);
  eq([row.success,row.failed,row.requests,row.successRate],[success,failed,requests,success/(success+failed)],'independent raw counts '+window);eq(row.history,initialHistory,'range never changes waveform '+window);
 }
 const since=now-4*hour,until=now-2*hour;
 const custom=await getStats(new URLSearchParams({since:new Date(since).toISOString(),until:new Date(until).toISOString()}));
 eq(custom.statusCode,200,'custom range accepted');eq(custom.json().rows.find(r=>r.modelId===modelId).successRate,0,'custom selected request failure is genuine zero');
 for(const query of ['window=60d','window=__proto__','since=bad&until=bad','since='+new Date(now-61*day).toISOString()+'&until='+new Date(now).toISOString(),'since='+new Date(now-hour).toISOString()+'&until='+new Date(now+hour).toISOString()])eq((await getStats(query)).statusCode,400,'invalid or unsupported range rejected');
 eq(JSON.stringify(obs.readChannelObservationState('rate-history-v1')),workingBefore,'all filter reads leave raw minute state unchanged');
 // The waveform retains only 10H; the separate archive retains 60 days.
 const p={since:now-2*day-600000,until:now-2*day,successRate:.8,validSamples:10,hasRequests:true};
 archive.archiveAvailability('model:'+modelId,[p],now);
 // Insert intentionally out-of-date records to exercise maintenance of already-persisted data.
 for(const [scopeName,age] of [['model:'+modelId,61*day],['model:'+modelId,59*day],['model:deleted-fixture',day],['line:deleted-fixture',day]])db.prepare('INSERT OR REPLACE INTO availability_snapshot_archive VALUES(?,?,?)').run(scopeName,now-age,JSON.stringify({...p,until:now-age}));
 for(const age of [61*day,59*day])db.prepare('INSERT INTO availability_history_edit_audit VALUES(?,?,?,?)').run('old-audit-'+age,'model:'+modelId,now-age,JSON.stringify({at:now-age,action:'edit'}));
 modelStats.refreshChannelAvailability(now);lineStats.refreshLineAvailability(now);
 eq(db.prepare('SELECT COUNT(*) n FROM availability_snapshot_archive WHERE until<=?').get(now-60*day).n,0,'expired archive deleted at sixty-day boundary');
 eq(count('availability_snapshot_archive','model:deleted-fixture'),0,'orphan model archive cleaned');eq(count('availability_snapshot_archive','line:deleted-fixture'),0,'orphan line archive cleaned');
 eq(db.prepare('SELECT COUNT(*) n FROM availability_snapshot_archive WHERE scope=? AND until=?').get('model:'+modelId,now-59*day).n,1,'59-day archive preserved');
 eq(count('availability_history_edit_audit','model:'+modelId),1,'manual audit retention sixty days');eq(scope().history,initialHistory,'old archive never expands ten-hour waveform');
 let editScope=scope();const blank=edits.adjustmentView(editScope,now).slots.find(p=>!p.original);
 edits.editHistory(editScope,[{until:blank.until,successRate:.95,source:'self-test',reason:'controlled external test'}],now);
 let cfg=routing.routingConfig();cfg.lines.forEach(l=>l.members.forEach(m=>{if(m.modelId===modelId)m.enabled=false;}));routing.saveRoutingConfig(cfg);
 eq(scope().active,false,'route disable pauses model');eq(scope().history,initialHistory,'pause preserves snapshots');eq(scope().epoch,editScope.epoch,'pause preserves edit epoch');
 now+=60000;modelStats.refreshChannelAvailability(now,true);eq(obs.readChannelObservationState('rate-history-v1').models[key].pending,undefined,'disabled model receives no minute samples');eq(count('availability_history_edits','model:'+modelId),1,'pause preserves supplement');
 const countsBefore=(await getStats()).json().rows.find(r=>r.modelId===modelId);
 const lineBefore=lineStats.lineHistoryScope('fixture-line',now).history;
 const resetAt=now;let res=await app.inject({method:'POST',url:path+'/reset',headers:admin,payload:{target:'model',epoch:scope().epoch}});
 eq(res.statusCode,200,'disabled model can be reset');eq(scope().history.length,0,'reset clears current waveform');eq(count('availability_snapshot_archive','model:'+modelId),0,'reset clears whole archive');eq(count('availability_history_edits','model:'+modelId),0,'reset clears supplements');eq(obs.readChannelObservationState('rate-history-v1').models[key],undefined,'reset clears partial group');
 const countsAfter=(await getStats()).json().rows.find(r=>r.modelId===modelId);eq([countsAfter.requests,countsAfter.success,countsAfter.failed],[countsBefore.requests,countsBefore.success,countsBefore.failed],'reset preserves raw request counts');eq(lineStats.lineHistoryScope('fixture-line',now).history,lineBefore,'model reset does not silently reset a shared line');
 eq((await app.inject({method:'POST',url:path+'/reset',headers:admin,payload:{target:'model',epoch:editScope.epoch}})).statusCode,409,'stale reset rejected');
 eq([401,403].includes((await app.inject({method:'POST',url:path+'/reset',payload:{}})).statusCode),true,'reset requires admin');
 cfg=routing.routingConfig();cfg.lines.forEach(l=>l.members.forEach(m=>{if(m.modelId===modelId)m.enabled=true;}));routing.saveRoutingConfig(cfg);
 eq(scope().history.length,0,'re-enable after explicit reset does not backfill');
 for(let i=0;i<9;i++){now+=60000;modelStats.refreshChannelAvailability(now,true);}eq(scope().history.length,0,'reset requires ten fresh samples');now+=60000;modelStats.refreshChannelAvailability(now,true);eq(scope().history.length,1,'tenth post-reset sample creates new history');
 eq(scope().history[0].since>=resetAt,true,'new snapshot starts after reset');
 const lineScope=lineStats.lineHistoryScope('fixture-line',now);
 res=await app.inject({method:'POST',url:path+'/reset',headers:admin,payload:{target:'line:fixture-line',epoch:lineScope.epoch}});eq(res.statusCode,200,'explicit line reset accepted');eq(lineStats.lineHistoryScope('fixture-line',now).history,[],'line waveform reset');eq(count('availability_snapshot_archive','line:fixture-line'),0,'line archive reset');
 eq((await app.inject({method:'POST',url:path+'/reset',headers:admin,payload:{target:'line:unrelated',epoch:''}})).statusCode,400,'cannot reset unrelated line');
 const rawBefore=db.prepare("SELECT COUNT(*) n FROM channel_observations WHERE id LIKE 'control-%'").get().n;
 models.deleteModel(modelId);
 for(const table of ['availability_snapshot_archive','availability_history_edits','availability_history_edit_audit'])eq(count(table,'model:'+modelId),0,'deleted model cleanup '+table);
 eq(obs.readChannelObservationState('rate-tracking-v1').active[key],undefined,'deleted model tracking removed');eq(obs.readChannelObservationState('rate-history-v1').models[key],undefined,'deleted model hot history removed');eq(db.prepare("SELECT COUNT(*) n FROM channel_observations WHERE id LIKE 'control-%'").get().n,rawBefore,'model deletion preserves raw request evidence');
 const beforeDeath=lineStats.lineHistoryScope('fixture-empty',now);archive.archiveAvailability(beforeDeath.scope,[{...p,since:now-600000,until:now}],now);
 models.deleteModel('fixture-b');eq(count('availability_snapshot_archive','line:fixture-empty'),0,'line with no remaining models removes stale snapshots');
 const audioScope=modelStats.modelHistoryScope('fixture-audio',now);eq(audioScope.history.length>0,true,'unrelated model kept accumulating');
 cfg=routing.routingConfig();cfg.lines.forEach(l=>l.members=l.members.filter(m=>models.getModelDef(m.modelId)));cfg.lines.find(l=>l.id==='fixture-audio-line').enabled=false;routing.saveRoutingConfig(cfg);
 fs.writeFileSync('data/controls-restart.json',JSON.stringify({now,audioHistory:audioScope.history,audioEpoch:audioScope.epoch,rawBefore}));
 fs.writeFileSync('data/controls-proof.json',JSON.stringify({checks,upstreamCalls:0,now},null,2));console.log('AVAILABILITY_CONTROLS '+checks+' checks passed; zero upstream');
}finally{await app.close();modelStats.stopChannelAvailabilityBackground();lineStats.stopLineAvailabilityBackground();(await import('../src/store/db.ts')).flushPendingSaves();closeSqlite();}
