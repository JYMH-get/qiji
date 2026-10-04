import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
if(!import.meta.url.includes('qiji-usage-reports-'))throw Error('Sandbox only');
globalThis.fetch=async()=>{throw Error('No upstream requests allowed')};
const codes=await import('../src/store/redeemCodes.ts'),teams=await import('../src/store/teams.ts'),users=await import('../src/store/users.ts'),agents=await import('../src/store/agents.ts');
const {default:Fastify}=await import('fastify');const app=Fastify();
await app.register((await import('../src/routes/admin.ts')).registerAdminRoutes);await app.register((await import('../src/routes/agent.ts')).registerAgentRoutes);await app.ready();
let checks=0;const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++};
const a=agents.createAgent({name:'A',account:'cleanup-a',password:'fixture-pass',credits:1000}).agent,b=agents.createAgent({name:'B',account:'cleanup-b',password:'fixture-pass',credits:2000}).agent;
const token=agents.createAgentSession(a.id),fixtures=[];
for(const agentId of [undefined,a.id,b.id]){
 const user=users.createUser({name:'清理测试',agentId,credits:123});
 const used=codes.createCodes({count:1,credits:100,agentId})[0];codes.redeemCode(used.code,user.id,user.name,agentId);
 const unused=codes.createCodes({count:1,credits:100,agentId})[0];
 const expired=codes.createCodes({count:1,credits:100,agentId,expiresAt:'2020-01-01T00:00:00Z'})[0];
 const tc=teams.createTeamCodes(1,'used',agentId)[0],unusedTc=teams.createTeamCodes(1,'unused',agentId)[0];
 const result=teams.createTeam({code:tc.code,name:'保持团队'+fixtures.length,leaderId:user.id});eq(result.ok,true,'fixture team created');
 fixtures.push({agentId,user,used,unused,expired,tc,unusedTc,team:result.team});
}
const call=(prefix,kind,auth,body={},query='')=>app.inject({method:'POST',url:`/${prefix}-api/${kind}/prune-used${query}`,headers:{authorization:'Bearer '+auth},payload:body});
try{
 for(const kind of ['redeem-codes','team-codes']){
  eq((await call('admin',kind,'bad')).statusCode,401,'admin authentication');
  eq((await call('agent',kind,'bad')).statusCode,401,'agent authentication');
  eq((await call('agent',kind,token,{agentId:b.id})).statusCode,400,'body cannot override owner');
  eq((await call('agent',kind,token,{},'?agentId='+b.id)).statusCode,400,'query cannot override owner');
  eq((await call('agent',kind,token)).json().removed,1,'agent removes own used record');
  eq((await call('agent',kind,token)).json().removed,0,'idempotent repeat');
  eq((await call('admin',kind,'admin-dev')).json().removed,1,'source removes only source record');
 }
 for(const [index,f] of fixtures.entries()){
  eq(Boolean(codes.getCode(f.used.code)),index===2,'other agent used redemption preserved');
  eq(Boolean(teams.getTeamCode(f.tc.code)),index===2,'other agent used team code preserved');
  eq(Boolean(codes.getCode(f.unused.code)),true,'unused preserved');eq(Boolean(codes.getCode(f.expired.code)),true,'expired unused preserved');
  eq(Boolean(teams.getTeamCode(f.unusedTc.code)),true,'unused team code preserved');
  eq(teams.getTeam(f.team.id)?.leaderId,f.user.id,'live team survives cleanup');
  eq(users.getUser(f.user.id).credits,123,'user balance unchanged');
 }
 eq(agents.getAgent(a.id).credits,1000,'no refund to agent A');eq(agents.getAgent(b.id).credits,2000,'no refund to agent B');
 const mine=(await app.inject({url:'/agent-api/team-codes',headers:{authorization:'Bearer '+token}})).json().items;
 eq(mine.map(c=>c.code),[fixtures[1].unusedTc.code],'merchant list restricted to issuer');
 const persistedCodes=JSON.parse(fs.readFileSync(new URL('../data/redeem-codes.json',import.meta.url),'utf8'));
 eq(persistedCodes.length,7,'redeem cleanup persisted');
 const persistedTeams=JSON.parse(fs.readFileSync(new URL('../data/teams.json',import.meta.url),'utf8'));
 eq(persistedTeams.codes.length,4,'team code cleanup persisted');eq(persistedTeams.teams.length,3,'teams persisted unchanged');
 for(const portal of ['admin','agent']){
  const html=(await app.inject('/'+portal)).body;
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new Function(m[1]);
  for(const kind of ['redeem-codes','team-codes'])eq(html.includes(`onclick="clearUsedCodes('${kind}')"`),true,'cleanup button present');
  const helper=html.slice(html.indexOf('function clearUsedCodes(kind){'),html.indexOf('async function loadRedeem(){',html.indexOf('function clearUsedCodes(kind){')));
  let confirmation,requested,reloaded=0;
  const context=vm.createContext({confirmDo:x=>confirmation=x,api:async(...args)=>{requested=args;return {removed:2}},toast:()=>{},loadTeams:async()=>{reloaded++},loadRedeem:async()=>{reloaded++}});
  vm.runInContext(helper,context);
  for(const kind of ['redeem-codes','team-codes']){
   context.kind=kind;vm.runInContext('clearUsedCodes(kind)',context);eq(Boolean(confirmation.onOk),true,'confirmation wired');
   await confirmation.onOk();eq(requested[0],`/${portal}-api/${kind}/prune-used`,'button calls matching protected endpoint');
  }
  eq(reloaded,2,'lists refresh after cleanup');
 }
 console.log(JSON.stringify({checks,externalRequests:0}));
}finally{await app.close()}
