import assert from 'node:assert/strict';import fs from 'node:fs';
if(!process.cwd().includes('qiji-team-wallets-'))throw Error('Sandbox only');globalThis.fetch=async()=>{throw Error('No network')};
const users=await import('../src/store/users.ts'),teams=await import('../src/store/teams.ts'),agents=await import('../src/store/agents.ts');
const credits=await import('../src/store/credits.ts'),{db}=await import('../src/store/sqlite.ts');
if(process.argv[2]==='prepare'){
 const owner=users.createUser({name:'pending legacy owner',credits:1000}),agent=agents.createAgent({name:'pending agent',account:'pending-agent',password:'fixture-pass',credits:100}).agent;
 const member=users.createUser({name:'pending member',credits:80,agentId:agent.id});
 const team=teams.createTeam({name:'pending legacy team',leaderId:owner.id,code:teams.createTeamCodes(1)[0].code}).team;
 teams.inviteToTeam(team.id,member.id);teams.acceptInvite(team.id,member.id);teams.bumpGranted(team.id,member.id,50);
 const accounts=[{kind:'user',id:member.id,delta:-10,pre:80,post:70},{kind:'agent',id:agent.id,delta:-5,pre:100,post:95}];
 db.prepare("INSERT INTO credit_ops(op_id,created_at,reason,ref,payer_id,stats_user_id,accounts,status)VALUES(?,?,?,?,?,?,?,'pending')").run('legacy-wallet-torn',Date.now(),'generate','legacy-torn',member.id,member.id,JSON.stringify(accounts));
 agents.applyAgentCreditsDelta(agent.id,-5);agents.persistAgents();
 fs.writeFileSync('data/team-wallet-pending-proof.json',JSON.stringify({ownerId:owner.id,memberId:member.id,agentId:agent.id,teamId:team.id}));
 console.log('Legacy pending fixture saved: user pre80, agent post95, legacy grant50');
}else{
 const p=JSON.parse(fs.readFileSync('data/team-wallet-pending-proof.json','utf8'));
 credits.selfHealCredits();
 teams.migrateTeamWallets();
 const actual={personal:users.getUser(p.memberId).credits,team:teams.grantedOf(p.teamId,p.memberId),agent:agents.getAgent(p.agentId).credits};
 console.log('Legacy pending upgraded balances:',JSON.stringify(actual));
 assert.equal(actual.personal+actual.team,70,'old pending debit must settle before splitting legacy team wallet');assert.equal(actual.agent,95);
}
(await import('../src/store/db.ts')).flushPendingSaves();(await import('../src/store/sqlite.ts')).closeSqlite();
