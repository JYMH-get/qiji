import assert from 'node:assert/strict';
import fs from 'node:fs';
if (!process.cwd().includes('qiji-refund-idempotency-')) throw Error('Sandbox only');
globalThis.fetch = async () => { throw Error('No external requests allowed'); };
const users = await import('../src/store/users.ts'), agents = await import('../src/store/agents.ts');
const logs = await import('../src/store/logs.ts'), credits = await import('../src/store/credits.ts');
const tasks = await import('../src/store/tasks.ts'), { db } = await import('../src/store/sqlite.ts');
const { flushPendingSaves } = await import('../src/store/db.ts');
const { reconcileOnStartup } = await import('../src/reconcile.ts');
const { settleExpiredRequest } = await import('../src/store/startupExpiry.ts');
const { default: Fastify } = await import('fastify'), app = Fastify();
await app.register((await import('../src/routes.ts')).registerRoutes); await app.ready();
let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const makeUser = () => users.createUser({ name: 'refund fixture', credits: 100 });
const makeAgent = () => agents.createAgent({ name: 'merchant fixture', account: 'refund-' + crypto.randomUUID().slice(0, 12), password: 'fixture-pass', credits: 100 }).agent;
const makeLog = (u, merchant, payer = u, wallet) => {
  const agentCosts = merchant ? [{ id: merchant.id, cost: 3 }] : [];
  const log = logs.startLog({ req: { purpose: 'image.generate', model: 'fixture', params: {} }, userId: u.id, cost: 10,
    payerId: payer.id, userWallet: wallet, agentCosts });
  const charged = credits.settle({ reason: 'generate', ref: log.id, payerId: payer.id, statsUserId: u.id, userAmount: 10, userWallet: wallet, agents: agentCosts });
  eq(charged.ok, true, 'fixture precharge');
  return { log, charged: charged.charged, request: { logId: log.id, payerId: payer.id, statsUserId: u.id, userAmount: 10, userWallet: wallet, agents: agentCosts } };
};
const mode = process.argv[2];
if (mode.startsWith('reuse-') && mode.endsWith('-prepare')) {
  const u = makeUser(), e = makeLog(u), task = tasks.createRunningTask('image', 'reuse-before-crash', e.log.id);
  tasks.setTaskBilling(task.taskId, u.id, 10);
  tasks.failTask(task.taskId, 'fixture failure');
  logs.finishLog(e.log.id, { status: 'failed', taskId: task.taskId });
  if (mode.includes('legacy')) db.prepare('UPDATE credit_ops SET op_id=?,ref=? WHERE op_id=?').run('co_legacy_reuse', task.taskId, 'refund:' + e.log.id);
  fs.writeFileSync('fixture.json', JSON.stringify({ userId: u.id, taskId: task.taskId }));
  eq(u.credits, 100);
  console.log(`PASS ${mode}: refund persisted without task sequence; hard exit`); process.exit(0);
}
if (mode.startsWith('reuse-') && mode.endsWith('-resume')) {
  const f = JSON.parse(fs.readFileSync('fixture.json')), u = users.getUser(f.userId), e = makeLog(u);
  const task = tasks.createRunningTask('image', 'reuse-after-crash', e.log.id);
  eq(task.taskId, f.taskId, 'crash rolled back debounced task sequence');
  tasks.setTaskBilling(task.taskId, u.id, 10);
  tasks.failTask(task.taskId, 'new request failure');
  eq(u.credits, 100, 'another request sharing task ID still receives its own refund');
  eq(credits.listCreditOps({ ref: e.log.id }).filter(o => o.reason === 'refund').length, 1, 'new refund uses new log identity');
}
if (mode === 'async-prepare') {
  const u = makeUser(), merchant = makeAgent(), e = makeLog(u, merchant);
  const task = tasks.createRunningTask('image', 'refund-crash', e.log.id);
  tasks.setTaskBilling(task.taskId, u.id, 10, e.request.agents);
  await flushPendingSaves();
  fs.writeFileSync('fixture.json', JSON.stringify({ userId: u.id, agentId: merchant.id, logId: e.log.id, taskId: task.taskId }));
  tasks.failTask(task.taskId, 'fixture failure');
  logs.finishLog(e.log.id, { status: 'failed', error: 'fixture failure', taskId: task.taskId });
  eq([u.credits, merchant.credits], [100, 100], 'first refund persisted');
  console.log('PASS async refund before task snapshot flush; hard exit'); process.exit(0);
}
if (mode === 'async-resume') {
  const f = JSON.parse(fs.readFileSync('fixture.json')), u = users.getUser(f.userId), merchant = agents.getAgent(f.agentId);
  eq(tasks.getTaskState(f.taskId).status, 'running', 'disk task is stale');
  await reconcileOnStartup({ info() {} });
  eq([u.credits, merchant.credits], [100, 100], 'restart never refunds twice on either side');
  eq(credits.listCreditOps({ ref: f.logId }).filter(o => o.reason === 'refund').length, 1, 'one durable refund');
  eq(tasks.getTaskState(f.taskId).status, 'failed', 'task finalized after restart');
}
if (mode === 'orphan-prepare') {
  const u = makeUser(), entries = [makeLog(u), makeLog(u)];
  fs.writeFileSync('fixture.json', JSON.stringify({ userId: u.id, logIds: entries.map(e => e.log.id) }));
  eq(u.credits, 80, 'two charged orphans');
}
if (mode === 'orphan-crash' || mode === 'orphan-resume') {
  const f = JSON.parse(fs.readFileSync('fixture.json')), u = users.getUser(f.userId);
  if (mode === 'orphan-crash') {
    const crashAfterRefund = () => {
      if (u.credits > 80) {
        eq(u.credits, 90, 'first refund reached disk');
        eq(f.logIds.map(id => logs.getLog(id).status), ['running', 'running'], 'bulk terminal patch not yet written');
        console.log('PASS orphan refund before bulk terminal write; hard exit'); process.exit(0);
      }
      setImmediate(crashAfterRefund);
    };
    setImmediate(crashAfterRefund);
  }
  await reconcileOnStartup({ info() {} });
  eq(u.credits, 100, 'orphan restart returns only original precharges');
  eq(f.logIds.map(id => credits.listCreditOps({ ref: id }).filter(o => o.reason === 'reconcile-refund').length), [1, 1], 'each orphan refunded once');
}
if (mode === 'edges') {
  // Existing random-ID refund rows must block retries through either request identity.
  for (const legacyRef of ['task', 'log']) {
    const u = makeUser(), e = makeLog(u), taskId = 'legacy-' + legacyRef;
    eq(credits.settle({ reason: 'refund', ref: legacyRef === 'task' ? taskId : e.log.id, payerId: u.id, statsUserId: u.id, userAmount: -10, agents: [] }).ok, true);
    eq(credits.refundRequest({ ...e.request, taskId }).status, 'already-refunded', 'old refund ref recognized');
    eq(u.credits, 100, 'legacy refund not repeated');
  }
  const expiredUser = makeUser(), expired = makeLog(expiredUser);
  eq(credits.settle({ reason: 'startup-expired-refund', idempotencyKey: 'expire:' + expired.log.id, ref: expired.log.id, payerId: expiredUser.id, statsUserId: expiredUser.id, userAmount: -10, agents: [] }).ok, true);
  eq(credits.refundRequest(expired.request).status, 'already-refunded', 'legacy expire key recognized');
  eq(expiredUser.credits, 100);
  const liveUser = makeUser(), live = makeLog(liveUser);
  eq(credits.refundRequest(live.request).status, 'refunded');
  assert.match(settleExpiredRequest({ logId: live.log.id, userId: liveUser.id, cost: 10 }), /已退款/); checks++;
  eq(liveUser.credits, 100, 'expiry after ordinary refund stays idempotent');
  // Pending/corrupt refund and text settlement rows are not success evidence.
  for (const [reason, status] of [['refund', 'pending'], ['refund', 'corrupt'], ['text-token-settle', 'pending'], ['text-token-settle', 'done']]) {
    const u = makeUser(), e = makeLog(u), op = reason === 'refund' ? 'legacy:' + e.log.id : 'text:' + e.log.id;
    db.prepare('INSERT INTO credit_ops(op_id,created_at,reason,ref,payer_id,stats_user_id,accounts,status) VALUES(?,?,?,?,?,?,?,?)').run(op, Date.now(), reason, e.log.id, u.id, u.id, '[]', status);
    const r = credits.refundRequest(e.request);
    if (status === 'done') eq(r.status, 'settled', 'settled text cannot refund'); else eq(r.ok, false, 'unresolved accounting rejects refund');
    eq(u.credits, 90, 'uncertain/settled entries do not change balance');
    if (status === 'pending' && reason === 'refund') {
      db.prepare('UPDATE credit_ops SET status=? WHERE op_id=?').run('aborted', op);
      eq(credits.refundRequest(e.request).status, 'refunded', 'aborted attempt can safely retry');
    }
  }
  const textUser = makeUser(), textEntry = makeLog(textUser);
  db.prepare('INSERT INTO text_billing(log_id,data) VALUES(?,?)').run(textEntry.log.id, JSON.stringify({ finalized: true }));
  eq(credits.refundRequest(textEntry.request).status, 'settled', 'zero-delta finalized text protected without a settlement op');
  eq(textUser.credits, 90);
  // Saved success is restored only within 48h; expired snapshots never refund or redeliver it.
  for (const old of [false, true]) {
    const u = makeUser(), e = makeLog(u), task = tasks.createRunningTask('image', 'saved-success', e.log.id);
    tasks.setTaskBilling(task.taskId, u.id, 10);
    if (old) task.submittedAt = Date.now() - 72 * 3600000;
    logs.finishLog(e.log.id, { status: 'success', response: { text: 'saved output' }, taskId: task.taskId });
    await reconcileOnStartup({ info() {} });
    eq(u.credits, 90, 'saved success never refunds');
    eq(tasks.getTaskState(task.taskId).status, old ? 'failed' : 'success', 'only unexpired success is restored');
    if (old) eq(tasks.getTaskState(task.taskId).result, undefined, 'expired success is never redelivered');
  }
  // The original allocated wallet closes on leave; its late refund belongs to its leader.
  const teams = await import('../src/store/teams.ts');
  const leader = makeUser(), member = makeUser(), merchant = makeAgent();
  const team = teams.createTeam({ leaderId: leader.id, name: 'refund team', code: teams.createTeamCodes(1)[0].code }).team;
  teams.inviteToTeam(team.id, member.id); teams.acceptInvite(team.id, member.id); teams.allocateTeamCredits(team.id, member.id, 40);
  const wallet = { teamId: team.id, ownerId: leader.id }, e = makeLog(member, merchant, member, wallet);
  teams.removeTeamMember(team.id, member.id);
  eq([leader.credits, member.credits, merchant.credits], [90, 100, 97]);
  eq(credits.refundRequest(e.request).status, 'refunded');
  eq([leader.credits, member.credits, merchant.credits], [100, 100, 100], 'late refund goes to original leader and merchant');
  eq(credits.refundRequest(e.request).status, 'already-refunded');
  // A rejected multi-account refund must not be recorded as refunded or partly paid.
  const missingUser = makeUser(), missing = makeLog(missingUser), failed = tasks.createRunningTask('image', 'missing-account', missing.log.id);
  tasks.setTaskBilling(failed.taskId, missingUser.id, 10, [{ id: 'missing-agent', cost: 3 }]);
  tasks.failTask(failed.taskId, 'fixture failure');
  eq(failed.billing.refunded, false, 'refund failure leaves flag false');
  eq(missingUser.credits, 90, 'failed refund changes no account');
  assert.match(failed.error, /账务待核对/); checks++;
}
await app.close(); await flushPendingSaves();
console.log(`PASS ${mode}: ${checks} checks`); process.exit(0);
