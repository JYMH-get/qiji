import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
if (!import.meta.url.includes('qiji-token-billing-startup-')) throw Error('Sandbox only');
globalThis.fetch=async()=>{throw Error('No external requests in startup regression')};
const seed=new DatabaseSync('data/qiji.db');
const sample=JSON.parse(seed.prepare("SELECT data FROM text_billing WHERE json_extract(data,'$.finalized')=1 LIMIT 1").get().data);
delete sample.taskId;
const now=new Date().toISOString(), day=now.slice(0,10);
const ins=seed.prepare('INSERT INTO logs(id,day,started_at,owner,meta) VALUES(?,?,?,?,?)');
const bill=seed.prepare('INSERT INTO text_billing(log_id,data) VALUES(?,?)');
seed.exec('BEGIN');
for(let i=0;i<312000;i++){
 const id='history-'+i;ins.run(id,day,now,'',JSON.stringify({id,startedAt:now,finishedAt:now,status:'success',model:'history',purpose:'chat.reply',cost:777}));
 if(i>=312000-14648)bill.run(id,JSON.stringify(sample));
}
seed.exec('COMMIT');seed.close();
const logs=await import('../src/store/logs.ts');
const tasks=await import('../src/store/tasks.ts');
const {db,closeSqlite}=await import('../src/store/sqlite.ts');
const {flushPendingSaves}=await import('../src/store/db.ts');
const {reconcileOnStartup}=await import('../src/reconcile.ts');
const makeLog=(localExecution=false)=>logs.startLog({req:{model:'token-smoke',purpose:'chat.reply',inputs:{},params:{}},cost:0,localExecution});
const recover=makeLog(), task=tasks.createRunningTask('text',undefined,recover.id);
const result={...sample,taskId:task.taskId};
db.prepare('INSERT INTO text_billing(log_id,data) VALUES(?,?)').run(recover.id,JSON.stringify(result));
const parallel=[];
for(let i=0;i<193;i++) {
 const log=makeLog(), pending=tasks.createRunningTask('text',undefined,log.id);
 db.prepare('INSERT INTO text_billing(log_id,data) VALUES(?,?)').run(log.id,JSON.stringify({...sample,taskId:pending.taskId}));
 parallel.push({log, pending});
}
const interrupted=makeLog(), interruptedTask=tasks.createRunningTask('text',undefined,interrupted.id);
const orphan=makeLog(),local=makeLog(true);
const balances=fs.readFileSync('data/users.json','utf8');
let incoming, incomingTask,beats=0;
const heartbeat=setInterval(()=>beats++,1);
setImmediate(()=>{incoming=makeLog();incomingTask=tasks.createRunningTask('text',undefined,incoming.id)});
const begin=performance.now();
await reconcileOnStartup();
const elapsed=performance.now()-begin;
clearInterval(heartbeat);
assert.equal(tasks.getTaskState(task.taskId).status,'success');
assert.equal(logs.getLog(recover.id).status,'success');
for(const {log,pending} of parallel) {
 assert.equal(logs.getLog(log.id).status,'success');
 assert.equal(tasks.getTaskState(pending.taskId).status,'success');
}
assert.equal(tasks.getTaskState(interruptedTask.taskId).status,'failed');
assert.equal(logs.getLog(orphan.id).status,'failed');
assert.equal(logs.getLog(local.id).status,'running');
assert.equal(logs.getLog(incoming.id).status,'running');
assert.equal(tasks.getTaskState(incomingTask.taskId).status,'running');
assert.equal(logs.getLog('history-311999').cost,777,'terminal history must not be replayed');
assert.ok(beats>0,'event loop remains responsive during recovery');
assert.ok(elapsed<5000,'startup recovery must not scan all settled history');
logs.finishLog(incoming.id,{status:'success'});tasks.completeTask(incomingTask.taskId,{text:'new'});
await reconcileOnStartup();
assert.equal(logs.getLog('history-311999').cost,777);
assert.equal(fs.readFileSync('data/users.json','utf8'),balances,'no extra money movement');
let t=performance.now();for(let i=0;i<10000;i++)assert.equal(logs.getLog('history-311999').id,'history-311999');
const lookupMs=performance.now()-t;assert.ok(lookupMs<3000,'ID lookup scales independently of log count');
await flushPendingSaves();closeSqlite();
console.log(JSON.stringify({checks:13+parallel.length*2,historyLogs:312000,settledText:14648,recoveredText:parallel.length+1,recoveryMs:elapsed,lookup10000Ms:lookupMs,heartbeats:beats,realUpstreamCalls:0}));
