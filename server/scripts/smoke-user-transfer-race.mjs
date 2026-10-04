import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.ok(fs.existsSync(new URL('../.qiji-user-transfer-race-sandbox', import.meta.url)), 'Sandbox only');
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw Error('Race sandbox blocks all network'); };
const { default: Fastify } = await import('fastify');
const users = await import('../src/store/users.ts');
const agents = await import('../src/store/agents.ts');
const teams = await import('../src/store/teams.ts');
const models = await import('../src/store/models.ts');
const tasks = await import('../src/store/tasks.ts');
const logs = await import('../src/store/logs.ts');
const { db, closeSqlite } = await import('../src/store/sqlite.ts');
const { flushPendingSaves } = await import('../src/store/db.ts');
const app = Fastify();
await app.register((await import('../src/routes.ts')).registerRoutes);
await app.register((await import('../src/routes/admin.ts')).registerAdminRoutes);
await app.ready();
const admin = { authorization: 'Bearer admin-dev' };
const req = (method, url, payload, headers = admin) => app.inject({ method, url, payload, headers });
const labels = [];
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); labels.push(label); };
const ok = (value, label) => { assert.ok(value, label); labels.push(label); };
const transfer = async (user, targetAgentId) => {
  const body = { ids: [user.id], targetAgentId };
  const preview = await req('POST', '/admin-api/users/transfer/preview', body);
  eq(preview.statusCode, 200, 'preview permits migration before accepted request');
  const result = await req('POST', '/admin-api/users/transfer', { ...body, token: preview.json().token });
  eq(result.statusCode, 200, 'confirmed migration succeeds during preflight');
};
let gate;
globalThis.__qijiTransferRaceGate = async () => {
  if (!gate) return;
  const current = gate; gate = undefined;
  current.entered();
  await current.wait;
};
const hold = () => {
  let entered, release;
  const atGate = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  gate = { entered, wait };
  return { atGate, release };
};
const deadline = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Preflight gate was not reached')), 10000); })]); }
  finally { clearTimeout(timer); }
};
const balances = () => ({ users: users.listUsers().map(u => ({ id: u.id, credits: u.credits, teamWallets: structuredClone(u.teamWallets) })), agents: agents.listAgents().map(a => ({ id: a.id, credits: a.credits })) });
const opCount = () => db.prepare('SELECT count(*) AS n FROM credit_ops').get().n;
const generation = { model: 'transfer-race-echo', inputs: { prompt: 'isolated preflight race' } };
const a = agents.createAgent({ name: '竞态沙盒渠道', account: 'transfer-race-agent', password: 'fixture-password', credits: 100000 }).agent;
models.createModel({ id: generation.model, label: '迁移竞态内部测试', capability: 'text', protocol: 'echo', hidden: true, enabled: true, cost: 17 });

