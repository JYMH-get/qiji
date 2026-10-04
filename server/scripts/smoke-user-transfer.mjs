import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
if(!process.cwd().includes('qiji-user-transfer-'))throw Error('Sandbox only');
globalThis.fetch=async()=>{throw Error('Sandbox blocks all external network');};
const {default:Fastify}=await import('fastify'),app=Fastify();
const agents=await import('../src/store/agents.ts'),users=await import('../src/store/users.ts'),teams=await import('../src/store/teams.ts');
const logs=await import('../src/store/logs.ts'),tasks=await import('../src/store/tasks.ts'),favorites=await import('../src/store/favorites.ts');
const {db}=await import('../src/store/sqlite.ts');
await app.register((await import('../src/routes.ts')).registerRoutes);
await app.register((await import('../src/routes/admin.ts')).registerAdminRoutes);
await app.register((await import('../src/routes/agent.ts')).registerAgentRoutes);await app.ready();
let checks=0;const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const headers={authorization:'Bearer admin-dev'};
const api=(method,url,payload,custom=headers)=>app.inject({method,url,headers:custom,...(payload===undefined?{}:{payload})});
const good=async(method,url,payload,custom=headers)=>{const r=await api(method,url,payload,custom);eq(r.statusCode,200,method+' '+url+': '+r.body.slice(0,150));return r.json();};
const preview=(ids,targetAgentId)=>good('POST','/admin-api/users/transfer/preview',{ids,targetAgentId});
const migrate=async(ids,targetAgentId)=>{const p=await preview(ids,targetAgentId);return {request:{ids,targetAgentId,token:p.token},result:await good('POST','/admin-api/users/transfer',{ids,targetAgentId,token:p.token})};};
const snapshot=()=>fs.readFileSync('data/users.json','utf8');
try{
 if(process.argv[2]==='restart'){
  const state=JSON.parse(fs.readFileSync('data/transfer-test-state.json','utf8'));
  const u=users.getUser(state.userId),member=users.getUser(state.memberId);
  eq(u.agentId,undefined,'restart ownership is source');eq(u.credits,0,'restart does not revive old money');
  eq(u.membership,undefined,'restart does not revive old membership');eq(u.transferHistory.length,2,'both migrations survive restart');
  eq(u.transferHistory.map(x=>x.personalCredits),state.archived,'archived money survives');
  eq(member.teamWallets[state.teamId].balance,0,'member allocation reset survives restart');
  eq(member.teamWallets[state.teamId].ownerAgentId,undefined,'wallet source ownership survives restart');
  const before=snapshot();
  const retry=await good('POST','/admin-api/users/transfer',state.replay);
  eq(retry.replayed,true,'cross-restart token replay');eq(retry.transferId,state.transferId,'same durable transfer id');eq(snapshot(),before,'replay changes no bytes');
  eq((await api('GET','/v1/me',undefined,{authorization:'Bearer '+state.oldKey})).statusCode,401,'old key remains revoked after restart');
  const history=await good('GET','/admin-api/users/transfer-history?userId='+u.id);
  eq(history.items.length,2,'public history survives restart');eq(JSON.stringify(history).includes(state.replay.token),false,'history never exposes token');
  console.log('User transfer restart:',checks,'checks passed');
 }else{
  const a=agents.createAgent({name:'迁移渠道甲',account:'transfer-agent-a',password:'fixture-pass',credits:900}).agent;
  const b=agents.createAgent({name:'迁移渠道乙',account:'transfer-agent-b',password:'fixture-pass',credits:800}).agent;
  const ah={authorization:'Bearer '+agents.createAgentSession(a.id)},bh={authorization:'Bearer '+agents.createAgentSession(b.id)};
  const s=users.createUser({name:'源站团长',credits:1000,note:'keep me'}),member=users.createUser({name:'跨商团员',agentId:b.id,credits:333});
  const closedMember=users.createUser({name:'已退团员',credits:222}),external=users.createUser({name:'其他团长',agentId:b.id,credits:500});
  users.bindAccount(s,'transfer-source','fixture-pass');users.updateUser(s.id,{devices:[{id:'old-device',at:new Date().toISOString()}],favQuotaBytes:123456,totalSpent:12,dailySpent:3});
  users.applyMembershipGrant(s.id,{planName:'旧源站会员',days:30,discountPercent:80});
  favorites.grantQuota('user',s.id,55555,30,'legacy-quota');
  const code=teams.createTeamCodes(1)[0],team=teams.createTeam({code:code.code,name:'跨租户团队',leaderId:s.id}).team;
  teams.inviteToTeam(team.id,member.id);teams.acceptInvite(team.id,member.id);teams.updateTeam(team.id,{creditMode:'dispatch'});
  eq(teams.allocateTeamCredits(team.id,member.id,100).ok,true,'seed independent team balance');
  users.initializeTeamWallet(closedMember.id,'closed-team',s.id);users.updateUser(closedMember.id,{teamWallets:{'closed-team':{teamId:'closed-team',ownerId:s.id,balance:0,closed:true}}});
  users.initializeTeamWallet(s.id,'external-team',external.id);eq(users.transferTeamCredits(external.id,s.id,'external-team',40).ok,true,'unrelated leader wallet seeded');
  const sKey=s.accessKey,teamBefore=JSON.stringify(teams.getTeam(team.id)),keep={id:s.id,account:s.account,passwordHash:s.passwordHash,passwordSalt:s.passwordSalt,note:s.note,createdAt:s.createdAt,favQuotaBytes:s.favQuotaBytes,totalSpent:s.totalSpent,dailySpent:s.dailySpent};
  const originalMembership=structuredClone(s.membership),originalCredits=s.credits;
  for(const credential of [{},ah,bh,{authorization:'Bearer '+sKey}]){
   eq((await api('POST','/admin-api/users/transfer/preview',{ids:[s.id],targetAgentId:a.id},credential)).statusCode,401,'source admin only preview');
   eq((await api('GET','/admin-api/users/transfer-history',undefined,credential)).statusCode,401,'source admin only history');
  }
  for(const payload of [{ids:[],targetAgentId:a.id},{ids:[s.id,s.id],targetAgentId:a.id},{ids:[s.id],targetAgentId:a.id,credits:1},{ids:[s.id]},null,{ids:[''],targetAgentId:a.id},{ids:Array(501).fill(s.id),targetAgentId:a.id}])eq((await api('POST','/admin-api/users/transfer/preview',payload)).statusCode,400,'strict input');
  eq((await api('POST','/admin-api/users/transfer',{ids:[s.id],targetAgentId:a.id})).statusCode,400,'confirmation required');
  eq((await api('POST','/admin-api/users/transfer/preview',{ids:[s.id],targetAgentId:'missing'})).statusCode,404,'missing target');
  eq((await api('POST','/admin-api/users/transfer/preview',{ids:[s.id,'missing'],targetAgentId:a.id})).statusCode,404,'missing user batch rejected');
  eq((await api('POST','/admin-api/users/transfer/preview',{ids:[s.id],targetAgentId:null})).statusCode,409,'same tenant rejected');
  eq((await api('POST','/admin-api/users/transfer/preview',{ids:[member.id],targetAgentId:a.id})).statusCode,409,'merchant to merchant rejected');
  agents.updateAgent(a.id,{enabled:false});eq((await api('POST','/admin-api/users/transfer/preview',{ids:[s.id],targetAgentId:a.id})).statusCode,409,'disabled target rejected');agents.updateAgent(a.id,{enabled:true});
  users.updateUser(s.id,{credits:-1});eq((await api('POST','/admin-api/users/transfer/preview',{ids:[s.id],targetAgentId:a.id})).statusCode,409,'personal debt blocked');users.updateUser(s.id,{credits:originalCredits});
  users.userTeamWallet(member.id,team.id).balance=-1;users.persistUsers();eq((await api('POST','/admin-api/users/transfer/preview',{ids:[s.id],targetAgentId:a.id})).statusCode,409,'team debt blocked');users.userTeamWallet(member.id,team.id).balance=100;users.persistUsers();
  // Running logs cover the requester, personal payer, and allocation owner.
  for(const fields of [{userId:s.id},{userId:member.id,payerId:s.id},{userId:member.id,userWallet:{teamId:team.id,ownerId:s.id}}]){
   const p=await preview([s.id],a.id),l=logs.startLog({req:{model:'fixture',capability:'image',params:{}},...fields});
   eq((await api('POST','/admin-api/users/transfer',{ids:[s.id],targetAgentId:a.id,token:p.token})).statusCode,409,'new request after preview blocks');
   logs.finishLog(l.id,{status:'failed',error:'sandbox completed'});
  }
  for(const fields of [{ownerUserId:s.id},{billing:{userId:member.id,payerId:s.id,cost:0,refunded:false}},{billing:{userId:member.id,userWallet:{teamId:team.id,ownerId:s.id},cost:0,refunded:false}}]){
   const task=tasks.createTask({capability:'image',awaitingReal:true,...fields});
   eq((await api('POST','/admin-api/users/transfer/preview',{ids:[s.id],targetAgentId:a.id})).statusCode,409,'pending task identity blocked');tasks.completeTask(task.taskId,{});
  }
  const insertPending=(payer,stats,accounts)=>db.prepare("INSERT INTO credit_ops(op_id,created_at,reason,payer_id,stats_user_id,accounts,status) VALUES('fixture-pending',?,'fixture',?,?,?,'pending')").run(Date.now(),payer,stats,JSON.stringify(accounts));
  for(const [payer,stats,accounts] of [[s.id,member.id,[]],[member.id,s.id,[]],[member.id,member.id,[{kind:'team',id:member.id,wallet:{ownerId:s.id}}]]]){
   insertPending(payer,stats,accounts);eq((await api('POST','/admin-api/users/transfer/preview',{ids:[s.id],targetAgentId:a.id})).statusCode,409,'pending ledger blocked');db.prepare("DELETE FROM credit_ops WHERE op_id='fixture-pending'").run();
  }
  for(const charged of [{payerId:s.id},{statsUserId:s.id},{payerId:member.id,userWallet:{ownerId:s.id}}]){
   db.prepare('INSERT INTO text_billing(log_id,data) VALUES(?,?)').run('pending-text',JSON.stringify({charged,result:{},finalized:false}));eq((await api('POST','/admin-api/users/transfer/preview',{ids:[s.id],targetAgentId:a.id})).statusCode,409,'pending text result blocked');db.prepare("DELETE FROM text_billing WHERE log_id='pending-text'").run();
  }
  db.prepare('INSERT INTO text_billing(log_id,data) VALUES(?,?)').run('failed-prepare',JSON.stringify({charged:{payerId:s.id},snapshot:{at:Date.now()}}));
  const prep=await preview([s.id],a.id);eq(prep.totalCredits,originalCredits,'preview original personal sum');eq(prep.totalTeamCredits,100,'preview includes owned wallet sum');eq(prep.users[0].teamWalletCount,2,'closed owned wallet included');eq(prep.users[0].membership.planName,originalMembership.planName,'membership archive disclosed');
  eq(JSON.stringify(prep).includes(sKey),false,'preview hides current key');
  users.grantCredits(s.id,1);eq((await api('POST','/admin-api/users/transfer',{ids:[s.id],targetAgentId:a.id,token:prep.token})).statusCode,409,'stale balance refused');users.updateUser(s.id,{credits:originalCredits});
  const staleWallet=await preview([s.id],a.id);users.userTeamWallet(member.id,team.id).balance=99;users.persistUsers();eq((await api('POST','/admin-api/users/transfer',{ids:[s.id],targetAgentId:a.id,token:staleWallet.token})).statusCode,409,'stale wallet refused');users.userTeamWallet(member.id,team.id).balance=100;users.persistUsers();
  const staleMember=await preview([s.id],a.id);users.updateUser(s.id,{membership:{...s.membership,discountPercent:70}});eq((await api('POST','/admin-api/users/transfer',{ids:[s.id],targetAgentId:a.id,token:staleMember.token})).statusCode,409,'stale membership refused');users.updateUser(s.id,{membership:originalMembership});
  const staleTopology=await preview([s.id],a.id);teams.updateTeam(team.id,{creditMode:'shared'});eq((await api('POST','/admin-api/users/transfer',{ids:[s.id],targetAgentId:a.id,token:staleTopology.token})).statusCode,409,'team payment topology change requires fresh preview');teams.updateTeam(team.id,{creditMode:'dispatch'});
  const expiredPreview=await preview([s.id],a.id),realNow=Date.now;Date.now=()=>realNow()+11*60_000;
  try{eq((await api('POST','/admin-api/users/transfer',{ids:[s.id],targetAgentId:a.id,token:expiredPreview.token})).statusCode,409,'expired confirmation refuses write');}finally{Date.now=realNow;}
  const beforeTeamCommit=JSON.stringify(teams.getTeam(team.id));
  const p=await preview([s.id],a.id),commit={ids:[s.id],targetAgentId:a.id,token:p.token};
  eq((await api('POST','/admin-api/users/transfer',{...commit,targetAgentId:b.id})).statusCode,409,'token bound to target');
  const before=snapshot(),memory=JSON.stringify(users.listUsers()),rename=fs.renameSync;
  fs.renameSync=(from,to)=>{if(String(to).endsWith('users.json'))throw Error('fixture atomic write failure');return rename(from,to);};syncBuiltinESMExports();
  try{eq((await api('POST','/admin-api/users/transfer',commit)).statusCode,500,'storage failure surfaced');}finally{fs.renameSync=rename;syncBuiltinESMExports();}
  eq(snapshot(),before,'write failure leaves durable data exact');eq(JSON.stringify(users.listUsers()),memory,'write failure leaves all memory exact');
  const moved=await good('POST','/admin-api/users/transfer',commit);eq(moved.affected,1,'one owner moved');eq(moved.replayed,false,'first commit');eq(s.agentId,a.id,'ownership changed');eq(s.credits,0,'new personal currency starts zero');eq(s.membership,undefined,'membership archived out of active state');eq(s.devices,[],'devices revoked');eq(s.accessKey===sKey,false,'key rotated');
  eq(Object.fromEntries(Object.keys(keep).map(k=>[k,s[k]])),keep,'identity account password stats quota note unchanged');eq(JSON.stringify(teams.getTeam(team.id)),beforeTeamCommit,'teams membership and policy unchanged');eq(favorites.grantedBytes('user',s.id),55555,'quota grant preserved');
  eq(s.transferHistory[0].personalCredits,originalCredits,'old personal amount archived');eq(s.transferHistory[0].membership,originalMembership,'old membership archived intact');eq(s.transferHistory[0].ownedTeamWallets.reduce((n,w)=>n+w.balance,0),100,'team sum archived');
  eq([member.credits,users.userTeamWallet(member.id,team.id).balance,users.userTeamWallet(member.id,team.id).ownerAgentId],[333,0,a.id],'member personal unchanged while owner currency reset');eq([users.userTeamWallet(closedMember.id,'closed-team').closed,users.userTeamWallet(closedMember.id,'closed-team').ownerAgentId],[true,a.id],'closed wallet ownership updated');eq(users.userTeamWallet(s.id,'external-team').balance,40,'unrelated leader wallet untouched');
  eq((await api('GET','/v1/me',undefined,{authorization:'Bearer '+sKey})).statusCode,401,'old key cannot access client APIs');
  eq(users.verifyUserPassword(s,'fixture-pass'),true,'original account password still authenticates');
  const relogin=await good('POST','/v1/login',{account:s.account,password:'fixture-pass',deviceId:'new-device'},{});eq(relogin.accessKey,s.accessKey,'real account login obtains rotated key');
  const sourceView=(await good('GET','/admin-api/users?agentId='+a.id)).items.find(u=>u.id===s.id),agentView=(await good('GET','/agent-api/users',undefined,ah)).items.find(u=>u.id===s.id);
  eq(sourceView.transferHistory,undefined,'generic source view hides archive');eq(sourceView.accessKey,undefined,'source cannot see merchant user key');eq(agentView.transferHistory,undefined,'merchant view hides archives');eq(agentView.accessKey,s.accessKey,'new merchant gets new key');
  const history=await good('GET','/admin-api/users/transfer-history?userId='+s.id);eq(history.items.length,1,'one source audit row');eq(history.items[0].personalCredits,originalCredits,'history exact archived amount');eq(JSON.stringify(history).includes(p.token),false,'history no confirmation secret');
  const after=snapshot();eq((await good('POST','/admin-api/users/transfer',commit)).replayed,true,'same token idempotent');eq(snapshot(),after,'replay no disk changes');
  // Rejoining an old closed wallet can receive the new leader currency.
  users.grantCredits(s.id,50);eq(users.transferTeamCredits(s.id,closedMember.id,'closed-team',10).ok,true,'closed wallet reusable after migration');eq(users.userTeamWallet(closedMember.id,'closed-team').balance,10,'rejoined allocation receives new currency');
  const merchantKey=s.accessKey,back=await migrate([s.id],null);eq(s.credits,0,'return source still starts zero');eq(s.transferHistory.map(h=>h.personalCredits),[originalCredits,40],'return archives new merchant credits not restores source');eq(s.membership,undefined,'return does not auto-restore original membership');eq(users.userTeamWallet(closedMember.id,'closed-team').balance,0,'return archives new team currency');
  eq((await api('GET','/v1/me',undefined,{authorization:'Bearer '+merchantKey})).statusCode,401,'merchant-copied key revoked on return');
  eq((await good('GET','/agent-api/users',undefined,ah)).items.some(u=>u.id===s.id),false,'former merchant loses user visibility');
  for(const payload of [{agentId:a.id},{transferHistory:[]},{teamWallets:{}},{id:'forged'},{createdAt:'forged'}])eq((await api('PUT','/admin-api/users/'+s.id,payload)).statusCode,400,'ordinary patch cannot bypass archives');
  // A member-only transfer never changes another leader's allocation currency.
  users.grantCredits(s.id,20);teams.allocateTeamCredits(team.id,member.id,15);const walletBefore=structuredClone(users.userTeamWallet(member.id,team.id));
  await migrate([member.id],null);eq(users.userTeamWallet(member.id,team.id),walletBefore,'member transfer keeps external leader wallet');eq(member.credits,0,'member personal currency sealed');
  // Whole batches include all selected users or none; mixed source/merchant ownership rejects.
  const x=users.createUser({name:'batch x',credits:5}),y=users.createUser({name:'batch y',credits:6});
  eq((await api('POST','/admin-api/users/transfer/preview',{ids:[x.id,external.id],targetAgentId:a.id})).statusCode,409,'mixed source and merchant target rejected');
  const batch=await migrate([y.id,x.id],a.id);eq(batch.result.affected,2,'whole batch count');eq([x.credits,y.credits],[0,0],'batch zero both');eq(x.transferHistory[0].transferId,y.transferHistory[0].transferId,'batch shares atomic audit id');
  agents.updateAgent(a.id,{enabled:false});await migrate([x.id,y.id],null);eq([x.agentId,y.agentId],[undefined,undefined],'disabled merchant users recover to source');
  // Preserve zero source balance for restart assertions without changing archived history.
  users.updateUser(s.id,{credits:0});users.userTeamWallet(member.id,team.id).balance=0;users.persistUsers();
  fs.writeFileSync('data/transfer-test-state.json',JSON.stringify({userId:s.id,memberId:member.id,teamId:team.id,archived:[originalCredits,40],replay:back.request,transferId:back.result.transferId,oldKey:sKey}));
  eq([a.credits,b.credits],[900,800],'no merchant cost funds moved by ownership transfer');
  console.log('User transfer API:',checks,'checks passed');
 }
}finally{await app.close();await(await import('../src/store/db.ts')).flushPendingSaves();}
process.exit(0);
