import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
if(!process.cwd().includes('qiji-tenant-boundaries-')) throw Error('Sandbox only');
globalThis.fetch=async()=>{throw Error('No network in tenant tests')};
fs.mkdirSync('data',{recursive:true});
const legacyCard={code:'sc-legacy',target:'user',bytes:1024,days:30,usedBy:{type:'user',id:'legacy-owner'},createdAt:new Date().toISOString()};
fs.writeFileSync('data/storage-codes.json',JSON.stringify({codes:[legacyCard]}));
const agents=await import('../src/store/agents.ts'),users=await import('../src/store/users.ts');
const settings=await import('../src/store/settings.ts'),invites=await import('../src/tenantIdentity.ts');
const codes=await import('../src/store/redeemCodes.ts'),members=await import('../src/store/membership.ts'),storage=await import('../src/store/storageCodes.ts');
const {default:Fastify}=await import('fastify'),app=Fastify();
await app.register((await import('../src/routes/admin.ts')).registerAdminRoutes);
await app.register((await import('../src/routes/agent.ts')).registerAgentRoutes);await app.ready();
let checks=0;const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++};
const admin={authorization:'Bearer admin-dev'};
const a=agents.createAgent({name:'租户甲',account:'tenant-a',password:'fixture-pass',credits:200}).agent;
const b=agents.createAgent({name:'租户乙',account:'tenant-b',password:'fixture-pass',credits:300}).agent;
const sourceUser=users.createUser({name:'源站用户',credits:100});
const au=users.createUser({name:'甲用户',agentId:a.id,credits:80}),bu=users.createUser({name:'乙用户',agentId:b.id,credits:90});
const req=(method,url,payload)=>app.inject({method,url,payload,headers:admin});
try {
  const sc=settings.getSourceInviteCode();eq(settings.getSourceInviteCode(),sc,'source invite stable');
  eq(invites.resolveRegistrationInvite(''),{ok:false,error:'请填写邀请码'},'empty invite rejected');
  eq(invites.resolveRegistrationInvite(sc.toLowerCase()),{ok:true,kind:'source'},'source invite');
  eq(invites.resolveRegistrationInvite(a.inviteCode),{ok:true,kind:'agent',agentId:a.id},'agent invite');
  const own=users.ensureUserInviteCode(au);eq(invites.resolveRegistrationInvite(own),{ok:true,kind:'user',agentId:a.id,inviterId:au.id},'personal invite inherits merchant');
  eq(invites.resolveRegistrationInvite(users.ensureUserInviteCode(sourceUser)).agentId,undefined,'personal source invite inherits source');
  agents.updateAgent(a.id,{enabled:false});eq(invites.resolveRegistrationInvite(own).ok,false,'disabled merchant personal invite rejected');agents.updateAgent(a.id,{enabled:true});
  users.updateUser(bu.id,{inviteCode:own});eq(invites.resolveRegistrationInvite(own).ok,false,'duplicate invites rejected');users.updateUser(bu.id,{inviteCode:undefined});
  eq((await req('PUT','/admin-api/settings/register',{sourceInviteCode:own})).statusCode,409,'source conflicts rejected');
  eq((await req('PUT','/admin-api/settings/register',{sourceInviteCode:'SOURCETEST'})).statusCode,200,'source invite configurable');
  eq((await req('GET','/admin-api/settings/register')).json().sourceInviteCode,'SOURCETEST','source invite private settings returns');
  const sourceCode=codes.createCodes({credits:11})[0],ac=codes.createCodes({credits:21,agentId:a.id,prefix:'ALPHA'})[0];
  eq(ac.code.startsWith('ALPHA-'),true,'prefix applied');eq(ac.agentDebit,0,'issuance free');eq(agents.getAgent(a.id).credits,200,'issuance balance unchanged');
  for(const [c,u,allowed] of [[sourceCode,sourceUser,true],[sourceCode,au,false],[ac,au,true],[ac,bu,false],[ac,sourceUser,false]]) eq(codes.codeUsableBy(c,u.agentId),allowed,'issuer matrix');
  eq(codes.redeemCode(sourceCode.code,au.id,au.name,au.agentId).ok,false,'source code cannot credit merchant');eq(sourceCode.used,false,'failed redemption preserves code');
  eq(codes.redeemCode(ac.code,bu.id,bu.name,bu.agentId).ok,false,'other merchant cannot redeem');
  eq(codes.redeemCode(ac.code,au.id,au.name,au.agentId).ok,true,'own redemption succeeds');
  eq(codes.redeemCode(ac.code,au.id,au.name,au.agentId).ok,false,'double redemption rejected');
  const expired=codes.createCodes({credits:7,agentId:a.id,expiresAt:'2020-01-01'})[0];codes.pruneInvalidCodes(Date.now(),{});eq(!!codes.getCode(expired.code),true,'source cleanup preserves merchant codes');
  eq((await req('DELETE','/admin-api/redeem-codes/'+expired.code)).statusCode,403,'source cannot void merchant code');
  eq((await req('POST','/admin-api/redeem-codes',{credits:1,agentId:a.id})).statusCode,403,'source cannot mint merchant code');
  members.setMembershipPlan({days:10,credits:10,discountPercent:90});members.setMembershipPlan({days:20,credits:20,discountPercent:80},a.id);
  eq(members.getMembershipPlan().days,10,'source membership separate');eq(members.getMembershipPlan(a.id).days,20,'merchant membership separate');eq(members.getMembershipPlan(b.id).days,30,'other merchant default unchanged');
  const sm=members.createMembershipCards(1)[0],am=members.createMembershipCards(1,'fixture',a.id)[0];
  eq(members.listMembershipCards().map(x=>x.code),[sm.code],'source card list isolated');
  eq(members.useMembershipCard(sm.code,au.id,au.name,a.id).ok,false,'source membership card rejected by merchant');
  eq(members.useMembershipCard(am.code,sourceUser.id,sourceUser.name).ok,false,'merchant membership card rejected by source');
  eq(members.deleteMembershipCard(am.code).ok,false,'source cannot delete merchant card');
  eq(members.useMembershipCard(am.code,au.id,au.name,a.id).ok,true,'own member card works');
  for(const [method,url,payload] of [
    ['PUT','/admin-api/users/'+au.id,{credits:999}],['PUT','/admin-api/users/'+au.id,{name:'overwrite'}],
    ['POST','/admin-api/users/'+au.id+'/reset-password',{password:'bypass-pass'}],['POST','/admin-api/users/'+au.id+'/regenerate-key',{}],
    ['DELETE','/admin-api/users/'+au.id],['POST','/admin-api/users/batch-op',{ids:[sourceUser.id,au.id],op:'disable'}],
    ['POST','/admin-api/users',{name:'source-forge',agentId:a.id,credits:1000}],
    ['POST','/admin-api/membership/grant',{userId:au.id}],['DELETE','/admin-api/membership/members/'+au.id],
    ['PUT','/admin-api/agents/'+a.id,{password:'bypass-pass'}],
  ]) eq((await req(method,url,payload)).statusCode,403,'blocked '+method+' '+url);
  eq((await req('POST','/admin-api/users/transfer',{ids:[sourceUser.id],targetAgentId:a.id})).statusCode,400,'migration requires reviewed confirmation');
  eq([users.getUser(sourceUser.id).enabled,users.getUser(au.id).credits],[true,80],'mixed batch has no partial changes');
  const merchantView=(await req('GET','/admin-api/users?agentId='+a.id)).json().items[0];
  eq([merchantView.accessKey,merchantView.passwordHash,merchantView.devices,merchantView.readOnly],[undefined,undefined,undefined,true],'merchant users read only without credentials');
  eq((await req('PUT','/admin-api/users/'+sourceUser.id,{credits:123})).statusCode,200,'source can edit own user');
  eq((await req('POST','/admin-api/agents/'+a.id+'/credits',{delta:25})).statusCode,200,'source can recharge merchant cost balance');
  const imp=(await req('POST','/admin-api/agents/'+a.id+'/impersonate',{})).json();eq(agents.agentSessionReadOnly(imp.token),false,'portal entry creates normal merchant session');
  const portal=(method,url,payload)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+imp.token}});
  eq((await portal('GET','/agent-api/me')).json().readOnly,false,'portal is editable');
  eq((await portal('GET','/agent-api/me')).json().id,a.id,'portal identity is selected merchant');
  eq((await portal('GET','/agent-api/users')).json().items.map(u=>u.id),[au.id],'portal only lists own users');
  const personalBefore=users.getUser(au.id).credits,costBefore=agents.getAgent(a.id).credits;
  eq((await portal('POST','/agent-api/users/'+au.id+'/credits',{delta:7})).statusCode,200,'portal may adjust own user credits');
  eq(users.getUser(au.id).credits,personalBefore+7,'portal credit edit persisted');
  eq(agents.getAgent(a.id).credits,costBefore,'issuing user credits does not debit merchant');
  for(const u of [sourceUser,bu])eq((await portal('POST','/agent-api/users/'+u.id+'/credits',{delta:7})).statusCode,404,'portal cannot edit another realm');
  eq((await req('PUT','/admin-api/users/'+au.id,{credits:999})).statusCode,403,'source user editing still read only after portal entry');
  eq((await portal('POST','/agent-api/users/'+au.id+'/credits',{delta:-7})).statusCode,200,'portal may reclaim its own user credits');
  eq((await app.inject({method:'POST',url:'/admin-api/agents/'+a.id+'/impersonate',payload:{}})).statusCode,401,'anonymous cannot mint portal session');
  eq((await portal('POST','/admin-api/agents/'+b.id+'/impersonate',{})).statusCode,401,'merchant session cannot impersonate other merchants');
  agents.updateAgent(b.id,{enabled:false});eq((await req('POST','/admin-api/agents/'+b.id+'/impersonate',{})).statusCode,400,'disabled merchant portal rejected');agents.updateAgent(b.id,{enabled:true});
  eq((await req('POST','/admin-api/agents/missing/impersonate',{})).statusCode,404,'missing merchant portal rejected');
  for(const patch of [{issuer:'agent'},{kind:'system'},{audience:'user',audienceId:au.id},{audience:'agent',audienceId:'missing'}]){
    eq((await req('POST','/admin-api/messages',{kind:'announcement',audience:'all',title:'测试',body:'独立沙盒',...patch})).statusCode,400,'message issuer and recipients validated');
  }
  eq((await req('POST','/admin-api/messages',{kind:'announcement',audience:'agent',audienceId:a.id,title:'沙盒渠道公告',body:'只发测试租户甲'})).statusCode,200,'source may target merchant users');
  eq((await req('POST','/admin-api/messages',{kind:'notice',audience:'source',title:'源站公告',body:'只发源站'})).statusCode,200,'source may target its users');
  const messages=await import('../src/store/messages.ts');
  eq(messages.listMessagesForUser(au).items.map(m=>m.title),['沙盒渠道公告'],'merchant sees targeted source notice');
  eq(messages.listMessagesForUser(bu).items,[],'other merchant not included');
  eq(messages.listMessagesForUser(sourceUser).items.map(m=>m.title),['源站公告'],'source notice scope');
  eq((await req('GET','/admin-api/messages')).json().items.length,2,'admin published list');
  const presets=await import('../src/store/presets.ts'),templates=await import('../src/store/templates.ts');
  presets.createPreset({id:'agent-private-preset',name:'渠道私有预设',agentId:a.id,category:'预设方案',body:'private'});
  templates.createTemplate({id:'agent-private-template',name:'渠道模板',capability:'text',agentId:a.id,body:'private'});
  eq((await req('POST','/admin-api/presets',{id:' agent-private-preset ',name:'覆盖'})).statusCode,404,'upsert cannot overwrite merchant preset with padded id');
  eq((await req('PUT','/admin-api/presets/agent-private-preset',{body:'覆盖'})).statusCode,404,'source cannot modify private preset');
  eq((await req('DELETE','/admin-api/presets/agent-private-preset')).statusCode,404,'source cannot delete private preset');
  eq((await req('POST','/admin-api/templates',{id:' agent-private-template ',name:'覆盖',capability:'text'})).statusCode,403,'source cannot overwrite private template');
  const favorites=await import('../src/store/favorites.ts');favorites.grantQuota('user',au.id,1024,30,legacyCard.code);const grantedBefore=favorites.grantedBytes('user',au.id);
  assert.throws(()=>storage.createStorageCodes(1,'user',{bytes:1024,days:30}),/取消/);checks++;
  eq(storage.useStorageCode(legacyCard.code,{type:'user',id:au.id}).ok,false,'storage redemption canceled');
  eq(storage.listStorageCodes(),[legacyCard],'legacy storage history preserved');
  eq(favorites.grantedBytes('user',au.id),grantedBefore,'existing storage grants remain active');
  eq((await req('POST','/admin-api/storage-codes',{count:1})).statusCode,410,'admin storage issue removed');
  eq((await req('PUT','/admin-api/quota/defaults',{storageCodeUser:{bytes:999},favQuotaBytes:999})).statusCode,410,'old storage configuration rejected atomically');
  const html=fs.readFileSync('src/admin/index.html','utf8');for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)){new vm.Script(m[1]);checks++}
  eq(html.includes('id="q_scu_b"'),false,'storage card config removed');eq(html.includes('genStorageCodes()'),false,'storage issuance UI removed');
  eq((await req('GET','/admin')).body.includes("field('rg_sourceinvite'"),true,'served settings module renders source invite field');
  console.log('Tenant boundary checks:',checks);
}finally{await app.close()}
