import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
if (!import.meta.url.includes('qiji-token-billing-')) throw new Error('Sandbox only');
let rawUsage={prompt_tokens:1000,completion_tokens:1000,total_tokens:2000},bad=false,held;
let calls=0;
globalThis.fetch=async()=>{
  calls++; if(held)await held;
  if(bad) return new Response(JSON.stringify({error:{message:'fixture failure'}}),{status:500});
  const chunks=[{choices:[{delta:{content:'OK'}}]},...(rawUsage?[{choices:[],usage:rawUsage}]:[])];
  return new Response(chunks.map(c=>'data: '+JSON.stringify(c)).join('\n\n'),{headers:{'content-type':'text/event-stream'}});
};
const pricing=await import('../src/textPricing.ts');
const models=await import('../src/store/models.ts'),channels=await import('../src/store/channels.ts');
const users=await import('../src/store/users.ts'),credits=await import('../src/store/credits.ts');
const tasks=await import('../src/store/tasks.ts'),logs=await import('../src/store/logs.ts');
const ledger=await import('../src/store/textBilling.ts');
const {db,closeSqlite}=await import('../src/store/sqlite.ts');
const {flushPendingSaves}=await import('../src/store/db.ts');
const {registerRoutes}=await import('../src/routes.ts');
const {registerAdminRoutes}=await import('../src/routes/admin.ts');
const {default:Fastify}=await import('fastify');
let checks=0;const eq=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++};
const rates={input:5,output:30,cachedInput:.5};
const p={enabled:true,cacheEnabled:false,rates,peak:{enabled:false,rates:{input:9,output:27,cachedInput:.3}},longContext:{enabled:true,threshold:272000,rates:{input:10,output:45,cachedInput:1},peakRates:{input:18,output:54,cachedInput:.6}}};
const modelId='token-smoke';
channels.updateChannel('ch-gaisc',{apiKey:'sandbox',baseUrl:'https://fixture.invalid',enabled:true});
const makeModel=()=>models.createModel({id:modelId,label:'文本计价测试',capability:'text',protocol:'openai-chat',channelId:'ch-gaisc',params:[],cost:10,tokenPricing:p,shareScope:'all'});
const m=makeModel();
const app=Fastify();await app.register(registerRoutes);await app.register(registerAdminRoutes);await app.ready();
const u=users.createUser({name:'token sandbox',credits:10000});
const headers={authorization:'Bearer '+u.accessKey,'x-device-id':'token-sandbox'};
const request=()=>({model:modelId,purpose:'chat.reply',promptOverride:'Reply OK',inputs:{},params:{},output:{format:'text'}});
const call=()=>app.inject({method:'POST',url:'/v1/generate',headers,payload:request()});
async function terminal(id){for(let i=0;i<100;i++){const t=tasks.getTaskState(id);if(['success','failed'].includes(t?.status))return t;await new Promise(r=>setTimeout(r,5));}throw Error('task timeout')}
try{
 eq(pricing.normalizeTextUsage({prompt_tokens:0,completion_tokens:0}),{source:'upstream',inputTokens:0,outputTokens:0,totalTokens:0},'zero is valid');
 eq(pricing.normalizeTextUsage({prompt_tokens:5}),undefined,'missing output not zero');
 eq(pricing.normalizeTextUsage({prompt_tokens:5,completion_tokens:2,prompt_tokens_details:{cached_tokens:6}}),undefined,'invalid cache rejected');
 eq(pricing.normalizeTextUsage({input_tokens:5,output_tokens:4,cache_read_input_tokens:10,cache_creation_input_tokens:3},'anthropic').inputTokens,18,'anthropic input normalized');
 const usage=pricing.normalizeTextUsage(rawUsage);
 for(const multiplier of [.25,.4,1.1]){
  const bill=pricing.textCharge({...p,multiplier},{...usage,inputTokens:20060,outputTokens:1000},0);
  eq(bill.items,{input:Math.ceil(10.03*multiplier),output:Math.ceil(3*multiplier),cache:0},'multiply before per-item rounding '+multiplier);
  eq(bill.multiplier,multiplier,'bill retains multiplier');
  eq(models.resolveModelCost({...m,cost:11,tokenPricing:{...p,enabled:false,multiplier}}),Math.ceil(11*multiplier),'fixed text multiplier');
  eq(models.resolveModelCost({...m,tokenPricing:{...p,multiplier}}),10,'precharge remains10');
 }
 for(const multiplier of [0,-1,NaN,Infinity,'0.25',1001]){assert.throws(()=>pricing.validateTextPricing({...p,multiplier}));checks++;}
 eq(pricing.textCharge({...p,multiplier:.4,cacheEnabled:true},{...usage,inputTokens:100000,cachedInputTokens:50000,outputTokens:0},0).items,{input:10,output:0,cache:1},'cache scaled before rounding');
 eq(pricing.textCharge(p,usage,Date.now()).items,{input:1,output:3,cache:0},'round each item then sum');
 eq(pricing.textCharge(p,{...usage,inputTokens:20060,outputTokens:0},Date.now()).cost,11,'10.03 rounds to 11');
 eq(pricing.textCharge({...p,cacheEnabled:true},{...usage,cachedInputTokens:1000},Date.now()).items,{input:0,output:3,cache:1},'cache enabled has own integer item');
 eq(pricing.textCharge(p,{...usage,cachedInputTokens:1000},Date.now()).cost,4,'cache disabled bills all input normally');
 for(const [at,want] of [['2026-09-14T00:59:59Z',false],['2026-09-14T01:00:00Z',true],['2026-09-14T04:00:00Z',false],['2026-09-14T06:00:00Z',true],['2026-09-14T10:00:00Z',false],['2026-09-12T01:00:00Z',false]])eq(pricing.isTextPeak(Date.parse(at)),want,'peak boundary '+at);
 eq(pricing.textCharge(p,{...usage,inputTokens:272000,outputTokens:0},0).cost,136,'threshold inclusive short');
 eq(pricing.textCharge(p,{...usage,inputTokens:272001,outputTokens:0},0).cost,273,'long threshold whole request');
 eq(models.resolveModelCost(m),10,'precharge10');
 const before=u.credits;
 let release;held=new Promise(r=>release=r);const accepted=await call();eq(accepted.statusCode,200,'generate accepted');const id=accepted.json().taskId;eq(u.credits,before-10,'precharge before upstream completes');
 models.updateModel(modelId,{tokenPricing:{...p,multiplier:.25,rates:{input:500,output:3000,cachedInput:50}}});release();held=undefined;
 const done=await terminal(id);eq(done.status,'success','success');eq(done.result.billing.cost,4,'price snapshot survives config edit');eq(u.credits,before-4,'refund6');eq(done.result.usage.inputTokens,1000,'raw upstream count forwarded');eq(done.result.usage.estimate,undefined,'no local estimate');
 const log=logs.listLogs({model:modelId,limit:1}).items[0];eq(log.cost,4,'log updated to final');eq(log.usage.outputTokens,1000,'log retains usage');
 const balance=u.credits;ledger.finishTextBilling(log.id,done.result);await ledger.recoverTextBillingResults();eq(u.credits,balance,'duplicate and recovery idempotent');
 models.updateModel(modelId,{tokenPricing:p});
 rawUsage={prompt_tokens:100000,completion_tokens:10000};const c=await call(),d=await terminal(c.json().taskId);eq(d.result.billing.cost,80,'supplement70');eq(u.credits,balance-80,'correct supplement');
 users.applyUserCreditsDelta(u.id,u.id,10-u.credits);users.persistUsers();rawUsage={prompt_tokens:100000,completion_tokens:10000};const debt=await call();await terminal(debt.json().taskId);eq(u.credits,-70,'final settlement permits debt');const sent=calls;eq((await call()).statusCode,402,'debt blocks new requests');eq(calls,sent,'no upstream when indebted');
 users.applyUserCreditsDelta(u.id,u.id,1070);users.persistUsers();bad=true;let fail=await call();eq((await terminal(fail.json().taskId)).status,'failed','upstream failure');eq(u.credits,1000,'failure refunds all precharge');bad=false;
 rawUsage=undefined;fail=await call();eq((await terminal(fail.json().taskId)).status,'failed','missing usage fails closed');eq(u.credits,1000,'missing usage refunds');const retryCalls=calls;const retry=await call();eq(retry.statusCode,200,'missing usage does not block next request');await terminal(retry.json().taskId);eq(calls,retryCalls+1,'next request reaches upstream');eq(u.credits,1000,'retry without usage refunds');
 models.updateModel(modelId,{tokenPricing:{...p,enabled:false},cost:7});const fixed=await call();eq((await terminal(fixed.json().taskId)).status,'success','per-request mode works without usage');eq(u.credits,993,'fixed-price7 retained');
 models.updateModel(modelId,{tokenPricing:p});rawUsage={prompt_tokens:1000,completion_tokens:1000};
 const batch=await app.inject({method:'POST',url:'/v1/batch',headers,payload:{tasks:[request(),request()]}});eq(batch.statusCode,200,'batch accepts');for(const taskId of batch.json().taskIds)await terminal(taskId);eq(u.credits,985,'batch each final4');
 for(const op of credits.listCreditOps({accountId:u.id,limit:100}))for(const a of op.accounts)eq(a.pre+a.delta,a.post,'credit ledger arithmetic');
 const admin={authorization:'Bearer admin-dev'};
 const invalid=await app.inject({method:'PUT',url:'/admin-api/models/'+modelId,headers:admin,payload:{tokenPricing:{...p,rates:{...rates,input:-1}}}});eq(invalid.statusCode,400,'negative price rejected');eq(m.tokenPricing.rates.input,5,'invalid save nonmutating');
 const schedule={days:[6],periods:[{start:'22:30',end:'02:15'}]};
 for(const [at,want] of [['2026-09-12T14:29:59Z',false],['2026-09-12T14:30:00Z',true],['2026-09-12T18:14:59Z',true],['2026-09-12T18:15:00Z',false],['2026-09-13T14:30:00Z',false]])eq(pricing.isTextPeak(Date.parse(at),schedule),want,'custom overnight boundary '+at);
 const scheduledPricing={...p,peak:{...p.peak,enabled:true,schedule}};
 const multiSchedule={days:[0,2],periods:[{start:'08:15',end:'10:45'},{start:'14:20',end:'16:00'}]};
 for(const [at,want] of [['2026-09-13T00:15:00Z',true],['2026-09-13T02:45:00Z',false],['2026-09-13T06:20:00Z',true],['2026-09-14T00:15:00Z',false]])eq(pricing.isTextPeak(Date.parse(at),multiSchedule),want,'multiple custom periods '+at);
 eq(pricing.textCharge(scheduledPricing,usage,Date.parse('2026-09-12T14:30:00Z')).period,'peak','custom schedule drives billing');
 eq(pricing.textCharge(scheduledPricing,usage,Date.parse('2026-09-12T18:15:00Z')).period,'offPeak','end exclusive');
 eq((await app.inject({method:'PUT',url:'/admin-api/models/'+modelId,headers:admin,payload:{tokenPricing:scheduledPricing}})).statusCode,200,'save schedule');
 const savedModels=(await app.inject({method:'GET',url:'/admin-api/models',headers:admin})).json().items;
 eq(savedModels.find(x=>x.id===modelId).tokenPricing.peak.schedule,schedule,'schedule reads back unchanged');
 eq(savedModels.find(x=>x.id===modelId).tokenUsageReady,undefined,'no verification status');
 for(const invalidSchedule of [{days:[],periods:schedule.periods},{days:[7],periods:schedule.periods},{days:[1,1],periods:schedule.periods},{days:[1],periods:[]},{days:[1],periods:[{start:'25:00',end:'01:00'}]},{days:[1],periods:[{start:'09:00',end:'09:00'}]}]){
  eq((await app.inject({method:'PUT',url:'/admin-api/models/'+modelId,headers:admin,payload:{tokenPricing:{...p,peak:{...p.peak,schedule:invalidSchedule}}}})).statusCode,400,'invalid schedule rejected');
 }
 const noProbeCalls=calls;
 eq((await app.inject({method:'POST',url:'/admin-api/models/'+modelId+'/verify-token-usage',headers:admin})).statusCode,404,'probe endpoint removed');
 eq(calls,noProbeCalls,'removed probe makes no request');
 models.updateModel(modelId,{tokenPricing:p});
 const catalog=(await app.inject({method:'GET',url:'/v1/catalog',headers})).json();eq(catalog.models.find(x=>x.id===modelId).tokenPricing,undefined,'catalog hides text pricing');

 const teams=await import('../src/store/teams.ts');
 const leader=users.createUser({name:'shared leader',credits:100}),member=users.createUser({name:'shared member',credits:300});
 const code=teams.createTeamCodes(1)[0];const team=teams.createTeam({code:code.code,name:'T'+Date.now(),leaderId:leader.id}).team;
 teams.updateTeam(team.id,{creditMode:'shared'});teams.inviteToTeam(team.id,member.id);teams.acceptInvite(team.id,member.id);
 const shared=await app.inject({method:'POST',url:'/v1/generate',headers:{authorization:'Bearer '+member.accessKey,'x-device-id':'shared-token'},payload:request()});await terminal(shared.json().taskId);
 eq(leader.credits,96,'shared payer charged final4');eq(member.credits,300,'member personal balance unchanged');eq(member.totalSpent,4,'spend attributed to initiator');
 // Persisted result plus completed credit operation: startup must recover without charging again.
 const latest=logs.listLogs({userId:member.id,limit:1}).items[0];
 const saved=JSON.parse(db.prepare('SELECT data FROM text_billing WHERE log_id=?').get(latest.id).data);saved.finalized=false;delete saved.result.billing;
 db.prepare('UPDATE text_billing SET data=? WHERE log_id=?').run(JSON.stringify(saved),latest.id);
 await ledger.recoverTextBillingResults([latest.id]);eq(leader.credits,96,'crash between money and result is idempotent');
 // A refund still credits an indebted payer while other requests are in flight.
 users.applyUserCreditsDelta(leader.id,leader.id,-200,true);users.persistUsers();
 const debtRefund=credits.settle({reason:'refund',payerId:leader.id,statsUserId:member.id,userAmount:-10,agents:[]});eq(debtRefund.ok,true,'partial debt refund succeeds');eq(leader.credits,-94,'debt refund adds10');
 const {createAgent}=await import('../src/store/agents.ts');
 const agent=createAgent({account:'token'+Date.now(),password:'sandbox123',name:'token agent',credits:100}).agent; const agentLog='agent-token-'+Date.now();
 const agentCharge=credits.settle({reason:'generate',ref:agentLog,payerId:'trace-only',statsUserId:'trace-only',userAmount:0,agents:[{id:agent.id,cost:10}]});
 ledger.prepareTextBilling(agentLog,agentCharge.charged,{modelId,pricing:p,at:Date.now(),discountPercent:100});
 const agentResult=ledger.finishTextBilling(agentLog,{text:'OK',usage:pricing.normalizeTextUsage(rawUsage)});eq(agentResult.billing.cost,4,'node final4');eq(agent.credits,96,'node pool mirrors final4');
 const {regenerateAgentNodeKey}=await import('../src/store/agents.ts');regenerateAgentNodeKey(agent.id);
 const nodeHeaders={authorization:'Bearer '+agent.nodeKey,'x-node-user':'test-user'};
 const nodeSingle=await app.inject({method:'POST',url:'/v1/generate',headers:nodeHeaders,payload:request()});eq(nodeSingle.statusCode,200,'node generate accepted');eq((await terminal(nodeSingle.json().taskId)).result.billing.cost,4,'node HTTP final4');eq(agent.credits,92,'node single pool debit4');
 const nodeBatch=await app.inject({method:'POST',url:'/v1/batch',headers:nodeHeaders,payload:{tasks:[request(),request()]}});eq(nodeBatch.statusCode,200,'node batch accepted');
 for(const taskId of nodeBatch.json().taskIds)eq((await terminal(taskId)).result.billing.cost,4,'node batch settles each');eq(agent.credits,84,'node batch pool debit8');
 const splitUser=users.createUser({name:'split usage fixture',credits:1000});
 const splitHeaders={authorization:'Bearer '+splitUser.accessKey,'x-device-id':'split-usage'};
 for (const completion of [1418,6784]) {
  rawUsage={prompt_tokens:7248,completion_tokens:completion,total_tokens:14032,completion_tokens_details:{reasoning_tokens:5366}};
  const response=await app.inject({method:'POST',url:'/v1/generate',headers:splitHeaders,payload:request()});
  eq(response.statusCode,200,'split usage request accepted');
  const result=await terminal(response.json().taskId);
  eq(result.status,'success','real translator accepts split/inclusive reasoning');
  eq(result.result.text,'OK','generated text is delivered');
  eq(result.result.usage.outputTokens,6784,'reasoning charged exactly once');
  eq(result.result.billing.cost,25,'split/inclusive usage identical final price');
 }
 eq(splitUser.credits,950,'two requests debit final price only');
 const merged=pricing.mergeTextUsage(usage,usage);eq(merged.inputTokens,2000,'chain input summed');eq(merged.parts.length,2,'chain per-call context retained');
 const discounted=pricing.textCharge(p,{...usage,inputTokens:100000,outputTokens:10000},0,50);eq(discounted.items,{input:25,output:15,cache:0},'membership discounts each item before rounding');
 const unverified=models.createModel({id:'token-unverified',label:'待验证',enabled:false,capability:'text',protocol:'openai-chat',params:[],tokenPricing:p});
 eq((await app.inject({method:'PUT',url:'/admin-api/models/'+unverified.id,headers:admin,payload:{enabled:true}})).statusCode,200,'enable model without verification');
 eq((await app.inject({method:'PUT',url:'/admin-api/models/'+unverified.id,headers:admin,payload:{tokenPricing:p,enabled:false}})).statusCode,200,'can configure disabled model');
 eq((await app.inject({method:'POST',url:'/admin-api/models',headers:admin,payload:{id:'reject-create',label:'拒绝',capability:'text',protocol:'openai-chat',tokenPricing:p}})).statusCode,200,'create active token model without verification');
 eq((await app.inject({method:'PUT',url:'/admin-api/models/'+modelId,headers:admin,payload:{baseUrl:'https://changed.invalid'}})).statusCode,200,'change upstream without revalidation');
 eq(pricing.textCharge({...p,rates:{input:1e-12,output:0,cachedInput:0}},{...usage,inputTokens:1,outputTokens:0},0).cost,1,'any positive charge rounds up');
 const relay=await import('../src/relay.ts'); const mirrorUser=users.createUser({name:'mirror',credits:10});
 relay.chargeLocalMirror(mirrorUser,mirrorUser.id,10,'mirror-test');relay.ledgerRecord('mirror-test',{u:mirrorUser.id,c:10});
 const mirrorResult={text:'OK',usage,billing:{status:'settled',precharged:10,cost:80,items:{input:50,output:30,cache:0},yuan:.8,period:'offPeak'}};
 relay.ledgerSettleTerminal('mirror-test','success',{response:mirrorResult});eq(mirrorUser.credits,-70,'relay settlement permits debt without log');
 relay.ledgerSettleTerminal('mirror-test','success',{response:mirrorResult});eq(mirrorUser.credits,-70,'relay duplicate terminal idempotent');
 const h=readFileSync('./src/admin/index.html','utf8');new Function(h.match(/<script>([\s\S]*?)<\/script>/)[1]);checks++;
 models.updateModel(modelId,{tokenPricing:scheduledPricing});
 writeFileSync('./text-billing-proof.json',JSON.stringify({checks,stubCalls:calls,realUpstreamCalls:0,lastBalance:u.credits,userId:u.id,mirrorUserId:mirrorUser.id,mirrorBalance:mirrorUser.credits},null,2));
 console.log('TEXT_BILLING '+checks+' checks passed; upstream calls stubbed='+calls);
} finally {await app.close();await flushPendingSaves();closeSqlite();}
