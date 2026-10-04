import assert from 'node:assert/strict';
if(!import.meta.url.includes('qiji-token-billing-startup-'))throw Error('Independent test data required');
let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Expired recovery must not call upstream');};
const {withinRecoveryWindow,RECOVERY_WINDOW_MS:windowMs}=await import('../src/recoveryWindow.ts');
const now=Date.now();
assert.equal(withinRecoveryWindow(now-windowMs,now),true);
assert.equal(withinRecoveryWindow(now-windowMs-1,now),false);
assert.equal(withinRecoveryWindow(now-windowMs+1,now),true);
for(const bad of [undefined,NaN,'bad',now+1])assert.equal(withinRecoveryWindow(bad,now),false);
const logs=await import('../src/store/logs.ts'),tasks=await import('../src/store/tasks.ts');
const users=await import('../src/store/users.ts'),agents=await import('../src/store/agents.ts');
const {settle}=await import('../src/store/credits.ts');
const {settleExpiredRequest}=await import('../src/store/startupExpiry.ts');
const {reconcileOnStartup}=await import('../src/reconcile.ts');
const {db,closeSqlite}=await import('../src/store/sqlite.ts');
const {flushPendingSaves}=await import('../src/store/db.ts');
const owner=users.createUser({name:'expiry payer',credits:1000});
const member=users.createUser({name:'expiry initiator',credits:1000});
const agent=agents.createAgent({account:'expiry-'+now,password:'fixture-only',name:'expiry merchant',credits:1000}).agent;
const old=new Date(now-windowMs-1000).toISOString();
const mk=(withTask=true)=>{
 const log=logs.startLog({req:{model:'token-smoke',purpose:'chat.reply',inputs:{},params:{}},userId:member.id,payerId:owner.id,cost:10,agentCosts:[{id:agent.id,cost:3}]});log.startedAt=old;
 const task=withTask?tasks.createRunningTask('text',undefined,log.id):undefined;
 if(task){task.submittedAt=now-windowMs-1000;tasks.setTaskBilling(task.taskId,member.id,10,[{id:agent.id,cost:3}],owner.id);}
 const charge=settle({reason:'generate',ref:log.id,payerId:owner.id,statsUserId:member.id,userAmount:10,agents:[{id:agent.id,cost:3}]});assert.equal(charge.ok,true);
 return {log,task,charged:charge.charged};
};
const pre=mk(),orphan=mk(false),finalized=mk(),torn=mk(),video=mk(),corrupt=mk();
pre.task.submittedAt=now; // A newer task timestamp must not revive an older request.
video.task.capability='video';video.task.resume={kind:'video',protocol:'openai-video',upstreamTaskId:'never-poll',model:'never-poll'};
orphan.log.purpose='video.generate';logs.attachUpstream(orphan.log.id,{response:{phase:'completed',body:{video_url:'https://fixture.invalid/expired.mp4'}}});
const put=(v,extras={})=>db.prepare('INSERT INTO text_billing(log_id,data) VALUES(?,?)').run(v.log.id,JSON.stringify({charged:v.charged,snapshot:{at:now-windowMs-1000},result:{text:'expired text must not be delivered'},...extras}));
put(pre);put(finalized,{finalized:true});put(torn);put(corrupt);
settle({reason:'text-token-settle',idempotencyKey:'text:'+finalized.log.id,ref:finalized.log.id,payerId:owner.id,statsUserId:member.id,userAmount:5,agents:[]});
settle({reason:'text-token-settle',idempotencyKey:'text:'+torn.log.id,ref:torn.log.id,payerId:owner.id,statsUserId:member.id,userAmount:5,agents:[]});
db.prepare("INSERT INTO credit_ops(op_id,created_at,reason,ref,payer_id,stats_user_id,accounts,status) VALUES(?,?,?,?,?,?,?,?)").run('text:'+corrupt.log.id,now,'text-token-settle',corrupt.log.id,owner.id,member.id,'[]','corrupt');
// A previous refund happened before the process persisted the terminal status.
const previous=mk();const previousInput={logId:previous.log.id,taskId:previous.task.taskId,userId:member.id,payerId:owner.id,cost:10,agents:[{id:agent.id,cost:3}]};
assert.match(settleExpiredRequest(previousInput),/原路退回/);
const before=[owner.credits,member.credits,agent.credits];
await reconcileOnStartup();
assert.deepEqual([owner.credits,member.credits,agent.credits],[before[0]+30,before[1],before[2]+9]);
for(const v of [pre,orphan,finalized,torn,video,corrupt,previous]){
 assert.equal(logs.getLog(v.log.id).status,'failed');
 assert.equal(logs.getLog(v.log.id).response,undefined);
 if(v.task)assert.equal(tasks.getTaskState(v.task.taskId).status,'failed');
}
assert.match(logs.getLog(finalized.log.id).error,/已结算/);
assert.match(logs.getLog(torn.log.id).error,/已结算/);
assert.match(logs.getLog(corrupt.log.id).error,/待核对/);
assert.equal(calls,0,'no polling or stale asset retrieval');
const after=[owner.credits,member.credits,agent.credits];await reconcileOnStartup();
assert.deepEqual([owner.credits,member.credits,agent.credits],after);
assert.match(settleExpiredRequest(previousInput),/已退款/);assert.deepEqual([owner.credits,member.credits,agent.credits],after);
await flushPendingSaves();closeSqlite();
console.log('PASS 48h boundary, expired text/video/orphan, payer+merchant refund, prior-refund crash, finalized/torn settlement, corrupt review, no upstream, repeated startup');
