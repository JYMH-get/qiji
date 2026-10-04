import assert from 'node:assert/strict';
if (!process.cwd().includes('qiji-credit-feedback-')) throw Error('Sandbox only');
let checks = 0, calls = 0, failure = 'insufficient balance', phase = 'submit', responseStatus = 402, errorCode = '';
const eq = (a,b,label) => { assert.deepEqual(a,b,label); checks++; };
globalThis.fetch = async url => {
  assert.ok(String(url).startsWith('https://fixture.invalid/'), 'only mocked upstream'); calls++;
  if (phase === 'poll' && String(url).endsWith('/submit')) return Response.json({id:'upstream-fixture'});
  if (phase === 'poll') return Response.json({status:'failed',error:{message:failure}});
  return Response.json({error:{code:errorCode,message:failure}}, {status:responseStatus});
};
const users = await import('../src/store/users.ts'), teams = await import('../src/store/teams.ts');
const agents = await import('../src/store/agents.ts'), credits = await import('../src/store/credits.ts');
const models = await import('../src/store/models.ts'), channels = await import('../src/store/channels.ts');
const protocols = await import('../src/store/protocols.ts'), routing = await import('../src/autoRouting.ts');
const tasks = await import('../src/store/tasks.ts'), logs = await import('../src/store/logs.ts');
const { AGENT_CREDIT_SHORTAGE, UPSTREAM_CREDIT_SHORTAGE } = await import('../src/creditFeedback.ts');
const { default:Fastify } = await import('fastify');
const app = Fastify(); await app.register((await import('../src/routes.ts')).registerRoutes); await app.ready();
channels.updateChannel('ch-gaisc', {enabled:true,apiKey:'fixture',baseUrl:'https://fixture.invalid'});
routing.saveRoutingConfig({...routing.routingConfig(), enabled:false});
const merchant = agents.createAgent({name:'feedback merchant',account:'feedback',password:'fixture-pass',credits:100}).agent;
const user = users.createUser({name:'feedback user',credits:100,agentId:merchant.id});
const leader = users.createUser({name:'feedback leader',credits:100,agentId:merchant.id});
for (const [id, mode, capability] of [['feedback-text','sync','text'],['feedback-image','async-immediate','image'],['feedback-video','async-poll','video']]) {
  protocols.createProtocol({id,name:id,enabled:true,mode,capability,request:{method:'POST',path:'/submit',headers:{},body:'{}'},
    response:{textPath:'text',assetUrlPath:'url',taskIdPath:'id',errorPath:'error.message'},
    ...(mode === 'async-poll' ? {poll:{method:'GET',path:'/poll',headers:{},statusPath:'status',successWhen:'success',failWhen:'failed',errorPath:'error.message',intervalMs:5,timeoutMs:1000}} : {})});
  models.createModel({id,label:id,capability,protocol:id,channelId:'ch-gaisc',enabled:true,shareScope:'all',params:[],cost:5,saveToOss:false});
}
const headers = u => ({authorization:'Bearer '+u.accessKey,'x-device-id':'feedback-fixture'});
const payload = (model='feedback-image') => ({model,purpose:model.endsWith('text')?'chat.reply':'image.generate',promptOverride:'fixture',params:{},inputs:{},output:{format:'assets'}});
const gen = (u=user,model) => app.inject({method:'POST',url:'/v1/generate',headers:headers(u),payload:payload(model)});
const terminal = async id => {for(let i=0;i<500;i++){const t=tasks.getTaskState(id);if(t?.status==='failed')return t;await new Promise(r=>setTimeout(r,5));}throw Error('Task timeout');};
try {
  users.updateUser(user.id,{credits:0}); let before = calls;
  let response = await gen(); eq(response.statusCode,402,'personal rejection'); assert.match(response.json().error.message,/^个人积分不足/); checks++;
  eq(calls,before,'personal rejection no upstream');
  users.updateUser(user.id,{credits:100}); agents.changeAgentCredits(merchant.id,-merchant.credits);
  response = await gen(); eq(response.statusCode,402,'merchant rejection'); eq(response.json().error.message,AGENT_CREDIT_SHORTAGE,'merchant feedback');
  eq(user.credits,100,'merchant rejection does not debit personal'); eq(calls,before,'merchant rejection no upstream');
  response = await app.inject({method:'POST',url:'/v1/batch',headers:headers(user),payload:{tasks:[payload(),payload()]}});
  eq(response.statusCode,200,'batch returns tasks');
  for(const id of response.json().taskIds) eq((await terminal(id)).error,AGENT_CREDIT_SHORTAGE,'batch merchant feedback');
  eq(calls,before,'batch rejection no upstream'); eq(user.credits,100,'batch rejection no debit');
  const node = agents.regenerateAgentNodeKey(merchant.id);
  response = await app.inject({method:'POST',url:'/v1/generate',headers:{authorization:'Bearer '+node.nodeKey},payload:payload()});
  eq(response.statusCode,402,'node pool rejection'); eq(response.json().error.message,AGENT_CREDIT_SHORTAGE,'node merchant feedback');
  eq(calls,before,'node rejection no upstream');
  agents.changeAgentCredits(merchant.id,100);
  const team = teams.createTeam({leaderId:leader.id,name:'feedback team',code:teams.createTeamCodes(1)[0].code}).team;
  teams.inviteToTeam(team.id,user.id); teams.acceptInvite(team.id,user.id); teams.updateTeam(team.id,{creditMode:'shared'});
  users.updateUser(leader.id,{credits:0}); response = await gen(); eq(response.statusCode,402,'shared team rejection');
  assert.match(response.json().error.message,/^团队积分不足/); checks++; eq(user.credits,100,'shared no personal fallback');
  users.updateUser(leader.id,{credits:100}); teams.updateTeam(team.id,{creditMode:'dispatch'});
  response = await gen(); eq(response.statusCode,402,'empty team allocation rejection'); assert.match(response.json().error.message,/^团队积分不足/); checks++;
  const wallet = {teamId:team.id,ownerId:leader.id,ownerAgentId:merchant.id};
  let result = credits.settle({reason:'generate',payerId:user.id,statsUserId:user.id,userAmount:5,userWallet:wallet,agents:[]});
  eq(result.ok,false,'allocation settlement guard'); assert.match(result.error,/^团队积分不足/); checks++;
  users.updateUser(leader.id,{credits:0});
  result = credits.settle({reason:'generate',payerId:leader.id,statsUserId:leader.id,userAmount:5,creditSource:'team-shared',agents:[]});
  assert.match(result.error,/^团队积分不足/); checks++;
  result = credits.settle({reason:'generate',payerId:leader.id,statsUserId:leader.id,userAmount:5,creditSource:'personal',agents:[]});
  assert.match(result.error,/^个人积分不足/); checks++;
  teams.setTeamPaymentSource(team.id,user.id,'personal');
  for (const model of ['feedback-text','feedback-image','feedback-video']) {
    for (const stage of model==='feedback-video'?['submit','poll']:['submit']) {
      phase=stage; failure='insufficient balance'; const balances=[user.credits,merchant.credits];
      response=await gen(user,model); eq(response.statusCode,200,`${model} admitted`);
      const task=await terminal(response.json().taskId); eq(task.error,UPSTREAM_CREDIT_SHORTAGE,`${model} ${stage} feedback`);
      eq([user.credits,merchant.credits],balances,`${model} ${stage} refunds both accounts`);
      const log=logs.filterLogs({userIds:[user.id]}).find(l=>l.taskId===task.taskId); assert.ok(log); checks++;
      eq(logs.getLog(log.id).error,UPSTREAM_CREDIT_SHORTAGE,'log matches task');
      assert.match(JSON.stringify(logs.getLog(log.id).upstreamResponse),/insufficient balance/); checks++;
    }
  }
  phase='submit'; failure='rate limit exceeded'; response=await gen();
  assert.match((await terminal(response.json().taskId)).error,/rate limit exceeded/); checks++;
  const {submitOfficialVideo}=await import('../src/translators/official.ts');
  const {prepareOfficialMaterial}=await import('../src/officialMaterials.ts');
  const {createAsset,runWithAssetOwner}=await import('../src/store/assets.ts');
  const up={baseUrl:'https://fixture.invalid',apiKey:'fixture',upstreamModel:'sd-video-v2'};
  models.updateModel('off-sd2.0',{baseUrl:up.baseUrl,apiKey:up.apiKey,materialPolicy:{kind:'official-assets',library:'sd',groupRequired:true}});
  const asset=await createAsset(Buffer.from('fixture'),'image/png','image',{saveToOss:false});
  for(const [code,msg,expected] of [['insufficient_balance','service unavailable',UPSTREAM_CREDIT_SHORTAGE],['','insufficient balance',UPSTREAM_CREDIT_SHORTAGE],['','permission denied','permission denied']]) {
    errorCode=code;failure=msg;responseStatus=403;
    const submitted=await submitOfficialVideo({...payload('off-sd2.0'),purpose:'video.generate'},up);
    assert.ok(submitted.error.includes(expected)); checks++;
    await assert.rejects(runWithAssetOwner({userId:user.id},()=>prepareOfficialMaterial({id:asset.id,url:'https://fixture.invalid/image.png',usage:'identity'},models.getModelDef('off-sd2.0'),up)), e=>e.message.includes(expected)); checks++;
  }
  const {default:nodemailer}=await import('nodemailer'); const sent=[];
  nodemailer.createTransport=()=>({sendMail:async message=>{sent.push(message);},close(){}});
  const settings=await import('../src/store/settings.ts');
  settings.setRegisterSettings({smtp:{host:'fixture.invalid',user:'fixture',pass:'fixture'}});
  const {sendCodeMail}=await import('../src/services/mailer.ts');
  for(const action of ['注册','找回密码']) {
    await sendCodeMail('fixture@example.invalid','012345',action);
    const preview=sent.at(-1).text.replace(/\s/g,'');
    eq(preview.match(/\d+/g),['012345'],'preview has one six digit code');
    assert.ok(preview.includes('【012345】。有效期：十分钟。')); checks++;
  }
  console.log(`Credit feedback integration: ${checks} checks passed; all ${calls} upstream requests mocked; SMTP mocked.`);
} finally { await app.close(); }