async function race({ name, actor, migrating = actor, target, aba = false, batch = false, replenish }) {
  const oldKey = actor.accessKey, oldMigratingKey = migrating.accessKey;
  const oldOwner = migrating.agentId;
  const pause = hold();
  const pending = req('POST', batch ? '/v1/batch' : '/v1/generate', batch ? { tasks: [{ ...generation, clientTaskId: name + '-1' }, { ...generation, clientTaskId: name + '-2' }] } : generation,
    { authorization: `Bearer ${oldKey}` }).then(response => response);
  await deadline(pause.atGate);
  eq(logs.getRunningLogs().filter(l => l.userId === actor.id).length, 0, name + ': preflight has no accepted request log');
  try {
    await transfer(migrating, target);
    if (aba) await transfer(migrating, oldOwner ?? null);
    ok(migrating.accessKey !== oldMigratingKey, name + ': migration rotates credentials');
    if (actor !== migrating) eq(actor.accessKey, oldKey, name + ': member credentials stay unchanged');
    if (aba) eq(migrating.agentId, oldOwner, name + ': ownership returns to original domain');
    users.grantCredits(migrating.id, 1000);
    if (replenish) replenish();
    const money = balances(), count = opCount(), logCount = logs.listLogs({ userIds: [actor.id], limit: 500 }).total;
    pause.release();
    const response = await deadline(pending);
    if (batch) {
      eq(response.statusCode, 200, name + ': batch returns rejected task results');
      eq(response.json().taskIds.length, 2, name + ': all batch items accounted for');
      for (const id of response.json().taskIds) {
        const state = tasks.getTaskState(id);
        eq(state.status, 'failed', name + ': stale batch item rejected');
        ok(state.error?.includes('积分来源或账号归属已变更'), name + ': stale batch error requests refresh');
      }
    } else {
      eq(response.statusCode, 409, name + ': stale single request rejected');
      ok(response.json().error?.message?.includes('积分来源或账号归属已变更'), name + ': rejection requests refresh');
    }
    eq(balances(), money, name + ': resumed stale request changes no balances');
    eq(opCount(), count, name + ': no charge or refund operation created');
    eq(logs.listLogs({ userIds: [actor.id], limit: 500 }).total, logCount, name + ': no accepted request log created');
    eq(networkAttempts, 0, name + ': no upstream attempted');
  } finally { pause.release(); await pending; }
}

try {
  const source = users.createUser({ name: 'source-one-way', credits: 300 });
  await race({ name: 'single-source-to-agent', actor: source, target: a.id });
  const single = users.createUser({ name: 'single-ABA', agentId: a.id, credits: 300 });
  await race({ name: 'single-owner-ABA', actor: single, target: null, aba: true });
  const batch = users.createUser({ name: 'batch-ABA', agentId: a.id, credits: 300 });
  await race({ name: 'batch-owner-ABA', actor: batch, target: null, aba: true, batch: true });
  for (const mode of ['shared', 'dispatch']) {
    const leader = users.createUser({ name: mode + '-leader', agentId: a.id, credits: 500 });
    const member = users.createUser({ name: mode + '-member', credits: 50 });
    const made = teams.createTeam({ code: teams.createTeamCodes(1)[0].code, name: 'race-' + mode, leaderId: leader.id });
    ok(made.ok, mode + ': create fixture team');
    teams.inviteToTeam(made.team.id, member.id); teams.acceptInvite(made.team.id, member.id);
    teams.updateTeam(made.team.id, { creditMode: mode });
    if (mode === 'dispatch') ok(teams.allocateTeamCredits(made.team.id, member.id, 100).ok, 'allocation fixture funded');
    await race({ name: 'team-' + mode + '-leader-ABA', actor: member, migrating: leader, target: null, aba: true, batch: mode === 'dispatch',
      replenish: mode === 'dispatch' ? () => ok(teams.allocateTeamCredits(made.team.id, member.id, 200).ok, 'new domain team allocation funded') : undefined });
  }
  // Positive control: an unpaused fresh credential still passes the same route and charges.
  const fresh = users.createUser({ name: 'fresh-positive-control', credits: 100 });
  const freshResponse = await req('POST', '/v1/generate', generation, { authorization: `Bearer ${fresh.accessKey}` });
  eq(freshResponse.statusCode, 200, 'fresh request accepted');
  eq(fresh.credits, 83, 'fresh request charges configured cost through real settle');
  ok(!!freshResponse.json().taskId, 'fresh request reaches actual echo translator');
  eq(networkAttempts, 0, 'entire race suite uses no network');
  fs.writeFileSync('race-verification.json', JSON.stringify({ checks: labels.length, networkAttempts, scenarios: 5, labels }, null, 2));
  console.log(`USER_TRANSFER_RACE_PASSED ${labels.length}/${labels.length}; five races, zero upstream attempts`);
} finally {
  gate = undefined;
  delete globalThis.__qijiTransferRaceGate;
  await app.close();
  await new Promise(resolve => setTimeout(resolve, 25));
  await flushPendingSaves();
  closeSqlite();
}
