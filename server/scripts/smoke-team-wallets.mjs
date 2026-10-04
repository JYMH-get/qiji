import assert from 'node:assert/strict';import fs from 'node:fs';
if(!process.cwd().includes('qiji-team-wallets-'))throw Error('Sandbox only');
let hold=null,bad=false,missing=false,calls=0;
globalThis.fetch=async(url)=>{calls++;if(hold)await hold;if(bad)return new Response(JSON.stringify({error:{message:'fixture failure'}}),{status:500});
 if(String(url).endsWith('/audio-file'))return new Response(new Uint8Array([82,73,70,70,0,0,0,0,87,65,86,69]),{headers:{'content-type':'audio/wav'}});
 if(String(url).endsWith('/audio'))return new Response(JSON.stringify({url:'https://fixture.invalid/audio-file'}),{headers:{'content-type':'application/json'}});
 return new Response([{choices:[{delta:{content:'OK'}}]},...(!missing?[{choices:[],usage:{prompt_tokens:1000,completion_tokens:1000,total_tokens:2000}}]:[])].map(x=>'data: '+JSON.stringify(x)).join('\n\n'),{headers:{'content-type':'text/event-stream'}});};
const users=await import('../src/store/users.ts'),teams=await import('../src/store/teams.ts'),agents=await import('../src/store/agents.ts');
const prices=await import('../src/store/agentLinePrices.ts'),routing=await import('../src/autoRouting.ts'),models=await import('../src/store/models.ts');
const channels=await import('../src/store/channels.ts'),families=await import('../src/store/families.ts'),protocols=await import('../src/store/protocols.ts');
const tasks=await import('../src/store/tasks.ts'),logs=await import('../src/store/logs.ts'),credits=await import('../src/store/credits.ts');
const messages=await import('../src/store/messages.ts'),billing=await import('../src/billingContext.ts'),textBilling=await import('../src/store/textBilling.ts');
const redeemCodes=await import('../src/store/redeemCodes.ts'),membership=await import('../src/store/membership.ts');
const {default:Fastify}=await import('fastify'),app=Fastify();await app.register((await import('../src/routes.ts')).registerRoutes);await app.register((await import('../src/routes/admin.ts')).registerAdminRoutes);await app.ready();
let checks=0;const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++};
const header=u=>({authorization:'Bearer '+u.accessKey,'x-device-id':'team-fixture'});
const admin={authorization:'Bearer admin-dev'};
const alpha=agents.createAgent({name:'甲商',account:'wallet-a',password:'fixture-pass',credits:1000}).agent,beta=agents.createAgent({name:'乙商',account:'wallet-b',password:'fixture-pass',credits:1000}).agent;
const leader=users.createUser({name:'甲团长',agentId:alpha.id,credits:1000}),member=users.createUser({name:'乙团员',agentId:beta.id,credits:1000}),sourceLeader=users.createUser({name:'源站团长',credits:1000});
const pricing=(input,output)=>({enabled:true,multiplier:1,rates:{input,output,cachedInput:0},cacheEnabled:false,peak:{enabled:false,rates:{input,output,cachedInput:0}},longContext:{enabled:false,threshold:128000,rates:{input,output,cachedInput:0},peakRates:{input,output,cachedInput:0}}});
channels.updateChannel('ch-gaisc',{apiKey:'fixture',baseUrl:'https://fixture.invalid',enabled:true});
for(const capability of ['audio','text'])families.createFamily({id:'fam-wallet-'+capability,name:'wallet '+capability,capability});
protocols.createProtocol({id:'wallet-audio',name:'wallet audio',capability:'audio',mode:'async-immediate',request:{method:'POST',path:'/audio',headers:{},body:'{"model":"{{upstreamModel}}"}'},response:{assetUrlPath:'url'}});
models.createModel({id:'wallet-audio',label:'wallet audio',familyId:'fam-wallet-audio',capability:'audio',channelId:'ch-gaisc',protocol:'wallet-audio',enabled:true,shareScope:'all',params:[],cost:999,saveToOss:false});
models.createModel({id:'wallet-text',label:'wallet text',familyId:'fam-wallet-text',capability:'text',channelId:'ch-gaisc',protocol:'openai-chat',enabled:true,shareScope:'all',params:[],cost:999,tokenPricing:pricing(10,20)});
const data=(await app.inject({url:'/admin-api/auto-routing',headers:admin})).json(),config=data.initial;
config.enabled=true;config.lines=config.lines.filter(line=>line.familyId?.startsWith('fam-wallet-'));
const audio=config.lines.find(l=>l.familyId==='fam-wallet-audio'&&l.name==='官方'),text=config.lines.find(l=>l.familyId==='fam-wallet-text'&&l.name==='官方');
for(const line of [audio,text]){line.enabled=true;line.members=[{modelId:'wallet-'+line.capability,enabled:true,vipEnabled:false,priority:0,concurrencyWeight:1,failureThreshold:3,failureWindowSec:300,cooldownSec:300,failureRetainPercent:50,defaults:{}}];line.cost=7;if(line.capability==='text')line.tokenPricing=pricing(10,20)}
routing.saveRoutingConfig(config);const aid='route:'+audio.id,tid='route:'+text.id;
function price(agent,line,layer,value){prices.saveAgentLineSetting(agent.id,line,layer,prices.agentLineSetting(agent.id,line).revision,{price:value})}
price(alpha,aid,'purchase',{cost:3});price(alpha,aid,'retail',{cost:11});price(beta,aid,'purchase',{cost:5});price(beta,aid,'retail',{cost:23});
price(alpha,tid,'purchase',{cost:10,tokenPricing:pricing(5,5)});price(alpha,tid,'retail',{cost:10,tokenPricing:pricing(10,20)});
function createTeam(owner,name){return teams.createTeam({leaderId:owner.id,name,code:teams.createTeamCodes(1)[0].code}).team}
function join(team,user){eq(teams.inviteToTeam(team.id,user.id).ok,true,'invite');eq(teams.acceptInvite(team.id,user.id).ok,true,'accept')}
const team=createTeam(leader,'跨商测试团');join(team,member);teams.updateTeam(team.id,{creditMode:'shared'});
const payload=(id=aid)=>({model:id,purpose:id===tid?'chat.reply':'audio.tts',promptOverride:'test',params:{},inputs:{},output:{format:id===tid?'text':'assets'}});
const gen=(user=member,id=aid)=>app.inject({method:'POST',url:'/v1/generate',headers:header(user),payload:payload(id)});
async function terminal(id){for(let i=0;i<500;i++){const state=tasks.getTaskState(id);if(['success','failed'].includes(state?.status))return state;await new Promise(r=>setTimeout(r,5))}throw Error('timeout '+id)}
async function generate(user=member,id=aid){const response=await gen(user,id);eq(response.statusCode,200,response.body);const state=await terminal(response.json().taskId);eq(state.status,'success','generation completed');return response.json().taskId}
const balances=()=>[leader.credits,member.credits,alpha.credits,beta.credits,teams.grantedOf(team.id,member.id)];
try{
  eq(billing.paymentContextFor(member).priceOwner.id,leader.id,'shared uses leader currency');
  await generate();eq(balances().slice(0,4),[989,1000,997,1000],'shared charges leader retail and merchant cost only');
  teams.setTeamPaymentSource(team.id,member.id,'personal');await generate();eq(balances().slice(0,4),[989,977,997,995],'explicit personal charges member own currency');
  teams.setTeamPaymentSource(team.id,member.id,'team');users.updateUser(leader.id,{credits:0});const before=balances(),callBefore=calls;
  eq((await gen()).statusCode,402,'shared insufficient no fallback');eq(balances(),before,'insufficient no mutation');eq(calls,callBefore,'insufficient no upstream');
  eq(messages.listMessagesForUser(leader).items.some(m=>m.kind==='team-credit'),true,'leader receives insufficient notification');eq(messages.listMessagesForUser(member).items.length,0,'leader alert not exposed to member');
  users.updateUser(leader.id,{credits:1000});teams.removeTeamMember(team.id,member.id);const sourceTeam=createTeam(sourceLeader,'源站跨商团');join(sourceTeam,member);teams.updateTeam(sourceTeam.id,{creditMode:'shared'});
  const sourceBefore=[sourceLeader.credits,member.credits,alpha.credits,beta.credits];await generate();eq([sourceLeader.credits,member.credits,alpha.credits,beta.credits],[sourceBefore[0]-7,...sourceBefore.slice(1)],'source leader charges source price and no merchant');
  teams.removeTeamMember(sourceTeam.id,member.id);join(team,member);teams.updateTeam(team.id,{creditMode:'dispatch'});
  const allocationBefore=[leader.credits,member.credits];eq(teams.allocateTeamCredits(team.id,member.id,50).ok,true,'allocate independent wallet');eq([leader.credits,member.credits,teams.grantedOf(team.id,member.id)],[allocationBefore[0]-50,allocationBefore[1],50],'allocation preserves personal');
  const dispatchBefore=balances();await generate();eq(balances(),[dispatchBefore[0],dispatchBefore[1],dispatchBefore[2]-3,dispatchBefore[3],39],'dispatch wallet uses leader prices');
  eq(teams.allocateTeamCredits(team.id,member.id,-40).ok,false,'cannot reclaim more than team remainder');
  eq(teams.allocateTeamCredits(team.id,member.id,-9).ok,true,'partial reclaim');eq(member.credits,dispatchBefore[1],'reclaim preserves personal');
  const ownBefore=balances();teams.setTeamPaymentSource(team.id,member.id,'personal');await generate();eq(balances(),[ownBefore[0],ownBefore[1]-23,ownBefore[2],ownBefore[3]-5,30],'dispatch personal bypasses team wallet only by selection');
  teams.setTeamPaymentSource(team.id,member.id,'team');teams.allocateTeamCredits(team.id,member.id,-30);const emptyBefore=balances();eq((await gen()).statusCode,402,'empty allocation no fallback');eq(balances(),emptyBefore,'empty allocation unchanged');
  teams.allocateTeamCredits(team.id,member.id,22);const batchBefore=balances();const batch=await app.inject({method:'POST',url:'/v1/batch',headers:header(member),payload:{tasks:[payload(),payload(),payload()]}});eq(batch.statusCode,200,batch.body);
  const states=await Promise.all(batch.json().taskIds.map(terminal));eq(states.map(s=>s.status),['success','success','failed'],'batch respects team balance');eq(balances(),[batchBefore[0],batchBefore[1],batchBefore[2]-6,batchBefore[3],0],'batch never falls into personal currency');
  teams.allocateTeamCredits(team.id,member.id,50);let release;hold=new Promise(resolve=>release=resolve);const lateBefore=balances();const accepted=await gen();eq(accepted.statusCode,200,accepted.body);eq(teams.grantedOf(team.id,member.id),39,'async request precharged wallet');
  teams.removeTeamMember(team.id,member.id);eq([leader.credits,member.credits],[lateBefore[0]+39,lateBefore[1]],'leave returns only unspent allocation');
  bad=true;hold=null;release();eq((await terminal(accepted.json().taskId)).status,'failed','late async failure');bad=false;
  eq([leader.credits,member.credits,alpha.credits,beta.credits],[lateBefore[0]+50,lateBefore[1],lateBefore[2],lateBefore[3]],'late refund returns original leader and merchant');
  join(team,member);teams.allocateTeamCredits(team.id,member.id,50);const tokenBefore=balances();hold=new Promise(resolve=>release=resolve);const textResponse=await gen(member,tid);eq(textResponse.statusCode,200,textResponse.body);eq(teams.grantedOf(team.id,member.id),40,'text wallet precharge');
  price(alpha,tid,'purchase',{cost:10,tokenPricing:pricing(999,999)});price(alpha,tid,'retail',{cost:10,tokenPricing:pricing(999,999)});
  teams.removeTeamMember(team.id,member.id);hold=null;release();const tokenState=await terminal(textResponse.json().taskId);eq(tokenState.status,'success','token finalizes after leave');
  eq([leader.credits,member.credits,alpha.credits,beta.credits],[tokenBefore[0]+47,tokenBefore[1],tokenBefore[2]-2,tokenBefore[3]],'token frozen retail3 purchase2 settle original owner');
  const afterToken=[leader.credits,member.credits,alpha.credits,beta.credits];await textBilling.recoverTextBillingResults();eq([leader.credits,member.credits,alpha.credits,beta.credits],afterToken,'token recovery idempotent');
  const goneLeader=users.createUser({name:'deleted leader',credits:100}),orphan=users.createUser({name:'orphan member',agentId:beta.id,credits:100});
  const orphanTeam=createTeam(goneLeader,'团长删除边界');join(orphanTeam,orphan);teams.updateTeam(orphanTeam.id,{creditMode:'shared'});users.deleteUser(goneLeader.id);
  const orphanCalls=calls;eq((await gen(orphan)).statusCode,402,'missing leader must not switch to personal');eq(orphan.credits,100,'missing leader preserves member personal balance');eq(calls,orphanCalls,'missing leader never dispatches');
  // HTTP balance projections must follow the explicitly selected wallet, including non-generation endpoints.
  const viewLeader=users.createUser({name:'预检团长',agentId:alpha.id,credits:100}),viewMember=users.createUser({name:'预检团员',agentId:beta.id,credits:200});
  const viewTeam=createTeam(viewLeader,'钱包接口测试');join(viewTeam,viewMember);teams.updateTeam(viewTeam.id,{creditMode:'dispatch'});teams.allocateTeamCredits(viewTeam.id,viewMember.id,10);
  const viewBalances=()=>[viewLeader.credits,viewMember.credits,teams.grantedOf(viewTeam.id,viewMember.id),alpha.credits,beta.credits];
  const precheck=()=>app.inject({method:'POST',url:'/v1/fees/third-party/precheck',headers:header(viewMember)});
  models.updateModel('fee-thirdparty',{cost:17});
  const precheckBefore=viewBalances(),precheckCalls=calls,precheckOps=credits.listCreditOps({limit:1000}).length;
  for(let i=0;i<3;i++){const response=await precheck();eq(response.statusCode,402,'every insufficient precheck rejects using configured fee 17, not fallback 5: '+response.body)}
  eq(viewBalances(),precheckBefore,'failed prechecks do not debit either currency');eq(calls,precheckCalls,'failed prechecks never call upstream');eq(credits.listCreditOps({limit:1000}).length,precheckOps,'prechecks do not create credit operations');
  const shortage=messages.listMessagesForUser(viewLeader).items.filter(m=>m.kind==='team-credit');
  eq(shortage.length,1,'repeated prechecks notify leader once per hour');eq(shortage[0].body.includes('17'),true,'shortage message uses configured fee');eq(messages.listMessagesForUser(viewMember).items.length,0,'precheck shortage message belongs only to leader');
  teams.setTeamPaymentSource(viewTeam.id,viewMember.id,'personal');eq((await precheck()).statusCode,200,'explicit personal precheck ignores insufficient team allocation');eq(viewBalances(),precheckBefore,'successful personal precheck never charges');
  teams.setTeamPaymentSource(viewTeam.id,viewMember.id,'team');teams.allocateTeamCredits(viewTeam.id,viewMember.id,7);const fundedBefore=viewBalances();
  eq((await precheck()).statusCode,200,'team precheck passes at exact configured fee');eq(viewBalances(),fundedBefore,'successful team precheck never charges');eq(calls,precheckCalls,'all prechecks avoid upstream');
  async function redeemWallet(kind,amount,expectedWallet){
    const personalBefore=viewMember.credits,othersBefore=[viewLeader.credits,alpha.credits,beta.credits],allocationBefore=teams.grantedOf(viewTeam.id,viewMember.id);
    let code;
    if(kind==='membership'){membership.setMembershipPlan({enabled:true,days:30,credits:amount,discountPercent:95,modelDiscounts:{}},beta.id);code=membership.createMembershipCards(1,'wallet projection',beta.id)[0].code}
    else code=redeemCodes.createCodes({credits:amount,agentId:beta.id})[0].code;
    const response=await app.inject({method:'POST',url:kind==='membership'?'/v1/membership/redeem':'/v1/redeem',headers:header(viewMember),payload:{code}});
    eq(response.statusCode,200,response.body);const result=response.json();
    eq([result.credits,result.ownCredits,result.added],[expectedWallet,personalBefore+amount,amount],kind+' redemption returns selected wallet and separate personal balance');
    eq([result.team.teamCredits,result.team.personalCredits,result.team.paymentSource],[expectedWallet,personalBefore+amount,'team'],kind+' redemption keeps team balance projection');
    eq([viewMember.credits,teams.grantedOf(viewTeam.id,viewMember.id)],[personalBefore+amount,allocationBefore],kind+' redemption credits personal only');
    eq([viewLeader.credits,alpha.credits,beta.credits],othersBefore,kind+' redemption never debits leader or merchants');
  }
  await redeemWallet('credits',13,17);await redeemWallet('membership',19,17);
  users.applyMembershipGrant(viewLeader.id,{planName:'团长会员',days:30,discountPercent:80});
  async function availabilityPrice(){const response=await app.inject({url:'/v1/route-availability',headers:header(viewMember)});eq(response.statusCode,200,response.body);const row=response.json().rows.find(r=>r.id===aid);assert.ok(row,'fixture audio route visible');return[row.pricing.cost,row.discountPercent]}
  eq(await availabilityPrice(),[11,80],'allocation availability uses leader merchant price and membership, not member payer');
  teams.setTeamPaymentSource(viewTeam.id,viewMember.id,'personal');eq(await availabilityPrice(),[23,95],'personal availability switches to member merchant price and membership');
  teams.setTeamPaymentSource(viewTeam.id,viewMember.id,'team');teams.updateTeam(viewTeam.id,{creditMode:'shared'});
  await redeemWallet('credits',3,viewLeader.credits);await redeemWallet('membership',5,viewLeader.credits);
  eq(await availabilityPrice(),[11,80],'shared availability also uses leader membership');
  const deletionLeader=users.createUser({name:'删除返还团长',agentId:alpha.id,credits:100}),deletionMember=users.createUser({name:'删除返还团员',agentId:beta.id,credits:300});
  const deletionTeam=createTeam(deletionLeader,'删除用户钱包');join(deletionTeam,deletionMember);teams.updateTeam(deletionTeam.id,{creditMode:'dispatch'});teams.allocateTeamCredits(deletionTeam.id,deletionMember.id,50);
  await generate(deletionMember);eq(teams.grantedOf(deletionTeam.id,deletionMember.id),39,'deletion fixture has partially spent allocation');
  const deletionOthers=[alpha.credits,beta.credits,viewLeader.credits,viewMember.credits];users.deleteUser(deletionMember.id);
  eq(users.getUser(deletionMember.id),undefined,'allocated member is deleted');eq(deletionLeader.credits,89,'deleting cross-merchant member returns only unspent allocation to original leader');eq([alpha.credits,beta.credits,viewLeader.credits,viewMember.credits],deletionOthers,'deleting member does not affect other accounts');
  const allLogs=logs.listLogs({userId:member.id,limit:100}).items;eq(allLogs.some(l=>l.creditSource==='team-allocation'&&l.userWallet?.ownerId===leader.id),true,'request log keeps wallet chain');
  for(const op of credits.listCreditOps({accountId:member.id,limit:100}))for(const account of op.accounts)eq(account.pre+account.delta,account.post,'ledger balances');
  fs.writeFileSync('data/team-wallet-restart-proof.json',JSON.stringify({leaderId:leader.id,userId:member.id,agentId:alpha.id,balances:[leader.credits,member.credits,alpha.credits]}));
  // Seed old mixed-wallet data without running any current wallet initializer.
  const legacyLeader=users.createUser({name:'legacy leader',credits:100}),legacyMember=users.createUser({name:'legacy member',credits:80});
  const legacyTeam=createTeam(legacyLeader,'legacy migration');join(legacyTeam,legacyMember);teams.bumpGranted(legacyTeam.id,legacyMember.id,50);
  fs.writeFileSync('data/team-wallet-legacy-proof.json',JSON.stringify({leaderId:legacyLeader.id,userId:legacyMember.id,teamId:legacyTeam.id}));
  console.log('Team wallet checks:',checks);
}finally{await app.close();(await import('../src/store/db.ts')).flushPendingSaves();(await import('../src/store/sqlite.ts')).closeSqlite()}
