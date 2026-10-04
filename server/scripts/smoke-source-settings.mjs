import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
if(!process.cwd().includes('qiji-source-settings-'))throw Error('Sandbox only');
globalThis.fetch=async()=>{throw Error('Sandbox blocks external network');};
const {default:nodemailer}=await import('nodemailer');let sent=0,transport;
nodemailer.createTransport=options=>{transport=options;return {sendMail:async()=>{sent++;return {};},close:()=>{}};};
const {default:Fastify}=await import('fastify'),app=Fastify();
const agents=await import('../src/store/agents.ts'),users=await import('../src/store/users.ts'),codes=await import('../src/store/redeemCodes.ts'),settings=await import('../src/store/settings.ts');
await app.register((await import('../src/routes.ts')).registerRoutes);
await app.register((await import('../src/routes/admin.ts')).registerAdminRoutes);
await app.register((await import('../src/routes/agent.ts')).registerAgentRoutes);await app.ready();
let checks=0;const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const headers={authorization:'Bearer admin-dev'};
const api=(method,url,payload,custom=headers)=>app.inject({method,url,headers:custom,...(payload===undefined?{}:{payload})});
const good=async(method,url,payload,custom=headers)=>{const r=await api(method,url,payload,custom);eq(r.statusCode,200,method+' '+url);return r.json();};
const get=()=>good('GET','/admin-api/settings/register');
const save=payload=>good('PUT','/admin-api/settings/register',payload);
const a=agents.createAgent({name:'独立渠道',account:'settings-merchant',password:'fixture-pass',credits:100}).agent;
agents.updateAgentPortalSettings(a.id,{redeemCodePrefix:'MERCHANT'});
const merchantHeaders={authorization:'Bearer '+agents.createAgentSession(a.id)};
const own=users.createUser({name:'源站测试用户',credits:0}),foreign=users.createUser({name:'商测试用户',agentId:a.id,credits:0});
const beforeDisk=()=>fs.readFileSync('data/settings.json','utf8');
try{
 eq((await api('GET','/admin-api/settings/register',undefined,{})).statusCode,401,'settings requires admin');
 eq((await api('PUT','/admin-api/settings/register',{sourceRedeemCodePrefix:'FORGED'},merchantHeaders)).statusCode,401,'merchant session cannot change source settings');
 const initial=await get();eq(initial.sourceRedeemCodePrefix,'QJ','default prefix');eq(initial.smtp.hasPass,false,'empty secret status');
 const old=(await good('POST','/admin-api/redeem-codes',{count:1,credits:11})).items[0];eq(old.code.startsWith('QJ-'),true,'default source issue uses QJ');
 // settings.json is shared with retention; later saves must preserve other modules' fields.
 fs.writeFileSync('data/settings.json',JSON.stringify({...JSON.parse(beforeDisk()),retentionDays:{ref:30},fixtureUnrelated:{keep:true}}));
 const smtpSecret='fixture-mail-secret-NEVER-RETURN',smsSecret='fixture-sms-secret-NEVER-RETURN';
 const saved=await save({sourceInviteCode:' source_launch ',sourceRedeemCodePrefix:' src9 ',enabled:true,giftCredits:125,ipRegPerDay:12,ipSendPerHour:20,ipSendPerDay:60,deviceLimit:3,emailDomainBlacklist:[' Example.INVALID ','example.invalid'],smtp:{host:'smtp.fixture.invalid',port:587,secure:false,user:'fixture-user',pass:smtpSecret,from:'Fixture <noreply@fixture.invalid>'},sms:{provider:'aliyun',accessKeyId:'fixture-access-id',accessKeySecret:smsSecret,signName:'Fixture',templateCode:'SMS_fixture'}});
 eq(saved.sourceRedeemCodePrefix,'SRC9','save returns normalized prefix');eq(saved.sourceInviteCode,'SOURCE_LAUNCH','save returns normalized invite');
 const current=await get();eq(current.sourceRedeemCodePrefix,'SRC9','read persisted prefix');eq(current.smtp.port,587,'numeric SMTP port');eq(current.smtp.secure,false,'false secure preserved');eq(current.giftCredits,125,'gift amount');eq(current.deviceLimit,3,'device amount');eq(current.emailDomainBlacklist,['example.invalid'],'blacklist normalized');
 eq(JSON.stringify(current).includes(smtpSecret)||JSON.stringify(current).includes(smsSecret),false,'GET never leaks channel secrets');eq(JSON.stringify(saved).includes(smtpSecret)||JSON.stringify(saved).includes(smsSecret),false,'PUT never echoes channel secrets');
 eq(current.smtp.hasPass,true,'smtp configured marker');eq(current.sms.hasSecret,true,'sms configured marker');eq(sent,0,'saving configuration sends no mail');
 const fresh=(await good('POST','/admin-api/redeem-codes',{count:2,credits:17,prefix:'IGNORED'})).items;
 eq(fresh.every(x=>x.code.startsWith('SRC9-')&&!x.agentId),true,'new source codes use configured prefix and source issuer');
 eq(codes.getCode(old.code).code,old.code,'existing code is not renamed');
 eq((await api('POST','/v1/redeem',{code:old.code},{authorization:'Bearer '+foreign.accessKey})).statusCode,400,'old source code remains unavailable to merchant customer');
 await good('POST','/v1/redeem',{code:old.code},{authorization:'Bearer '+own.accessKey});eq(users.getUser(own.id).credits,11,'old code still credits source customer');
 await good('POST','/v1/redeem',{code:fresh[0].code},{authorization:'Bearer '+own.accessKey});eq(users.getUser(own.id).credits,28,'new code works without client prefix dependency');
 const merchant=(await good('POST','/agent-api/redeem-codes',{credits:8},merchantHeaders)).items[0];eq(merchant.code.startsWith('MERCHANT-'),true,'merchant prefix unaffected');eq(merchant.agentId,a.id,'merchant issuer unaffected');
 const invalids=[
  {sourceRedeemCodePrefix:'MC'},{sourceRedeemCodePrefix:'sc'},{sourceRedeemCodePrefix:'TC'},{sourceRedeemCodePrefix:'A'},{sourceRedeemCodePrefix:'A-B'},{sourceRedeemCodePrefix:'ABCDEFGHIJKLM'},
  {sourceInviteCode:'bad'},{enabled:'false'},{enabled:0},{giftCredits:-1},{giftCredits:1.5},{giftCredits:1000001},{giftCredits:'100'},
  {ipRegPerDay:0},{ipSendPerHour:-2},{ipSendPerDay:10001},{deviceLimit:101},{deviceLimit:'3'},
  {smtp:{secure:'false'}},{smtp:{secure:0}},{smtp:{port:0}},{smtp:{port:65536}},{smtp:{port:'587'}},{smtp:{port:587.5}},{smtp:[]},{smtp:null},
  {smtp:{host:3}},{smtp:{pass:12}},{smtp:{from:'fake\r\nBcc: other@invalid'}},{smtp:{hasPass:true}},
  {sms:{provider:'unknown'}},{sms:{accessKeySecret:12}},{sms:[]},{emailDomainBlacklist:'bad.invalid'},{emailDomainBlacklist:['bad domain']},{unknownSetting:true}
 ];
 const stable=beforeDisk(),stableView=await get();
 for(const patch of invalids){
  const response=await api('PUT','/admin-api/settings/register',{sourceInviteCode:'SHOULD_NOT_SAVE',sourceRedeemCodePrefix:'NOSAVE',giftCredits:999,...patch});
  eq(response.statusCode,400,'invalid settings rejected '+Object.keys(patch)[0]);eq(beforeDisk(),stable,'invalid request does not partially persist');
 }
 eq(await get(),stableView,'invalid requests leave in-memory settings unchanged');
 const conflict=await api('PUT','/admin-api/settings/register',{sourceInviteCode:a.inviteCode,sourceRedeemCodePrefix:'NOSAVE',giftCredits:999});eq(conflict.statusCode,409,'merchant invite conflict rejected');eq(beforeDisk(),stable,'conflict leaves all fields unchanged');
 const userInvite=users.ensureUserInviteCode(own);eq((await api('PUT','/admin-api/settings/register',{sourceInviteCode:userInvite,sourceRedeemCodePrefix:'NOSAVE'})).statusCode,409,'user invite conflict rejected');eq(beforeDisk(),stable,'user conflict no partial write');
 await save({smtp:{pass:''},sms:{accessKeySecret:''}});eq(settings.getRegisterSettings().smtp.pass,smtpSecret,'empty smtp secret keeps previous');eq(settings.getRegisterSettings().sms.accessKeySecret,smsSecret,'empty sms secret keeps previous');
 await good('POST','/admin-api/settings/register/test-mail',{to:'qa@fixture.invalid'});eq(sent,1,'mail self-test uses stub');eq(transport.secure,false,'587 uses STARTTLS with configured secure false');eq(transport.auth.pass,smtpSecret,'mailer receives preserved credential internally');
 await save({smtp:{pass:null},sms:{accessKeySecret:null}});const cleared=await get();eq(cleared.smtp.hasPass,false,'explicit null clears smtp secret');eq(cleared.sms.hasSecret,false,'explicit null clears sms secret');
 await save({smtp:{pass:smtpSecret},sms:{accessKeySecret:smsSecret},deviceLimit:0});eq((await get()).deviceLimit,0,'zero devices means unlimited');
 await save({deviceLimit:null});eq((await get()).deviceLimit,1,'null devices restores default');
 await save({deviceLimit:'',smtp:{secure:true,port:465}});eq((await get()).deviceLimit,1,'legacy empty devices restores default');
 await save({deviceLimit:3});
 const persisted=JSON.parse(beforeDisk());eq(persisted.retentionDays,{ref:30},'other modules retention settings preserved');eq(persisted.fixtureUnrelated,{keep:true},'unowned settings preserved');
 const prefixBefore=beforeDisk();
 const restarted=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
  globalThis.fetch=async()=>{throw Error('No network');};
  const {default:Fastify}=await import('fastify'),app=Fastify();
  await app.register((await import('./src/routes/admin.ts')).registerAdminRoutes);await app.ready();
  const headers={authorization:'Bearer admin-dev'};
  const settings=(await app.inject({method:'GET',url:'/admin-api/settings/register',headers})).json();
  const made=(await app.inject({method:'POST',url:'/admin-api/redeem-codes',headers,payload:{credits:1}})).json();
  console.log(JSON.stringify({settings,code:made.items[0].code}));await app.close();
  (await import('./src/channelAvailability.ts')).stopChannelAvailabilityBackground();
  (await import('./src/lineAvailability.ts')).stopLineAvailabilityBackground();
  (await import('./src/store/sqlite.ts')).closeSqlite();
 `],{encoding:'utf8',cwd:process.cwd()});
 const restart=JSON.parse(restarted.trim());eq(restart.settings.sourceRedeemCodePrefix,'SRC9','prefix survives process restart');eq(restart.settings.sourceInviteCode,'SOURCE_LAUNCH','invite survives restart');eq(restart.settings.smtp.hasPass,true,'SMTP secret persists but remains masked');eq(restart.settings.smtp.secure,true,'secure survives restart');eq(restart.settings.smtp.port,465,'port survives restart');eq(restart.code.startsWith('SRC9-'),true,'new process issues configured prefix');eq(beforeDisk(),prefixBefore,'restart does not rewrite settings');eq(restarted.includes(smtpSecret)||restarted.includes(smsSecret),false,'restarted HTTP does not leak secrets');
 const catalog=await good('GET','/v1/catalog',undefined,{authorization:'Bearer '+own.accessKey});eq(JSON.stringify(catalog).includes(smtpSecret)||JSON.stringify(catalog).includes(smsSecret),false,'client catalog contains no settings secrets');
 console.log(`Source settings: ${checks} checks passed; isolated HTTP, restart, stub email only; no real data or network.`);
}finally{
 await app.close();
 (await import('../src/channelAvailability.ts')).stopChannelAvailabilityBackground();
 (await import('../src/lineAvailability.ts')).stopLineAvailabilityBackground();
 (await import('../src/store/sqlite.ts')).closeSqlite();
}
